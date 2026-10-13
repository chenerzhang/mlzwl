import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type ServicePlatform = 'darwin' | 'linux' | 'win32';
export type ServiceAction =
  'install' | 'bootstrap' | 'start' | 'status' | 'stop' | 'restart' | 'enable' | 'disable' | 'recover' | 'uninstall';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface ManagedServiceOptions {
  platform?: ServicePlatform;
  profile: string;
  rootDir: string;
  nodePath: string;
  cliEntryPath: string;
  piBin?: string;
  envPath?: string;
  userHome?: string;
  userId?: number;
  definitionPath?: string;
  runner?: CommandRunner;
}

export interface ManagedServiceStatus {
  platform: ServicePlatform;
  profile: string;
  serviceId: string;
  definitionPath: string;
  installed: boolean;
  running: boolean;
  loaded?: boolean;
  registered?: boolean;
  enabled?: boolean;
  pid?: number;
}

interface OwnedDefinition {
  exists: boolean;
  content?: string;
  mode?: number;
}

const MANAGED_MARKER = 'Managed-By: @mlzwl/lark-pi-bridge';
const OUTPUT_LIMIT = 64 * 1024;

export class ManagedService {
  readonly platform: ServicePlatform;
  readonly profile: string;
  readonly rootDir: string;
  readonly serviceId: string;
  readonly definitionPath: string;
  private readonly runner: CommandRunner;
  private readonly input: Required<Pick<ManagedServiceOptions, 'nodePath' | 'cliEntryPath'>> & ManagedServiceOptions;

  constructor(options: ManagedServiceOptions) {
    this.platform = options.platform ?? nativeServicePlatform();
    this.profile = validateProfile(options.profile);
    this.rootDir = absoluteSafePath(options.rootDir, 'bridge home');
    this.input = {
      ...options,
      nodePath: absoluteSafePath(options.nodePath, 'Node path'),
      cliEntryPath: absoluteSafePath(options.cliEntryPath, 'CLI entry path'),
      ...(options.piBin ? { piBin: absoluteSafePath(options.piBin, 'Pi binary path') } : {}),
      rootDir: this.rootDir,
    };
    this.runner = options.runner ?? runCommand;
    this.serviceId = serviceId(this.platform, this.profile);
    this.definitionPath = options.definitionPath
      ? absoluteSafePath(options.definitionPath, 'service definition path')
      : defaultDefinitionPath(this.platform, this.profile, this.rootDir, options.userHome ?? homedir());
  }

  renderDefinition(options: { launchdOriginalDisabled?: boolean } = {}): string {
    if (!this.input.piBin) {
      throw new Error('an absolute Pi binary path is required to install a service');
    }
    const args = serviceProgramArguments(this.input, this.profile);
    const stdout = join(this.rootDir, 'profiles', this.profile, 'logs', 'service.stdout.log');
    const stderr = join(this.rootDir, 'profiles', this.profile, 'logs', 'service.stderr.log');
    if (this.platform === 'darwin') {
      return renderLaunchdDefinition({
        label: this.serviceId,
        programArguments: args,
        workingDirectory: this.rootDir,
        envPath: this.input.envPath ?? '',
        stdout,
        stderr,
        originalDisabled: options.launchdOriginalDisabled ?? false,
      });
    }
    if (this.platform === 'linux') {
      return renderSystemdDefinition({
        serviceId: this.serviceId,
        description: `lark-pi-bridge profile ${this.profile}`,
        programArguments: args,
        workingDirectory: this.rootDir,
        envPath: this.input.envPath ?? '',
        stdout,
        stderr,
      });
    }
    return renderWindowsLauncher({
      serviceId: this.serviceId,
      programArguments: args,
      envPath: this.input.envPath ?? '',
      stdout: windowsPath(stdout),
      stderr: windowsPath(stderr),
    });
  }

