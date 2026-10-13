import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProfileConfig } from '../../src/config/profile-schema.js';
import { saveRootConfig } from '../../src/config/store.js';
import type { CommandRunner } from '../../src/daemon/managed-service.js';
import { updateBridge, type GlobalInstallLayout } from '../../src/update/updater.js';

describe('safe self update orchestration', () => {
  const cleanup: string[] = [];
  afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

  it('uses the fixed registry, exact version, structured argv, and no shell', async () => {
    const fixture = await createFixture('0.1.0');
    cleanup.push(fixture.root);
    const calls: Array<[string, string[]]> = [];
    let installed = false;
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      expect(command).not.toMatch(/(?:^|\/)sh$|cmd\.exe/);
      if (command === fixture.install.npmPath && args[0] === 'view') {
        return { code: 0, stdout: '"0.2.0"\n', stderr: '' };
      }
      if (command === fixture.install.npmPath && args[0] === 'install') {
        installed = true;
        return ok();
      }
      if (command === fixture.install.nodePath && args.includes('--version')) {
        return { code: 0, stdout: '0.2.0\n', stderr: '' };
      }
      return ok();
    };
    const result = await updateBridge({
      runner,
      discoverInstall: async () => fixture.install,
      discoverServices: async () => [],
      rootDirs: [fixture.home],
      lockPath: join(fixture.root, 'update.lock'),
    });
    expect(result.package).toEqual({ from: '0.1.0', latest: '0.2.0', installed: true, final: '0.2.0' });
    expect(installed).toBe(true);
    expect(calls).toContainEqual([
      fixture.install.npmPath,
      ['view', '@mlzwl/lark-pi-bridge@latest', 'version', '--registry', 'https://registry.npmjs.org', '--json'],
    ]);
    expect(calls).toContainEqual([
      fixture.install.npmPath,
      ['install', '--global', '@mlzwl/lark-pi-bridge@0.2.0', '--registry', 'https://registry.npmjs.org'],
    ]);
  });

  it('does not install, inspect runtime, or invoke maintenance commands when already current', async () => {
    const fixture = await createFixture('0.1.0');
    cleanup.push(fixture.root);
    const calls: string[][] = [];
    const latestRunner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'view') {
        return { code: 0, stdout: '"0.1.0"', stderr: '' };
      }
      if (args.includes('--version')) {
        return { code: 0, stdout: '0.1.0\n', stderr: '' };
      }
      return ok();
    };
    await expect(
      updateBridge({
        runner: latestRunner,
        discoverInstall: async () => fixture.install,
        discoverServices: async () => [],
        runtimeStatus: async () => {
          throw new Error('runtime status should not be queried for no-op maintenance');
        },
        rootDirs: [fixture.home],
        lockPath: join(fixture.root, 'latest.lock'),
      }),
    ).resolves.toMatchObject({ package: { installed: false } });
    expect(calls.some((call) => call.includes('install'))).toBe(false);
  });

  it('restores a running owned service after an install failure without invoking extra maintenance commands', async () => {
    const fixture = await createFixture('0.1.0');
    cleanup.push(fixture.root);
    const calls: string[][] = [];
    let running = true;
    const service = ownedLinuxService(fixture, () => running);
    await writeFile(
      service.definitionPath,
      '# Managed-By: @mlzwl/lark-pi-bridge; Service-Id: lark-pi-bridge-default.service\n',
      { mode: 0o600 },
    );
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'view') {
        return { code: 0, stdout: '"0.2.0"', stderr: '' };
      }
      if (command === 'systemctl' && args.includes('show')) {
        return linuxStatus(running, true);
      }
      if (command === 'systemctl' && args.includes('daemon-reload')) {
        return ok();
      }
      if (command === 'systemctl' && args.includes('stop')) {
        running = false;
        return ok();
      }
      if (command === 'systemctl' && args.includes('enable') && args.includes('--now')) {
        running = true;
        return ok();
      }
      if (args[0] === 'install') {
        return { code: 1, stdout: '', stderr: 'synthetic install failure' };
      }
      return ok();
    };
    await expect(
      updateBridge({
        runner,
        discoverInstall: async () => fixture.install,
        discoverServices: async () => [service],
        runtimeStatus: async () => ({
          profile: 'default',
          generation: 1,
          active: 0,
          starting: 0,
          ready: true,
          health: 'ready',
          scopes: [],
          refreshing: false,
        }),
        lockPath: join(fixture.root, 'restore.lock'),
      }),
    ).rejects.toThrow(/synthetic install failure/);
    expect(running).toBe(true);
    expect(calls.some((call) => call[0] === 'systemctl' && call.includes('stop'))).toBe(true);
    expect(calls.some((call) => call[0] === 'systemctl' && call.includes('--now'))).toBe(true);
  });

  it('reports installed package state when service restoration fails', async () => {
    const fixture = await createFixture('0.1.0');
    cleanup.push(fixture.root);
    const service = ownedLinuxService(fixture, () => false);
    await writeFile(
      service.definitionPath,
      '# Managed-By: @mlzwl/lark-pi-bridge; Service-Id: lark-pi-bridge-default.service\n',
      { mode: 0o600 },
    );
    const runner: CommandRunner = async (command, args) => {
      if (args[0] === 'view') {
        return { code: 0, stdout: '"0.2.0"', stderr: '' };
      }
      if (args[0] === 'install') {
        return ok();
      }
      if (command === fixture.install.nodePath && args.includes('--version')) {
        return { code: 0, stdout: '0.2.0\n', stderr: '' };
      }
      if (command === 'systemctl' && args.includes('daemon-reload')) {
        return { code: 1, stdout: '', stderr: 'synthetic service failure' };
      }
      return linuxStatus(false, true);
    };
    await expect(
      updateBridge({
        runner,
        discoverInstall: async () => fixture.install,
        discoverServices: async () => [service],
        lockPath: join(fixture.root, 'service-failure.lock'),
      }),
    ).rejects.toThrow(/"phase":"service".*"installed":true.*synthetic service failure/);
  });

  it('refuses maintenance when an unmanaged foreground runtime is present', async () => {
    const fixture = await createFixture('0.1.0');
    cleanup.push(fixture.root);
    await expect(
      updateBridge({
        runner: async (_command, args) => {
          if (args[0] === 'view') {
            return { code: 0, stdout: '"0.2.0"', stderr: '' };
          }
          return ok();
        },
        discoverInstall: async () => fixture.install,
        discoverServices: async () => [],
        runtimeStatus: async () => ({
          profile: 'default',
          generation: 1,
          active: 0,
          starting: 0,
          ready: true,
          health: 'ready',
        }),
        rootDirs: [fixture.home],
        lockPath: join(fixture.root, 'foreground.lock'),
      }),
    ).rejects.toThrow(/未由 owned service 管理的前台 runtime/);
  });

  it('refuses maintenance when a running owned service has no runtime control response', async () => {
    const fixture = await createFixture('0.1.0');
    cleanup.push(fixture.root);
    const service = ownedLinuxService(fixture, () => true);
    await expect(
      updateBridge({
        runner: async (_command, args) => (args[0] === 'view' ? { code: 0, stdout: '"0.2.0"', stderr: '' } : ok()),
        discoverInstall: async () => fixture.install,
        discoverServices: async () => [service],
        runtimeStatus: async () => undefined,
        lockPath: join(fixture.root, 'missing-control.lock'),
      }),
    ).rejects.toThrow(/service 报告运行中但 runtime control 不可用/);
  });

  it('refuses a registry downgrade', async () => {
    const fixture = await createFixture('1.0.0');
    cleanup.push(fixture.root);
    await expect(
      updateBridge({
        runner: async (_command, args) => (args[0] === 'view' ? { code: 0, stdout: '"0.9.0"', stderr: '' } : ok()),
        discoverInstall: async () => fixture.install,
        discoverServices: async () => [],
        lockPath: join(fixture.root, 'downgrade.lock'),
      }),
    ).rejects.toThrow(/拒绝隐式降级/);
  });
});

