import { lstat, realpath, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveAppPaths } from '../config/app-paths.js';
import type { CommandResult, CommandRunner } from '../daemon/managed-service.js';
import { runCommand } from '../daemon/managed-service.js';
import { optionalRuntimeControlStatus } from '../runtime/control.js';
import { acquireRuntimeLock } from '../runtime/locks.js';
import {
  discoverOwnedServices,
  managerForOwnedService,
  type OwnedServiceDescriptor,
  type ServiceInventoryOptions,
} from './service-discovery.js';

const PACKAGE_NAME = '@mlzwl/lark-pi-bridge';
const REGISTRY = 'https://registry.npmjs.org';

export interface GlobalInstallLayout {
  packageRoot: string;
  cliEntryPath: string;
  nodePath: string;
  npmPath: string;
}

export interface UpdateDependencies {
  runner?: CommandRunner;
  discoverInstall?: () => Promise<GlobalInstallLayout>;
  discoverServices?: () => Promise<OwnedServiceDescriptor[]>;
  runtimeStatus?: typeof optionalRuntimeControlStatus;
  inventory?: ServiceInventoryOptions;
  rootDirs?: string[];
  lockPath?: string;
}

export interface UpdateResult {
  ok: true;
  registry: string;
  package: {
    from: string;
    latest: string;
    installed: boolean;
    final: string;
  };
  services: Array<{
    profile: string;
    home: string;
    before: { installed: boolean; enabled?: boolean; running: boolean };
    after: { installed: boolean; enabled?: boolean; running: boolean };
    definitionUpdated: boolean;
  }>;
}

export async function updateBridge(deps: UpdateDependencies = {}): Promise<UpdateResult> {
  const runner = deps.runner ?? runCommand;
  const install = await (deps.discoverInstall ?? (() => discoverGlobalInstall()))();
  const packageJson = await readPackageJson(install.packageRoot);
  if (packageJson.name !== PACKAGE_NAME) {
    throw new Error(`当前 CLI 不属于 ${PACKAGE_NAME}`);
  }
  const lock = await acquireRuntimeLock(deps.lockPath ?? join(homedir(), '.lark-pi-bridge', 'runtime', 'update.lock'));
  try {
    const latestResult = await requireCommand(runner, install.npmPath, [
      'view',
      `${PACKAGE_NAME}@latest`,
      'version',
      '--registry',
      REGISTRY,
      '--json',
    ]);
    const latest = parseNpmVersion(latestResult.stdout);
    const comparison = compareSemver(latest, packageJson.version);
    if (comparison < 0) {
      throw new Error(`registry latest ${latest} 低于当前版本 ${packageJson.version}，拒绝隐式降级`);
    }

    const services = await (deps.discoverServices ?? (() => discoverOwnedServices({ ...deps.inventory, runner })))();
    const homes = [
      ...new Set(
        [...(deps.rootDirs ?? []), ...services.map((service) => service.rootDir)].map((home) => resolve(home)),
      ),
    ];
    const installing = comparison > 0;
    const maintenanceRequired = installing;
    const runtimeStatus = deps.runtimeStatus ?? optionalRuntimeControlStatus;
    if (maintenanceRequired) {
      for (const service of services) {
        if (!service.status.running) {
          continue;
        }
        const status = await runtimeStatus(resolveAppPaths({ rootDir: service.rootDir, profile: service.profile }));
        if (!status) {
          throw new Error(`profile「${service.profile}」service 报告运行中但 runtime control 不可用`);
        }
        if (status.active || status.starting) {
          throw new Error(
            `profile「${service.profile}」runtime busy: active=${status.active}, starting=${status.starting}`,
          );
        }
      }
      for (const home of homes) {
        await assertNoUnmanagedForegroundRuntime(home, services, runtimeStatus);
      }
    }

    const stopped: OwnedServiceDescriptor[] = [];
    let latestInstall = install;
    let finalVersion = packageJson.version;
    let installVerified = false;
    try {
      if (maintenanceRequired) {
        for (const service of services) {
          if (!service.status.running) {
            continue;
          }
          await managerForOwnedService(service, { runner }).stop();
          stopped.push(service);
        }
      }

      if (installing) {
        await requireCommand(runner, install.npmPath, [
          'install',
          '--global',
          `${PACKAGE_NAME}@${latest}`,
          '--registry',
          REGISTRY,
        ]);
      }
      latestInstall = await (deps.discoverInstall ?? (() => discoverGlobalInstall()))();
      const versionResult = await requireCommand(runner, latestInstall.nodePath, [
        latestInstall.cliEntryPath,
        '--version',
      ]);
      finalVersion = versionResult.stdout.trim();
      if (finalVersion !== latest) {
        throw new Error(`更新后 CLI 版本校验失败：期望 ${latest}，实际 ${finalVersion}`);
      }
      installVerified = installing;
    } catch (error) {
      const restoreErrors: unknown[] = [];
      for (const service of stopped) {
        await restoreServiceState(managerForOwnedService(service, { runner }), service).catch((restoreError) =>
          restoreErrors.push(restoreError),
        );
      }
      throw updatePhaseError(error, {
        phase: 'package',
        package: {
          from: packageJson.version,
          latest,
          installed: installVerified,
          final: finalVersion,
        },
        services: [],
        serviceRestorationComplete: restoreErrors.length === 0,
        restorationErrors: restoreErrors.map((restoreError) =>
          restoreError instanceof Error ? restoreError.message : String(restoreError),
        ),
      });
    }

    const serviceResults: UpdateResult['services'] = [];
    try {
      for (const service of services) {
        const definitionUpdated = installing;
        const manager = managerForOwnedService(service, {
          runner,
          nodePath: latestInstall.nodePath,
          cliEntryPath: latestInstall.cliEntryPath,
        });
        if (definitionUpdated) {
          await manager.install();
        }
        if (definitionUpdated || stopped.includes(service)) {
          await manager.restoreState(service.status);
        }
        const after = await manager.status();
        if (after.running !== service.status.running || after.enabled !== service.status.enabled) {
          throw new Error(`service 状态恢复失败：${service.profile}`);
        }
        serviceResults.push({
          profile: service.profile,
          home: service.rootDir,
          before: publicServiceState(service.status),
          after: publicServiceState(after),
          definitionUpdated,
        });
      }
    } catch (error) {
      throw updatePhaseError(error, {
        phase: 'service',
        package: { from: packageJson.version, latest, installed: installing, final: finalVersion },
        services: serviceResults,
      });
    }

    return {
      ok: true,
      registry: REGISTRY,
      package: { from: packageJson.version, latest, installed: installing, final: finalVersion },
      services: serviceResults,
    };
  } finally {
    await lock.release();
  }
}