  async install(): Promise<ManagedServiceStatus> {
    const logsDir = join(this.rootDir, 'profiles', this.profile, 'logs');
    await ensurePrivateDirectory(logsDir);
    await Promise.all([
      ensurePrivateAppendFile(join(logsDir, 'service.stdout.log')),
      ensurePrivateAppendFile(join(logsDir, 'service.stderr.log')),
    ]);
    const previous = await snapshotOwnedDefinition(this.definitionPath, this.serviceId);
    if (this.platform === 'win32') {
      if (previous.exists) {
        await this.assertWindowsTaskOwned(true);
      } else {
        await this.assertNoExistingWindowsTask();
      }
    }
    const launchdOriginalDisabled =
      this.platform === 'darwin'
        ? previous.exists
          ? parseLaunchdOriginalDisabled(previous.content!)
          : await this.readLaunchdDisabled()
        : undefined;
    let windowsTaskMutationStarted = false;
    try {
      await writePrivateFile(this.definitionPath, this.renderDefinition({ launchdOriginalDisabled }));
      if (this.platform === 'linux') {
        await this.requireSuccess('systemctl', ['--user', 'daemon-reload']);
      }
      if (this.platform === 'win32') {
        windowsTaskMutationStarted = true;
        await this.installWindowsTask();
      }
      return await this.status();
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (this.platform === 'win32' && windowsTaskMutationStarted) {
        await this.runner('schtasks.exe', ['/Delete', '/F', '/TN', this.serviceId]).catch((rollbackError) =>
          rollbackErrors.push(rollbackError),
        );
      }
      await restoreDefinition(this.definitionPath, previous).catch((rollbackError) =>
        rollbackErrors.push(rollbackError),
      );
      if (this.platform === 'linux') {
        await this.runner('systemctl', ['--user', 'daemon-reload']).catch((rollbackError) =>
          rollbackErrors.push(rollbackError),
        );
      }
      if (this.platform === 'win32' && previous.exists && windowsTaskMutationStarted) {
        await this.installWindowsTask().catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      throwAfterRollback(error, rollbackErrors, 'service installation rollback failed');
    }
  }

  async bootstrap(): Promise<ManagedServiceStatus> {
    await this.requireOwnedDefinition();
    if (this.platform === 'darwin') {
      if (!(await this.status()).loaded) {
        await this.requireSuccess('launchctl', ['bootstrap', this.userDomain(), this.definitionPath]);
      }
    } else if (this.platform === 'linux') {
      await this.requireSuccess('systemctl', ['--user', 'daemon-reload']);
    } else {
      await this.assertWindowsTaskOwned(true);
      await this.installWindowsTask();
    }
    return this.status();
  }

  async start(): Promise<ManagedServiceStatus> {
    await this.requireInstalled();
    if (this.platform === 'darwin') {
      await this.requireSuccess('launchctl', ['enable', this.launchdTarget()]);
      if ((await this.status()).loaded) {
        await this.requireSuccess('launchctl', ['kickstart', '-k', this.launchdTarget()]);
      } else {
        await this.requireSuccess('launchctl', ['bootstrap', this.userDomain(), this.definitionPath]);
      }
    } else if (this.platform === 'linux') {
      await this.requireSuccess('systemctl', ['--user', 'enable', '--now', this.serviceId]);
    } else {
      await this.requireSuccess('schtasks.exe', ['/Change', '/TN', this.serviceId, '/Enable']);
      await this.requireSuccess('schtasks.exe', ['/Run', '/TN', this.serviceId]);
    }
    return this.status();
  }

  async status(): Promise<ManagedServiceStatus> {
    const installed = (await snapshotOwnedDefinition(this.definitionPath, this.serviceId)).exists;
    if (!installed) {
      return this.baseStatus(false, false);
    }
    if (this.platform === 'win32' && !(await this.assertWindowsTaskOwned(true))) {
      return this.baseStatus(true, false, false, undefined, undefined, false);
    }
    if (this.platform === 'darwin') {
      const result = await this.runner('launchctl', ['print', this.launchdTarget()]);
      const disabled = await this.runner('launchctl', ['print-disabled', this.userDomain()]);
      const pid = parseNumber(result.stdout, /\bpid\s*=\s*(\d+)/i);
      const loaded = result.code === 0;
      const running = loaded && (/\bstate\s*=\s*running\b/i.test(result.stdout) || pid !== undefined);
      const enabled = disabled.code === 0 ? !launchdDisabled(disabled.stdout, this.serviceId) : undefined;
      return this.baseStatus(true, running, enabled, pid, loaded);
    }
    if (this.platform === 'linux') {
      const show = await this.runner('systemctl', [
        '--user',
        'show',
        this.serviceId,
        '--property=ActiveState,UnitFileState,MainPID',
        '--no-pager',
      ]);
      if (show.code !== 0) {
        throw commandError('systemctl', ['--user', 'show', this.serviceId], show);
      }
      const active = /^ActiveState=active$/m.test(show.stdout);
      const enabled = /^UnitFileState=(?:enabled|enabled-runtime)$/m.test(show.stdout);
      return this.baseStatus(true, active, enabled, parseNumber(show.stdout, /^MainPID=(\d+)$/m));
    }
    const query = await this.runner('schtasks.exe', ['/Query', '/TN', this.serviceId, '/V', '/FO', 'LIST']);
    const running = query.code === 0 && /(?:Status|状态):\s*(?:Running|正在运行)/i.test(query.stdout);
    const enabled =
      query.code === 0 && !/(?:Scheduled Task State|计划任务状态):\s*(?:Disabled|已禁用)/i.test(query.stdout);
    if (query.code !== 0) {
      throw commandError('schtasks.exe', ['/Query', '/TN', this.serviceId], query);
    }
    return this.baseStatus(true, running, enabled, parseNumber(query.stdout, /Process ID:\s*(\d+)/i), undefined, true);
  }

  async stop(): Promise<ManagedServiceStatus> {
    if (!(await this.status()).installed) {
      return this.baseStatus(false, false);
    }
    if (this.platform === 'darwin') {
      if ((await this.status()).loaded) {
        await this.requireSuccess('launchctl', ['bootout', this.launchdTarget()]);
        await this.waitForLaunchdUnloaded();
      }
    } else if (this.platform === 'linux') {
      await this.requireSuccess('systemctl', ['--user', 'stop', this.serviceId]);
    } else if ((await this.status()).running) {
      await this.requireSuccess('schtasks.exe', ['/End', '/TN', this.serviceId]);
      await this.waitForWindowsStopped();
    }
    return this.status();
  }

  async restart(): Promise<ManagedServiceStatus> {
    await this.requireInstalled();
    if (this.platform === 'darwin') {
      if ((await this.status()).loaded) {
        await this.requireSuccess('launchctl', ['kickstart', '-k', this.launchdTarget()]);
      } else {
        return this.start();
      }
    } else if (this.platform === 'linux') {
      await this.requireSuccess('systemctl', ['--user', 'restart', this.serviceId]);
    } else {
      if ((await this.status()).running) {
        await this.requireSuccess('schtasks.exe', ['/End', '/TN', this.serviceId]);
        await this.waitForWindowsStopped();
      }
      await this.requireSuccess('schtasks.exe', ['/Run', '/TN', this.serviceId]);
    }
    return this.status();
  }

  async enable(): Promise<ManagedServiceStatus> {
    await this.requireInstalled();
    if (this.platform === 'darwin') {
      await this.requireSuccess('launchctl', ['enable', this.launchdTarget()]);
    } else if (this.platform === 'linux') {
      await this.requireSuccess('systemctl', ['--user', 'enable', this.serviceId]);
    } else {
      await this.requireSuccess('schtasks.exe', ['/Change', '/TN', this.serviceId, '/Enable']);
    }
    return this.status();
  }

  async disable(): Promise<ManagedServiceStatus> {
    await this.requireInstalled();
    if (this.platform === 'darwin') {
      if ((await this.status()).loaded) {
        await this.requireSuccess('launchctl', ['bootout', this.launchdTarget()]);
        await this.waitForLaunchdUnloaded();
      }
      await this.requireSuccess('launchctl', ['disable', this.launchdTarget()]);
    } else if (this.platform === 'linux') {
      await this.requireSuccess('systemctl', ['--user', 'disable', '--now', this.serviceId]);
    } else {
      if ((await this.status()).running) {
        await this.requireSuccess('schtasks.exe', ['/End', '/TN', this.serviceId]);
        await this.waitForWindowsStopped();
      }
      await this.requireSuccess('schtasks.exe', ['/Change', '/TN', this.serviceId, '/Disable']);
    }
    const status = await this.status();
    return { ...status, enabled: false };
  }

  /** Restore enabled/running dimensions independently after an updater transaction. */
  async restoreState(target: Pick<ManagedServiceStatus, 'enabled' | 'running'>): Promise<ManagedServiceStatus> {
    await this.requireInstalled();
    if (target.enabled === false && target.running) {
      if (this.platform === 'darwin') {
        await this.requireSuccess('launchctl', ['enable', this.launchdTarget()]);
        if ((await this.status()).loaded) {
          await this.requireSuccess('launchctl', ['kickstart', '-k', this.launchdTarget()]);
        } else {
          await this.requireSuccess('launchctl', ['bootstrap', this.userDomain(), this.definitionPath]);
        }
        await this.requireSuccess('launchctl', ['disable', this.launchdTarget()]);
      } else if (this.platform === 'linux') {
        await this.requireSuccess('systemctl', ['--user', 'disable', this.serviceId]);
        await this.requireSuccess('systemctl', ['--user', 'start', this.serviceId]);
      } else {
        await this.requireSuccess('schtasks.exe', ['/Change', '/TN', this.serviceId, '/Enable']);
        await this.requireSuccess('schtasks.exe', ['/Run', '/TN', this.serviceId]);
        await this.requireSuccess('schtasks.exe', ['/Change', '/TN', this.serviceId, '/Disable']);
      }
      return this.status();
    }
    if (target.running) {
      await this.start();
    } else {
      await this.stop();
    }
    if (target.enabled === false) {
      await this.disable();
    } else if (target.enabled === true) {
      await this.enable();
    }
    return this.status();
  }

  async recover(): Promise<ManagedServiceStatus> {
    await this.requireOwnedDefinition();
    if (this.platform === 'darwin') {
      if ((await this.status()).loaded) {
        await this.requireSuccess('launchctl', ['bootout', this.launchdTarget()]);
        await this.waitForLaunchdUnloaded();
      }
      await this.requireSuccess('launchctl', ['enable', this.launchdTarget()]);
      await this.requireSuccess('launchctl', ['bootstrap', this.userDomain(), this.definitionPath]);
    } else if (this.platform === 'linux') {
      await this.requireSuccess('systemctl', ['--user', 'daemon-reload']);
      await this.requireSuccess('systemctl', ['--user', 'reset-failed', this.serviceId]);
      await this.requireSuccess('systemctl', ['--user', 'enable', '--now', this.serviceId]);
    } else {
      await this.assertWindowsTaskOwned(true);
      await this.installWindowsTask();
      await this.requireSuccess('schtasks.exe', ['/Run', '/TN', this.serviceId]);
    }
    return this.status();
  }

  async uninstall(): Promise<ManagedServiceStatus> {
    const previous = await snapshotOwnedDefinition(this.definitionPath, this.serviceId);
    if (!previous.exists) {
      return this.baseStatus(false, false);
    }
    const previousStatus = await this.status();
    if (this.platform === 'darwin') {
      try {
        if (previousStatus.loaded) {
          await this.requireSuccess('launchctl', ['bootout', this.launchdTarget()]);
          await this.waitForLaunchdUnloaded();
        }
        const restoreAction = parseLaunchdOriginalDisabled(previous.content!) ? 'disable' : 'enable';
        await this.requireSuccess('launchctl', [restoreAction, this.launchdTarget()]);
        await rm(this.definitionPath, { force: true });
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        await restoreDefinition(this.definitionPath, previous).catch((rollbackError) =>
          rollbackErrors.push(rollbackError),
        );
        if (previousStatus.enabled !== undefined) {
          await this.runner('launchctl', [previousStatus.enabled ? 'enable' : 'disable', this.launchdTarget()]).catch(
            (rollbackError) => rollbackErrors.push(rollbackError),
          );
        }
        if (previousStatus.loaded) {
          await this.runner('launchctl', ['bootstrap', this.userDomain(), this.definitionPath]).catch((rollbackError) =>
            rollbackErrors.push(rollbackError),
          );
        }
        throwAfterRollback(error, rollbackErrors, 'launchd uninstall rollback failed');
      }
    } else if (this.platform === 'linux') {
      try {
        await this.requireSuccess('systemctl', ['--user', 'disable', '--now', this.serviceId]);
        await rm(this.definitionPath, { force: true });
        await this.requireSuccess('systemctl', ['--user', 'daemon-reload']);
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        await restoreDefinition(this.definitionPath, previous).catch((rollbackError) =>
          rollbackErrors.push(rollbackError),
        );
        await this.runner('systemctl', ['--user', 'daemon-reload']).catch((rollbackError) =>
          rollbackErrors.push(rollbackError),
        );
        await this.restoreSystemdState(previousStatus).catch((rollbackError) => rollbackErrors.push(rollbackError));
        throwAfterRollback(error, rollbackErrors, 'systemd uninstall rollback failed');
      }
    } else {
      const ownedTaskExists = previousStatus.registered === true;
      const args = ['/Delete', '/F', '/TN', this.serviceId];
      const result = ownedTaskExists ? await this.runner('schtasks.exe', args) : { code: 0, stdout: '', stderr: '' };
      if (result.code !== 0) {
        throw commandError('schtasks.exe', args, result);
      }
      try {
        await rm(this.definitionPath, { force: true });
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (ownedTaskExists) {
          await this.installWindowsTask().catch((rollbackError) => rollbackErrors.push(rollbackError));
          await this.restoreWindowsState(previousStatus).catch((rollbackError) => rollbackErrors.push(rollbackError));
        }
        throwAfterRollback(error, rollbackErrors, 'Windows service uninstall rollback failed');
      }
    }
    return this.baseStatus(false, false);
  }

  private async assertNoExistingWindowsTask(): Promise<void> {
    const args = ['/Query', '/TN', this.serviceId];
    const result = await this.runner('schtasks.exe', args);
    if (result.code === 0) {
      throw new Error(`refusing to overwrite an unowned scheduled task: ${this.serviceId}`);
    }
    if (!isMissingWindowsTask(result)) {
      throw commandError('schtasks.exe', args, result);
    }
  }

  private async assertWindowsTaskOwned(allowMissing: boolean): Promise<boolean> {
    const args = ['/Query', '/TN', this.serviceId, '/XML'];
    const result = await this.runner('schtasks.exe', args);
    if (result.code !== 0) {
      if (allowMissing && isMissingWindowsTask(result)) {
        return false;
      }
      throw commandError('schtasks.exe', args, result);
    }
    const xml = decodeXml(result.stdout).toLowerCase();
    const launcher = windowsPath(this.definitionPath).toLowerCase();
    if (!xml.includes('powershell.exe') || !xml.includes(launcher)) {
      throw new Error(`refusing to operate on an unowned scheduled task: ${this.serviceId}`);
    }
    return true;
  }

  private async installWindowsTask(): Promise<void> {
    await this.requireSuccess('schtasks.exe', [
      '/Create',
      '/F',
      '/SC',
      'ONLOGON',
      '/RL',
      'LIMITED',
      '/TN',
      this.serviceId,
      '/TR',
      windowsTaskCommand(this.definitionPath),
    ]);
  }

  private async requireOwnedDefinition(): Promise<void> {
    if (!(await snapshotOwnedDefinition(this.definitionPath, this.serviceId)).exists) {
      throw new Error(`service definition is not installed: ${this.definitionPath}`);
    }
  }

  private async requireInstalled(): Promise<void> {
    await this.requireOwnedDefinition();
    if (this.platform === 'win32') {
      await this.assertWindowsTaskOwned(false);
    }
  }

  private async waitForLaunchdUnloaded(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await this.status()).loaded) {
        return;
      }
      await delay(100);
    }
    throw new Error(`launchd job did not unload after bootout: ${this.serviceId}`);
  }

  private async waitForWindowsStopped(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!(await this.status()).running) {
        return;
      }
      await delay(100);
    }
    throw new Error(`scheduled task did not stop after End: ${this.serviceId}`);
  }

  private async restoreSystemdState(status: ManagedServiceStatus): Promise<void> {
    if (status.enabled && status.running) {
      await this.requireSuccess('systemctl', ['--user', 'enable', '--now', this.serviceId]);
    } else if (status.enabled) {
      await this.requireSuccess('systemctl', ['--user', 'enable', this.serviceId]);
    } else if (status.running) {
      await this.requireSuccess('systemctl', ['--user', 'start', this.serviceId]);
    }
  }

  private async restoreWindowsState(status: ManagedServiceStatus): Promise<void> {
    if (status.enabled === false) {
      await this.requireSuccess('schtasks.exe', ['/Change', '/TN', this.serviceId, '/Disable']);
    }
    if (status.running) {
      await this.requireSuccess('schtasks.exe', ['/Run', '/TN', this.serviceId]);
    }
  }

  private async requireSuccess(command: string, args: string[]): Promise<CommandResult> {
    const result = await this.runner(command, args);
    if (result.code !== 0) {
      throw commandError(command, args, result);
    }
    return result;
  }

  private baseStatus(
    installed: boolean,
    running: boolean,
    enabled?: boolean,
    pid?: number,
    loaded?: boolean,
    registered?: boolean,
  ): ManagedServiceStatus {
    return {
      platform: this.platform,
      profile: this.profile,
      serviceId: this.serviceId,
      definitionPath: this.definitionPath,
      installed,
      running,
      ...(loaded === undefined ? {} : { loaded }),
      ...(registered === undefined ? {} : { registered }),
      ...(enabled === undefined ? {} : { enabled }),
      ...(pid && pid > 0 ? { pid } : {}),
    };
  }

  private userDomain(): string {
    const uid = this.input.userId ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
    if (uid === undefined) {
      throw new Error('cannot determine launchd user id');
    }
    return `gui/${uid}`;
  }

  private launchdTarget(): string {
    return `${this.userDomain()}/${this.serviceId}`;
  }

  private async readLaunchdDisabled(): Promise<boolean> {
    const args = ['print-disabled', this.userDomain()];
    const result = await this.runner('launchctl', args);
    if (result.code !== 0) {
      throw commandError('launchctl', args, result);
    }
    return launchdDisabled(result.stdout, this.serviceId);
  }
}