async function createFixture(version: string): Promise<{ root: string; home: string; install: GlobalInstallLayout }> {
  const root = await mkdtemp(join(tmpdir(), 'lark-pi-update-'));
  const packageRoot = join(root, 'global', '@chenerzhang', 'lark-pi-bridge');
  const cliEntryPath = join(packageRoot, 'dist', 'cli.js');
  const home = join(root, 'home');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@mlzwl/lark-pi-bridge', version }));
  await writeFile(cliEntryPath, '');
  await saveRootConfig(join(home, 'config.json'), {
    schemaVersion: 3,
    activeProfile: 'default',
    profiles: {
      default: createProfileConfig({
        app: { id: 'cli_test', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspaces: { defaultPath: root },
      }),
    },
  });
  return {
    root,
    home,
    install: {
      packageRoot,
      cliEntryPath,
      nodePath: join(root, 'bin', 'node'),
      npmPath: join(root, 'bin', 'npm'),
    },
  };
}

function ownedLinuxService(fixture: Awaited<ReturnType<typeof createFixture>>, running: () => boolean) {
  return {
    platform: 'linux' as const,
    profile: 'default',
    rootDir: fixture.home,
    nodePath: fixture.install.nodePath,
    cliEntryPath: fixture.install.cliEntryPath,
    piBin: join(fixture.root, 'bin', 'pi'),
    envPath: join(fixture.root, 'bin'),
    definitionPath: join(fixture.root, 'lark-pi-bridge-default.service'),
    status: {
      platform: 'linux' as const,
      profile: 'default',
      serviceId: 'lark-pi-bridge-default.service',
      definitionPath: join(fixture.root, 'lark-pi-bridge-default.service'),
      installed: true,
      enabled: true,
      running: running(),
    },
  };
}

function linuxStatus(running: boolean, enabled: boolean) {
  return {
    code: 0,
    stdout: `ActiveState=${running ? 'active' : 'inactive'}\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\nMainPID=${running ? '42' : '0'}\n`,
    stderr: '',
  };
}

function ok() {
  return { code: 0, stdout: '', stderr: '' };
}