async function restoreServiceState(
  manager: ReturnType<typeof managerForOwnedService>,
  service: OwnedServiceDescriptor,
): Promise<void> {
  await manager.restoreState(service.status);
}

function updatePhaseError(
  error: unknown,
  state: {
    phase: 'package' | 'service';
    package: UpdateResult['package'];
    services: UpdateResult['services'];
    serviceRestorationComplete?: boolean;
    restorationErrors?: string[];
  },
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${JSON.stringify({ ok: false, ...state, error: detail })}`, { cause: error });
}

export async function discoverGlobalInstall(
  input: {
    cliEntryPath?: string;
    nodePath?: string;
    npmPath?: string;
    globalRoot?: string;
  } = {},
): Promise<GlobalInstallLayout> {
  const cliEntryPath = await realpath(input.cliEntryPath ?? process.argv[1] ?? '');
  const packageRoot = resolve(dirname(cliEntryPath), '..');
  const packageJson = await readPackageJson(packageRoot);
  if (packageJson.name !== PACKAGE_NAME) {
    throw new Error('update 只支持已发布全局 npm 安装，当前入口不是目标包');
  }
  const nodePath = await realpath(input.nodePath ?? process.execPath);
  const npmPath = await resolveExecutable(input.npmPath ?? npmExecPath());
  const globalRoot = input.globalRoot ? await realpath(input.globalRoot) : await npmGlobalRoot(npmPath);
  if (!isPathInside(globalRoot, packageRoot) || resolve(globalRoot, PACKAGE_NAME) !== packageRoot) {
    throw new Error('无法确认当前 CLI 的全局 npm ownership；拒绝从源码、link 或未知布局更新');
  }
  const metadata = await lstat(packageRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('全局包目录不能是 symlink');
  }
  return { packageRoot, cliEntryPath, nodePath, npmPath };
}

function npmExecPath(): string {
  const execPath = process.env.npm_execpath;
  if (execPath && execPath.endsWith('.js')) {
    return execPath;
  }
  const candidate = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return candidate;
}

async function npmGlobalRoot(npmPath: string): Promise<string> {
  const result = await requireCommand(runCommand, npmPath, ['root', '--global']);
  return realpath(result.stdout.trim());
}

async function resolveExecutable(path: string): Promise<string> {
  return realpath(path);
}

async function assertNoUnmanagedForegroundRuntime(
  home: string,
  services: OwnedServiceDescriptor[],
  runtimeStatus: NonNullable<UpdateDependencies['runtimeStatus']>,
): Promise<void> {
  const raw = JSON.parse(await readFile(resolveAppPaths({ rootDir: home }).configFile, 'utf8')) as {
    profiles?: unknown;
  };
  if (!raw.profiles || typeof raw.profiles !== 'object' || Array.isArray(raw.profiles)) {
    throw new Error(`配置 profiles 无效：${home}`);
  }
  for (const profile of Object.keys(raw.profiles)) {
    const ownedRunning = services.some(
      (service) => service.rootDir === home && service.profile === profile && service.status.running,
    );
    if (ownedRunning) {
      continue;
    }
    const paths = resolveAppPaths({ rootDir: home, profile });
    const status = await runtimeStatus(paths);
    if (status && (status.active || status.starting || status.generation > 0)) {
      throw new Error(`检测到未由 owned service 管理的前台 runtime：${profile}；请先停止后更新`);
    }
  }
}

async function readPackageJson(root: string): Promise<{ name: string; version: string }> {
  const raw = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (typeof raw.name !== 'string' || typeof raw.version !== 'string' || !parseSemver(raw.version)) {
    throw new Error(`package metadata 无效：${root}`);
  }
  return { name: raw.name, version: raw.version };
}

async function requireCommand(runner: CommandRunner, command: string, args: string[]): Promise<CommandResult> {
  const result = await runner(command, args);
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`
      .trim()
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 500);
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.code}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function parseNpmVersion(stdout: string): string {
  const trimmed = stdout.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    value = trimmed;
  }
  if (typeof value !== 'string' || !parseSemver(value)) {
    throw new Error(`registry 返回了无效版本：${trimmed}`);
  }
  return value;
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    throw new Error('只能比较稳定语义版本');
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) {
      return a[index]! > b[index]! ? 1 : -1;
    }
  }
  return 0;
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function publicServiceState(status: OwnedServiceDescriptor['status']): {
  installed: boolean;
  enabled?: boolean;
  running: boolean;
} {
  return {
    installed: status.installed,
    running: status.running,
    ...(status.enabled === undefined ? {} : { enabled: status.enabled }),
  };
}

function isPathInside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
