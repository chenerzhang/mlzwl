import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProfileConfig, normalizeRootConfig } from '../../src/config/profile-schema.js';
import { resolveAppSecret, saveAppSecret } from '../../src/config/store.js';

describe('Pi-only profile schema', () => {
  const app = { id: 'cli_test', secret: '${TEST_SECRET}', tenant: 'feishu' as const };
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('fixes every profile to Pi and supports only read-only/full access', () => {
    const profile = createProfileConfig({ app, permissions: { defaultAccess: 'read-only', maxAccess: 'full' } });
    expect(profile.agentKind).toBe('pi');
    expect(profile.permissions).toEqual({ defaultAccess: 'read-only', maxAccess: 'full' });
    expect(profile.preferences).toMatchObject({
      piConfigScope: 'user',
      transport: 'spawn-per-turn',
      sessionRetention: { enabled: true, activeDays: 90, archivedDays: 7, orphanDays: 7 },
    });
  });

  it('defaults mention exceptions to empty and normalizes persisted entries', () => {
    expect(createProfileConfig({ app }).access.mentionOptionalChats).toEqual([]);
    expect(
      createProfileConfig({
        app,
        access: { allowedChats: ['oc_one', 'oc_two'], mentionOptionalChats: ['oc_one', '', 'oc_two', 'oc_one'] },
      }).access.mentionOptionalChats,
    ).toEqual(['oc_one', 'oc_two']);
    expect(() =>
      createProfileConfig({ app, access: { allowedChats: ['oc_one'], mentionOptionalChats: ['oc_other'] } }),
    ).toThrow(/subset of allowedChats/);
    expect(() =>
      createProfileConfig({
        app,
        mode: 'team',
        access: { allowedChats: ['oc_one'], mentionOptionalChats: ['oc_one'] },
      }),
    ).toThrow(/personal profiles/);
  });

  it('requires explicit Pi config scope and transport in persisted profiles', () => {
    const profile = createProfileConfig({ app });
    expect(() =>
      normalizeRootConfig({
        schemaVersion: 3,
        activeProfile: 'default',
        profiles: {
          default: { ...profile, preferences: { transport: 'spawn-per-turn' } },
        },
      }),
    ).toThrow(/piConfigScope/);
    expect(() =>
      normalizeRootConfig({
        schemaVersion: 3,
        activeProfile: 'default',
        profiles: {
          default: { ...profile, preferences: { piConfigScope: 'user' } },
        },
      }),
    ).toThrow(/transport/);
  });

  it('defaults new profiles to full and rejects malformed persisted permissions', () => {
    expect(createProfileConfig({ app }).permissions).toEqual({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(() =>
      normalizeRootConfig({
        schemaVersion: 3,
        activeProfile: 'default',
        profiles: {
          default: {
            schemaVersion: 3,
            agentKind: 'pi',
            accounts: { app },
            access: {},
            workspaces: {},
            preferences: { piConfigScope: 'user' },
          },
        },
      }),
    ).toThrow(/permissions/);
    expect(() => createProfileConfig({ app, permissions: { defaultAccess: 'full', maxAccess: 'read-only' } })).toThrow(
      /cannot exceed/,
    );
    expect(() =>
      createProfileConfig({
        app,
        permissions: { defaultAccess: 'invalid', maxAccess: 'invalid' } as never,
      }),
    ).toThrow(/must be read-only or full/);
  });

  it('defaults the schema helper to spawn-per-turn and accepts explicit RPC', () => {
    expect(createProfileConfig({ app }).preferences.transport).toBe('spawn-per-turn');
    expect(
      createProfileConfig({ app, preferences: { piConfigScope: 'profile', transport: 'rpc' } }).preferences,
    ).toMatchObject({ piConfigScope: 'profile', transport: 'rpc' });
    expect(() => createProfileConfig({ app, preferences: { transport: 'future' as never } })).toThrow(/transport/);
  });

  it('preserves normalized model and transport preferences when profile credentials are updated', () => {
    const previous = createProfileConfig({
      app,
      preferences: { transport: 'rpc', model: 'x-connect/trae-gpt-5.5', showToolCalls: true },
    });
    const updated = createProfileConfig({
      app: { id: 'cli_test', secretFile: 'profiles/default/app-secret', tenant: 'feishu' },
      preferences: previous.preferences,
    });
    expect(updated.preferences).toEqual({
      piConfigScope: 'user',
      transport: 'rpc',
      model: 'x-connect/trae-gpt-5.5',
      showToolCalls: true,
      sessionRetention: { enabled: true, activeDays: 90, archivedDays: 7, orphanDays: 7 },
    });
  });

  it('normalizes session retention and rejects unsafe retention windows', () => {
    expect(
      createProfileConfig({
        app,
        preferences: {
          sessionRetention: { enabled: false, activeDays: 365, archivedDays: 30, orphanDays: 14 },
        },
      }).preferences.sessionRetention,
    ).toEqual({ enabled: false, activeDays: 365, archivedDays: 30, orphanDays: 14 });
    expect(() => createProfileConfig({ app, preferences: { sessionRetention: { activeDays: 6 } as never } })).toThrow(
      /activeDays/,
    );
    expect(() =>
      createProfileConfig({ app, preferences: { sessionRetention: { archivedDays: 366 } as never } }),
    ).toThrow(/archivedDays/);
  });

  it('accepts safe named workspace aliases while dropping invalid aliases', () => {
    const profile = createProfileConfig({
      app,
      workspaces: {
        defaultAlias: 'api',
        named: { api: '/repo/api', '../bad': '/tmp', empty: ' ' },
      },
    });
    expect(profile.workspaces).toEqual({ defaultAlias: 'api', named: { api: '/repo/api' } });
  });

  it('accepts exactly one App Secret source', () => {
    expect(
      createProfileConfig({ app: { id: 'cli_test', secretFile: 'profiles/default/app-secret', tenant: 'feishu' } })
        .accounts.app,
    ).toEqual({ id: 'cli_test', secretFile: 'profiles/default/app-secret', tenant: 'feishu' });
    expect(() =>
      createProfileConfig({
        app: {
          id: 'cli_test',
          secret: '${TEST_SECRET}',
          secretFile: 'profiles/default/app-secret',
          tenant: 'feishu',
        },
      }),
    ).toThrow(/exactly one/);
  });

  it('stores and resolves a private profile-local App Secret file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-secret-test-'));
    cleanup.push(root);
    const secretFile = join(root, 'profiles', 'default', 'app-secret');
    await saveAppSecret(secretFile, '${TEST_SECRET}');
    const profileDir = join(root, 'profiles', 'default');
    await expect(
      resolveAppSecret({ secretFile: 'profiles/default/app-secret' }, join(root, 'config.json'), profileDir),
    ).resolves.toBe('${TEST_SECRET}');
    await chmod(secretFile, 0o644);
    await expect(
      resolveAppSecret({ secretFile: 'profiles/default/app-secret' }, join(root, 'config.json'), profileDir),
    ).rejects.toThrow(/group\/others/);
    await writeFile(secretFile, '${TEST_SECRET}', { mode: 0o600 });
    await expect(
      resolveAppSecret({ secretFile: '../outside-secret' }, join(root, 'config.json'), profileDir),
    ).rejects.toThrow(/selected profile directory/);
    await rm(secretFile);
    const outside = join(root, 'outside-secret');
    await writeFile(outside, '${TEST_SECRET}', { mode: 0o600 });
    await symlink(outside, secretFile);
    await expect(
      resolveAppSecret({ secretFile: 'profiles/default/app-secret' }, join(root, 'config.json'), profileDir),
    ).rejects.toThrow(/not a regular file/);
  });

  it('rejects unsupported multi-agent profile values', () => {
    expect(() =>
      normalizeRootConfig({
        schemaVersion: 3,
        activeProfile: 'default',
        profiles: {
          default: {
            schemaVersion: 3,
            agentKind: 'codex',
            accounts: { app },
            access: {},
            workspaces: {},
            permissions: {},
            preferences: {},
          },
        },
      }),
    ).toThrow(/agentKind must be pi/);
  });
});