export function renderLaunchdDefinition(input: {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  envPath: string;
  stdout: string;
  stderr: string;
  originalDisabled?: boolean;
}): string {
  assertSafeValues([
    input.label,
    input.workingDirectory,
    input.envPath,
    input.stdout,
    input.stderr,
    ...input.programArguments,
  ]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${MANAGED_MARKER}; Service-Id: ${xml(input.label)}; Original-Disabled: ${input.originalDisabled === true} -->
<plist version="1.0"><dict>
<key>Label</key><string>${xml(input.label)}</string>
<key>ProgramArguments</key><array>${input.programArguments.map((value) => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(input.workingDirectory)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(input.envPath)}</string></dict>
<key>StandardOutPath</key><string>${xml(input.stdout)}</string>
<key>StandardErrorPath</key><string>${xml(input.stderr)}</string>
</dict></plist>\n`;
}

export function renderSystemdDefinition(input: {
  serviceId: string;
  description: string;
  programArguments: string[];
  workingDirectory: string;
  envPath: string;
  stdout: string;
  stderr: string;
}): string {
  assertSafeValues([
    input.serviceId,
    input.description,
    input.workingDirectory,
    input.envPath,
    input.stdout,
    input.stderr,
    ...input.programArguments,
  ]);
  return `# ${MANAGED_MARKER}; Service-Id: ${systemdValue(input.serviceId)}\n[Unit]\nDescription=${systemdValue(input.description)}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${input.programArguments.map(systemdArg).join(' ')}\nWorkingDirectory=${systemdArg(input.workingDirectory)}\nEnvironment=${systemdArg(`PATH=${input.envPath}`)}\nRestart=on-failure\nRestartSec=5\nStandardOutput=append:${systemdPath(input.stdout)}\nStandardError=append:${systemdPath(input.stderr)}\n\n[Install]\nWantedBy=default.target\n`;
}

export function renderWindowsLauncher(input: {
  serviceId: string;
  programArguments: string[];
  envPath: string;
  stdout: string;
  stderr: string;
}): string {
  assertSafeValues([input.serviceId, input.envPath, input.stdout, input.stderr, ...input.programArguments]);
  const command = `& ${input.programArguments.map(powerShellLiteral).join(' ')}`;
  return `# ${MANAGED_MARKER}; Service-Id: ${input.serviceId.replace(/[\r\n]/g, '')}\n$ErrorActionPreference = 'Stop'\n$env:PATH = ${powerShellLiteral(input.envPath)}\n${command} 1>> ${powerShellLiteral(input.stdout)} 2>> ${powerShellLiteral(input.stderr)}\nexit $LASTEXITCODE\n`;
}

export async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const stdout = new BoundedOutput(OUTPUT_LIMIT);
    const stderr = new BoundedOutput(OUTPUT_LIMIT);
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.append(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout: stdout.text(), stderr: stderr.text() });
    });
  });
}

