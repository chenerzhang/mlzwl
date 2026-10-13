import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types.js';
import type { BridgeChannel } from '../../src/bot/channel.js';
import { resolveAppPaths } from '../../src/config/app-paths.js';
import { createProfileConfig } from '../../src/config/profile-schema.js';
import { refreshRuntime, runtimeControlStatus, startRuntimeControlServer } from '../../src/runtime/control.js';
import { loadProfileRuntimeFingerprint, ReloadableBridgeRuntime } from '../../src/runtime/reloadable.js';
import {
  clearConnectionFailuresAfterStableConnection,
  recordConnectionFailure,
  waitForConnectionRetryWindow,
} from '../../src/runtime/connection-retry.js';

const app = { id: 'cli_test', secret: '${TEST_SECRET}', tenant: 'feishu' as const };

describe.skipIf(process.platform === 'win32')('private runtime control', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('authenticates status/refresh locally and reports no-change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-control-'));
    cleanup.push(root);
    const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
    const profile = createProfileConfig({ app, workspaces: { defaultPath: root } });
    const runtime = new ReloadableBridgeRuntime({
      profile: 'test',
      initialProfile: profile,
      loadProfile: async () => profile,
      createAgent: () => fakeAgent(),
      startChannel: async () => fakeChannel(),
    });
    await runtime.start();
    const control = await startRuntimeControlServer(paths, runtime);
    await expect(runtimeControlStatus(paths)).resolves.toMatchObject({
      profile: 'test',
      generation: 1,
      active: 0,
      ready: true,
      health: 'ready',
      channel: { state: 'connected', reconnectAttempts: 0 },
    });
    await expect(refreshRuntime(paths)).resolves.toMatchObject({ refreshed: true, changed: false, generation: 1 });
    await control.close();
    await runtime.stop();
  });

  it('persists capped exponential restart backoff and clears it after a stable connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-retry-'));
    cleanup.push(root);
    const path = join(root, 'retry.json');
    await expect(waitForConnectionRetryWindow(path, { now: () => 1_000, sleep: async () => {} })).resolves.toBe(0);
    const expectedDelays = [5_000, 15_000, 45_000, 120_000, 300_000, 300_000];
    for (let index = 0; index < expectedDelays.length; index++) {
      expect(await recordConnectionFailure(path, 1_000)).toBe(index + 1);
      const sleeps: number[] = [];
      await expect(
        waitForConnectionRetryWindow(path, {
          now: () => 1_000,
          sleep: async (milliseconds) => void sleeps.push(milliseconds),
        }),
      ).resolves.toBe(expectedDelays[index]);
      expect(sleeps).toEqual([expectedDelays[index]]);
    }
    await clearConnectionFailuresAfterStableConnection(path, 4_000, 124_000);
    await expect(waitForConnectionRetryWindow(path, { now: () => 124_000, sleep: async () => {} })).resolves.toBe(0);
  });

  it('detects profile-local secret/model state changes without treating workspace edits as refresh changes', async () => {
    const profile = createProfileConfig({ app, workspaces: { defaultPath: '/before' } });
    let latest = profile;
    let external = 'one';
    const runtime = new ReloadableBridgeRuntime({
      profile: 'test',
      initialProfile: profile,
      loadProfile: async () => latest,
      loadRuntimeFingerprint: async () => external,
      createAgent: () => fakeAgent(),
      startChannel: async () => fakeChannel(),
    });
    await runtime.start();
    latest = createProfileConfig({ app, workspaces: { defaultPath: '/after' } });
    await expect(runtime.refresh()).resolves.toMatchObject({ changed: false, generation: 1 });
    external = 'two';
    await expect(runtime.refresh()).resolves.toMatchObject({ changed: true, generation: 2 });
    await runtime.stop();
  });

  it('rejects an over-broad runtime control token before sending a request', async () => {
    if (process.platform === 'win32' || !process.getuid) {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'lpc-mode-'));
    cleanup.push(root);
    const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
    const profile = createProfileConfig({ app, workspaces: { defaultPath: root } });
    const runtime = new ReloadableBridgeRuntime({
      profile: 'test',
      initialProfile: profile,
      loadProfile: async () => profile,
      createAgent: () => fakeAgent(),
      startChannel: async () => fakeChannel(),
    });
    await runtime.start();
    const control = await startRuntimeControlServer(paths, runtime);
    await chmod(paths.controlTokenFile, 0o644);
    await expect(runtimeControlStatus(paths)).rejects.toThrow(/group\/others/);
    await control.close();
    await runtime.stop();
  });

  it('validates and hashes profile-local secret/model/auth state without returning plaintext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-runtime-fingerprint-'));
    cleanup.push(root);
    const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
    await mkdir(paths.profilePiAgentDir, { recursive: true, mode: 0o700 });
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.appSecretFile, 'super-private-app-secret', { mode: 0o600 });
    await writeFile(join(paths.profilePiAgentDir, 'models.json'), JSON.stringify({ providers: {} }), { mode: 0o600 });
    await writeFile(join(paths.profilePiAgentDir, 'auth.json'), JSON.stringify({}), { mode: 0o600 });
    if (process.platform !== 'win32') {
      await Promise.all([
        chmod(paths.appSecretFile, 0o600),
        chmod(join(paths.profilePiAgentDir, 'models.json'), 0o600),
        chmod(join(paths.profilePiAgentDir, 'auth.json'), 0o600),
      ]);
    }
    const profile = createProfileConfig({
      app: { id: 'cli_test', secretFile: 'profiles/test/app-secret', tenant: 'feishu' },
      preferences: { piConfigScope: 'profile' },
    });
    const fingerprint = JSON.stringify(await loadProfileRuntimeFingerprint(paths, profile));
    expect(fingerprint).not.toContain('super-private-app-secret');
    expect(fingerprint).toMatch(/appSecretHash/);
  });

  it('fingerprints user Pi settings/auth/resource metadata without returning their content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-runtime-user-fingerprint-'));
    cleanup.push(root);
    const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.appSecretFile, 'user-scope-app-secret', { mode: 0o600 });
    const profile = createProfileConfig({
      app: { id: 'cli_test', secretFile: 'profiles/test/app-secret', tenant: 'feishu' },
      preferences: { piConfigScope: 'user' },
    });
    const fingerprint = JSON.stringify(await loadProfileRuntimeFingerprint(paths, profile));
    expect(fingerprint).toContain('"piConfigScope":"user"');
    expect(fingerprint).toMatch(/settingsHash/);
    expect(fingerprint).toMatch(/modelsHash/);
    expect(fingerprint).toMatch(/authHash/);
    expect(fingerprint).toMatch(/resourcesHash/);
    expect(fingerprint).not.toContain('user-scope-app-secret');
    expect(fingerprint).not.toContain(homedir());
  });

  it('rejects active/starting work, disposes old RPC-like agent after swap, and restores after failure', async () => {
    const first = createProfileConfig({ app, preferences: { transport: 'rpc' } });
    const second = createProfileConfig({ app, preferences: { transport: 'spawn-per-turn' } });
    let latest = second;
    let activity = { active: 1, starting: 0, scopes: ['scope'] };
    const channels: BridgeChannel[] = [];
    const disposed: ReturnType<typeof vi.fn>[] = [];
    let failNext = false;
    const runtime = new ReloadableBridgeRuntime({
      profile: 'test',
      initialProfile: first,
      loadProfile: async () => latest,
      createAgent: () => {
        const dispose = vi.fn(async () => {});
        disposed.push(dispose);
        return fakeAgent(dispose);
      },
      startChannel: async (_profile, agent) => {
        if (failNext) {
          failNext = false;
          throw new Error('new channel failed');
        }
        const channel = fakeChannel(
          () => activity,
          async () => agent.dispose?.(),
        );
        channels.push(channel);
        return channel;
      },
    });
    await runtime.start();
    await expect(runtime.refresh()).rejects.toThrow(/runtime busy/);
    activity = { active: 0, starting: 0, scopes: [] };
    await expect(runtime.refresh()).resolves.toMatchObject({ changed: true, generation: 2 });
    expect(disposed[0]).toHaveBeenCalled();

    latest = createProfileConfig({ app, preferences: { transport: 'rpc', showToolCalls: true } });
    failNext = true;
    await expect(runtime.refresh()).rejects.toThrow(/已恢复旧运行配置/);
    expect(runtime.status()).toMatchObject({ generation: 2, active: 0, starting: 0 });
    await runtime.stop();
  });
});

function fakeAgent(dispose = vi.fn(async () => {})): AgentAdapter {
  return {
    id: 'pi',
    displayName: 'Pi',
    async isAvailable() {
      return true;
    },
    async checkAvailability() {
      return { ok: true };
    },
    run() {
      throw new Error('not used');
    },
    dispose,
  };
}

function fakeChannel(
  activity: () => { active: number; starting: number; scopes: string[] } = () => ({
    active: 0,
    starting: 0,
    scopes: [],
  }),
  disconnect: () => Promise<void> = async () => {},
): BridgeChannel {
  return {
    channel: {} as never,
    activity,
    health: () => ({ channel: { state: 'connected', reconnectAttempts: 0 }, failed: false }),
    failure: new Promise<never>(() => {}),
    quiesce() {
      return activity();
    },
    resume() {},
    disconnect,
  };
}
