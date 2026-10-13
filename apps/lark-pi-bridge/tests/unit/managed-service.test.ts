import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ManagedService,
  type CommandResult,
  type CommandRunner,
  type ServicePlatform,
} from '../../src/daemon/managed-service.js';
import { parseOwnedDefinition } from '../../src/update/service-discovery.js';

describe('managed platform services', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

  it.each(['darwin', 'linux', 'win32'] as ServicePlatform[])(
    'renders %s definitions without secrets and uses only injected structured commands',
    async (platform) => {
      const root = await mkdtemp(join(tmpdir(), `lark-pi-service-${platform}-`));
      roots.push(root);
      const calls: string[][] = [];
      const state: { manager?: ManagedService } = {};
      const runner: CommandRunner = async (command, args) => {
        calls.push([command, ...args]);
        if (platform === 'win32' && command === 'schtasks.exe' && args.includes('/XML')) {
          return ownedWindowsTask(state.manager!.definitionPath);
        }
        return serviceResult(platform, command, args);
      };
      const manager = fixtureManager(platform, root, runner);
      state.manager = manager;
      const definition = manager.renderDefinition();
      expect(definition).toContain('Managed-By: @mlzwl/lark-pi-bridge');
      expect(definition).toContain('Service-Id:');
      expect(definition).toContain('--home');
      expect(definition).toContain('phase7');
      expect(definition).not.toMatch(/app[_-]?secret|authorization|bearer|api[_-]?key|registration.*https?:\/\//i);
      await manager.install();
      await manager.bootstrap();
      await manager.start();
      await manager.restart();
      await manager.disable();
      await manager.enable();
      await manager.recover();
      await manager.stop();
      await manager.uninstall();
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.flat()).not.toContain('sh');
      expect(calls.flat()).not.toContain('bash');
      expect(calls.flat()).not.toContain('cmd.exe');
      expect(await readFile(manager.definitionPath, 'utf8').catch(() => 'missing')).toBe('missing');
    },
  );

  it.each(['darwin', 'linux', 'win32'] as ServicePlatform[])(
    'round-trips deterministic %s owned service definitions for updater discovery',
    (platform) => {
      const root = join(tmpdir(), `lark pi service ${platform}`);
      const manager = fixtureManager(platform, root, async () => ok());
      expect(parseOwnedDefinition(platform, manager.definitionPath, manager.renderDefinition())).toMatchObject({
        platform,
        profile: 'phase7',
        rootDir: root,
        piBin: '/opt/pi/bin/pi',
      });
    },
  );

  it('pre-creates private append-only service logs without truncating existing output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-private-logs-'));
    roots.push(root);
    const logsDir = join(root, 'profiles', 'phase7', 'logs');
    const stdout = join(logsDir, 'service.stdout.log');
    await mkdir(logsDir, { recursive: true });
    await writeFile(stdout, 'existing output\n', { mode: 0o644 });
    await chmod(logsDir, 0o755);
    await chmod(stdout, 0o644);
    const manager = fixtureManager('darwin', root, async (command, args) => serviceResult('darwin', command, args));
    await manager.install();
    expect((await stat(logsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(stdout)).mode & 0o777).toBe(0o600);
    expect((await stat(join(logsDir, 'service.stderr.log'))).mode & 0o777).toBe(0o600);
    expect(await readFile(stdout, 'utf8')).toBe('existing output\n');
  });

  it('rejects a symlinked service log directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-symlinked-logs-'));
    roots.push(root);
    const target = join(root, 'outside');
    const profileDir = join(root, 'profiles', 'phase7');
    await mkdir(target, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await symlink(target, join(profileDir, 'logs'));
    const manager = fixtureManager('darwin', root, async (command, args) => serviceResult('darwin', command, args));
    await expect(manager.install()).rejects.toThrow(/must be a directory/);
    await expect(readFile(join(target, 'service.stdout.log'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for launchd to finish asynchronous bootout before reporting stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-launchd-stop-'));
    roots.push(root);
    let bootoutRequested = false;
    let postBootoutPrints = 0;
    const manager = fixtureManager('darwin', root, async (command, args) => {
      if (command === 'launchctl' && args[0] === 'print') {
        if (bootoutRequested && ++postBootoutPrints >= 3) {
          return { code: 1, stdout: '', stderr: 'not loaded' };
        }
        return { code: 0, stdout: 'state = running\npid = 42\n', stderr: '' };
      }
      if (command === 'launchctl' && args[0] === 'bootout') {
        bootoutRequested = true;
      }
      return ok();
    });
    await manager.install();
    expect(await manager.stop()).toMatchObject({ installed: true, loaded: false, running: false });
    expect(postBootoutPrints).toBe(4);
  });

  it.each(['true', 'disabled'])(
    'distinguishes a loaded idle launchd job from a running one and parses %s overrides',
    async (disabledValue) => {
      const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-launchd-state-'));
      roots.push(root);
      const manager = fixtureManager('darwin', root, async (command, args) => {
        if (command === 'launchctl' && args[0] === 'print') {
          return { code: 0, stdout: 'state = exited\nlast exit code = 1\n', stderr: '' };
        }
        if (command === 'launchctl' && args[0] === 'print-disabled') {
          return {
            code: 0,
            stdout: `disabled services = { "ai.x-connect.lark-pi-bridge.phase7" => ${disabledValue} }\n`,
            stderr: '',
          };
        }
        return ok();
      });
      await manager.install();
      expect(await manager.status()).toMatchObject({ installed: true, loaded: true, running: false, enabled: false });
    },
  );

  it('restores disabled-but-running state without conflating enabled and running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-disabled-running-'));
    roots.push(root);
    const calls: string[][] = [];
    const manager = fixtureManager('linux', root, async (command, args) => {
      calls.push([command, ...args]);
      return serviceResult('linux', command, args);
    });
    await manager.install();
    await manager.restoreState({ enabled: false, running: true });
    expect(calls).toContainEqual(['systemctl', '--user', 'disable', 'lark-pi-bridge-phase7.service']);
    expect(calls).toContainEqual(['systemctl', '--user', 'start', 'lark-pi-bridge-phase7.service']);
    expect(calls).not.toContainEqual(['systemctl', '--user', 'disable', '--now', 'lark-pi-bridge-phase7.service']);
  });

  it('requires an explicit absolute Pi binary before installing a persistent service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-pi-path-'));
    roots.push(root);
    const manager = new ManagedService({
      platform: 'linux',
      profile: 'phase7',
      rootDir: root,
      nodePath: '/opt/node/bin/node',
      cliEntryPath: '/opt/lark-pi-bridge/dist/cli.js',
      definitionPath: join(root, 'unit.service'),
      runner: async () => ok(),
    });
    await expect(manager.install()).rejects.toThrow(/absolute Pi binary path/);
  });

  it('restores the original launchd disabled override during uninstall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-launchd-restore-'));
    roots.push(root);
    const calls: string[][] = [];
    const manager = fixtureManager('darwin', root, async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'launchctl' && args[0] === 'print-disabled') {
        return {
          code: 0,
          stdout: 'disabled services = { "ai.x-connect.lark-pi-bridge.phase7" => true }\n',
          stderr: '',
        };
      }
      if (command === 'launchctl' && args[0] === 'print') {
        return { code: 1, stdout: '', stderr: 'not loaded' };
      }
      return ok();
    });
    await manager.install();
    expect(await readFile(manager.definitionPath, 'utf8')).toContain('Original-Disabled: true');
    await manager.uninstall();
    expect(calls).toContainEqual(['launchctl', 'disable', 'gui/501/ai.x-connect.lark-pi-bridge.phase7']);
  });

  it('refuses to overwrite an existing Windows task without an owned launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-win-owner-'));
    roots.push(root);
    const manager = fixtureManager('win32', root, async () => ok());
    await expect(manager.install()).rejects.toThrow(/unowned scheduled task/);
    await expect(readFile(manager.definitionPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to delete a Windows task that no longer targets the owned launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-win-replaced-'));
    roots.push(root);
    let replaced = false;
    const state: { manager?: ManagedService } = {};
    const manager = fixtureManager('win32', root, async (command, args) => {
      if (command === 'schtasks.exe' && args[0] === '/Query' && args.includes('/XML')) {
        return replaced
          ? { code: 0, stdout: '<Task><Command>C:\\Other\\unowned.exe</Command></Task>', stderr: '' }
          : ownedWindowsTask(state.manager!.definitionPath);
      }
      return serviceResult('win32', command, args);
    });
    state.manager = manager;
    await manager.install();
    replaced = true;
    await expect(manager.uninstall()).rejects.toThrow(/unowned scheduled task/);
    expect(await readFile(manager.definitionPath, 'utf8')).toContain('Managed-By');
  });

  it('refuses an unowned existing definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-unowned-'));
    roots.push(root);
    const path = join(root, 'unknown.plist');
    await writeFile(path, 'not owned');
    const manager = fixtureManager('darwin', root, async () => ok(), path);
    await expect(manager.install()).rejects.toThrow(/unowned/);
    await expect(manager.uninstall()).rejects.toThrow(/unowned/);
    expect(await readFile(path, 'utf8')).toBe('not owned');
  });

  it('rolls back a new systemd definition when daemon-reload fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-rollback-'));
    roots.push(root);
    const path = join(root, 'unit.service');
    const manager = fixtureManager(
      'linux',
      root,
      async (command, args) =>
        command === 'systemctl' && args.includes('daemon-reload') ? { code: 1, stdout: '', stderr: 'synthetic' } : ok(),
      path,
    );
    await expect(manager.install()).rejects.toThrow(/synthetic/);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back a new systemd definition when the final status query fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-status-rollback-'));
    roots.push(root);
    const path = join(root, 'unit.service');
    const manager = fixtureManager(
      'linux',
      root,
      async (command, args) =>
        command === 'systemctl' && args.includes('show')
          ? { code: 1, stdout: '', stderr: 'synthetic status failure' }
          : ok(),
      path,
    );
    await expect(manager.install()).rejects.toThrow(/synthetic status failure/);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('repairs a missing Windows task only from an owned launcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-win-repair-'));
    roots.push(root);
    let taskExists = false;
    const state: { manager?: ManagedService } = {};
    const runner: CommandRunner = async (command, args) => {
      if (command !== 'schtasks.exe') {
        return ok();
      }
      if (args[0] === '/Create') {
        taskExists = true;
        return ok();
      }
      if (args[0] === '/Query' && args.includes('/XML')) {
        return taskExists
          ? ownedWindowsTask(state.manager!.definitionPath)
          : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      }
      if (args[0] === '/Query' && args.includes('/V')) {
        return { code: 0, stdout: 'Status: Ready\nScheduled Task State: Enabled\n', stderr: '' };
      }
      return ok();
    };
    const manager = fixtureManager('win32', root, runner);
    state.manager = manager;
    await mkdir(join(root, 'profiles', 'phase7', 'runtime'), { recursive: true });
    await writeFile(manager.definitionPath, manager.renderDefinition());
    expect(await manager.status()).toMatchObject({ installed: true, registered: false, running: false });
    expect(await manager.recover()).toMatchObject({ installed: true, registered: true, running: false });
    expect(taskExists).toBe(true);
  });

  it('keeps an owned systemd definition if disable fails during uninstall', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-disable-'));
    roots.push(root);
    const path = join(root, 'unit.service');
    const manager = fixtureManager(
      'linux',
      root,
      async (command, args) => {
        if (command === 'systemctl' && args.includes('disable')) {
          return { code: 1, stdout: '', stderr: 'synthetic disable failure' };
        }
        return serviceResult('linux', command, args);
      },
      path,
    );
    await manager.install();
    const before = await readFile(path, 'utf8');
    await expect(manager.uninstall()).rejects.toThrow(/synthetic disable failure/);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('restores an owned systemd definition and its active state if uninstall reload fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-uninstall-'));
    roots.push(root);
    const path = join(root, 'unit.service');
    let reloads = 0;
    const calls: string[][] = [];
    const manager = fixtureManager(
      'linux',
      root,
      async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'systemctl' && args.includes('daemon-reload') && ++reloads === 2) {
          return { code: 1, stdout: '', stderr: 'synthetic uninstall failure' };
        }
        if (command === 'systemctl' && args.includes('show')) {
          return { code: 0, stdout: 'ActiveState=active\nUnitFileState=enabled\nMainPID=42\n', stderr: '' };
        }
        return ok();
      },
      path,
    );
    await manager.install();
    const before = await readFile(path, 'utf8');
    await expect(manager.uninstall()).rejects.toThrow(/synthetic uninstall failure/);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'lark-pi-bridge-phase7.service']);
  });
});