function nativeServicePlatform(): ServicePlatform {
  if (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') {
    return process.platform;
  }
  throw new Error(`unsupported service platform: ${process.platform}`);
}

function serviceId(platform: ServicePlatform, profile: string): string {
  return platform === 'darwin'
    ? `ai.x-connect.lark-pi-bridge.${profile}`
    : platform === 'linux'
      ? `lark-pi-bridge-${profile}.service`
      : `\\x-connect\\lark-pi-bridge-${profile}`;
}

function defaultDefinitionPath(platform: ServicePlatform, profile: string, rootDir: string, userHome: string): string {
  if (platform === 'darwin') {
    return join(userHome, 'Library', 'LaunchAgents', `ai.x-connect.lark-pi-bridge.${profile}.plist`);
  }
  if (platform === 'linux') {
    return join(userHome, '.config', 'systemd', 'user', `lark-pi-bridge-${profile}.service`);
  }
  return join(rootDir, 'profiles', profile, 'runtime', 'lark-pi-bridge-service.ps1');
}

function serviceProgramArguments(input: ManagedServiceOptions, profile: string): string[] {
  return [
    input.nodePath,
    input.cliEntryPath,
    '--home',
    input.rootDir,
    'run',
    '--profile',
    profile,
    ...(input.piBin ? ['--pi-bin', input.piBin] : []),
  ];
}

async function snapshotOwnedDefinition(path: string, serviceIdValue: string): Promise<OwnedDefinition> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`service definition must be a regular file: ${path}`);
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
        throw new Error(`service definition changed while opening: ${path}`);
      }
      const content = await handle.readFile('utf8');
      if (!definitionMatchesService(content, serviceIdValue)) {
        throw new Error(`refusing to overwrite or remove an unowned service definition: ${path}`);
      }
      return { exists: true, content, mode: opened.mode & 0o777 };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
}

function definitionMatchesService(content: string, value: string): boolean {
  const expected = escapeRegExp(`${MANAGED_MARKER}; Service-Id: ${value}`);
  return content
    .split('\n', 5)
    .map((line) => line.trim())
    .some(
      (line) =>
        new RegExp(`^# ${expected}$`).test(line) ||
        new RegExp(`^<!-- ${expected}; Original-Disabled: (?:true|false) -->$`).test(line),
    );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`${path} must be a directory`);
  }
  if (process.platform === 'win32') {
    return;
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${path} changed while opening`);
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

async function ensurePrivateAppendFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (before && (!before.isFile() || before.isSymbolicLink())) {
      throw new Error(`${path} must be a regular file`);
    }
    try {
      const flags = before
        ? constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
        : constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(path, flags, 0o600);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || (before !== undefined && (opened.dev !== before.dev || opened.ino !== before.ino))) {
          throw new Error(`${path} changed while opening`);
        }
        if (process.platform !== 'win32') {
          await handle.chmod(0o600);
        }
        return;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!before && attempt === 0 && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`${path} changed while opening`);
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    if (process.platform !== 'win32') {
      await chmod(path, 0o600);
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function restoreDefinition(path: string, snapshot: OwnedDefinition): Promise<void> {
  if (!snapshot.exists) {
    await rm(path, { force: true });
    return;
  }
  await writePrivateFile(path, snapshot.content!);
  if (process.platform !== 'win32') {
    await chmod(path, snapshot.mode ?? 0o600);
  }
}

function throwAfterRollback(error: unknown, rollbackErrors: unknown[], message: string): never {
  if (rollbackErrors.length === 0) {
    throw error;
  }
  throw new AggregateError([error, ...rollbackErrors], message, { cause: error });
}

function commandError(command: string, args: string[], result: CommandResult): Error {
  const detail = `${result.stderr}\n${result.stdout}`
    .trim()
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
  return new Error(`${command} ${args.join(' ')} failed with code ${result.code}${detail ? `: ${detail}` : ''}`);
}

function validateProfile(value: string): string {
  const profile = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error(`invalid service profile: ${value}`);
  }
  return profile;
}

function absoluteSafePath(value: string, label: string): string {
  assertSafeValues([value]);
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return resolve(value);
}

function assertSafeValues(values: string[]): void {
  if (values.some((value) => !value || /[\0\r\n]/.test(value))) {
    throw new Error('service value contains an unsafe control character');
  }
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdValue(value: string): string {
  return value.replace(/[%\r\n]/g, (character) => (character === '%' ? '%%' : ' '));
}

function systemdArg(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function systemdPath(value: string): string {
  return value.replace(/%/g, '%%').replace(/\s/g, '\\x20');
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function windowsTaskCommand(path: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${windowsPath(path).replace(/"/g, '\\"')}"`;
}

function isMissingWindowsTask(result: CommandResult): boolean {
  return /cannot find|找不到|does not exist|not exist/i.test(`${result.stdout}\n${result.stderr}`);
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function windowsPath(value: string): string {
  return /^[A-Za-z]:[\\/]/.test(value) ? win32.normalize(value) : value;
}

function parseNumber(value: string, pattern: RegExp): number | undefined {
  const parsed = Number(pattern.exec(value)?.[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function launchdDisabled(output: string, label: string): boolean {
  const escaped = escapeRegExp(label);
  return new RegExp(`["']?${escaped}["']?\\s*=>\\s*(?:true|disabled)\\b`, 'i').test(output);
}

function parseLaunchdOriginalDisabled(content: string): boolean {
  const match = /Original-Disabled: (true|false) -->/.exec(content);
  if (!match) {
    throw new Error('owned launchd definition is missing its original disabled-state marker');
  }
  return match[1] === 'true';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class BoundedOutput {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  append(chunk: Buffer): void {
    if (this.size >= this.max) {
      return;
    }
    const kept = chunk.subarray(0, this.max - this.size);
    this.chunks.push(kept);
    this.size += kept.length;
  }
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