function fixtureManager(platform: ServicePlatform, root: string, runner: CommandRunner, definitionPath?: string) {
  return new ManagedService({
    platform,
    profile: 'phase7',
    rootDir: root,
    nodePath: '/opt/node/bin/node',
    cliEntryPath: '/opt/lark-pi-bridge/dist/cli.js',
    piBin: '/opt/pi/bin/pi',
    envPath: '/opt/node/bin:/usr/bin:/bin',
    userHome: root,
    userId: 501,
    definitionPath,
    runner,
  });
}

function serviceResult(
  platform: ServicePlatform,
  command: string,
  args: string[],
): Promise<CommandResult> | CommandResult {
  if (platform === 'darwin' && command === 'launchctl' && args[0] === 'print') {
    return { code: 1, stdout: '', stderr: 'not loaded' };
  }
  if (platform === 'linux' && command === 'systemctl' && args.includes('show')) {
    return { code: 0, stdout: 'ActiveState=inactive\nUnitFileState=enabled\nMainPID=0\n', stderr: '' };
  }
  if (platform === 'win32' && command === 'schtasks.exe' && args[0] === '/Query') {
    return args.includes('/V')
      ? { code: 0, stdout: 'Status: Ready\nScheduled Task State: Enabled\n', stderr: '' }
      : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
  }
  return ok();
}

function ownedWindowsTask(definitionPath: string): CommandResult {
  return {
    code: 0,
    stdout: `<Task><Command>powershell.exe</Command><Arguments>-File &quot;${definitionPath}&quot;</Arguments></Task>`,
    stderr: '',
  };
}

function ok(): CommandResult {
  return { code: 0, stdout: '', stderr: '' };
}
