import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../src/config/app-paths.js';
import {
  activateProfile,
  configureProfileModel,
  getPublicProfile,
  listPublicProfiles,
  getDefaultWorkspace,
  removeWorkspace,
  setDefaultWorkspace,
  setWorkspace,
  updateProfileMentionOptionalChat,
  updateProfilePermissions,
  updateProfilePiConfigScope,
  updateProfileSessionRetention,
  updateProfileTransport,
} from '../../src/config/profile-management.js';
import { createProfileConfig, type RootConfig } from '../../src/config/profile-schema.js';
import { loadRootConfig, saveRootConfig } from '../../src/config/store.js';

describe('profile and workspace management', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('uses the standalone default home and shared app-lock root', () => {
    const paths = resolveAppPaths();
    expect(paths.rootDir).toBe(process.env.LARK_PI_BRIDGE_HOME ?? join(homedir(), '.lark-pi-bridge'));
    expect(paths.appLockFile('cli_test')).toContain(join(homedir(), '.lark-pi-bridge', 'runtime', 'app-locks'));
  });

  it('returns an allowlisted public view without secret material', async () => {
    const { root, paths } = await fixture();
    cleanup.push(root);
    const text = JSON.stringify(await getPublicProfile(paths));
    expect(text).toContain('cli_test');
    expect(text).toContain('secretConfigured');
    expect(text).toContain('spawn-per-turn');
    expect(text).not.toContain('private-app-secret');
    expect(text).not.toContain('secretFile');
    expect(await listPublicProfiles(paths)).toHaveLength(2);
  });

  it('sets/removes canonical workspace paths and preserves concurrent profile updates', async () => {
    const { root, paths } = await fixture();
    cleanup.push(root);
    const project = join(root, 'project');
    await mkdir(project);
    const canonical = await realpath(project);
    await Promise.all([
      setWorkspace(paths, { alias: 'bridge', path: project }),
      updateProfilePermissions(paths, { defaultAccess: 'read-only', maxAccess: 'full' }),
    ]);
    let profile = (await loadRootConfig(paths.configFile))!.profiles.test!;
    expect(profile.workspaces.named?.bridge).toBe(canonical);
    expect(profile.permissions).toEqual({ defaultAccess: 'read-only', maxAccess: 'full' });

    await setDefaultWorkspace(paths, 'bridge');
    await expect(getDefaultWorkspace(paths)).resolves.toMatchObject({
      kind: 'alias',
      alias: 'bridge',
      path: canonical,
    });
    await expect(removeWorkspace(paths, 'bridge')).rejects.toThrow(/默认/);
    await setWorkspace(paths, { alias: 'other', path: root });
    await setDefaultWorkspace(paths, 'other');
    await removeWorkspace(paths, 'bridge');
    profile = (await loadRootConfig(paths.configFile))!.profiles.test!;
    expect(profile.workspaces.named?.bridge).toBeUndefined();
    await expect(setWorkspace(paths, { alias: 'default', path: project })).rejects.toThrow(/alias/);
    await expect(setWorkspace(paths, { alias: '../bad', path: project })).rejects.toThrow(/alias/);
    await expect(setWorkspace(paths, { alias: 'bad', path: 'relative' })).rejects.toThrow(/绝对路径/);
  });

  it('switches Pi config scope and rejects model writes in user scope', async () => {
    const { root, paths } = await fixture();
    cleanup.push(root);
    await expect(
      configureProfileModel(paths, {
        providerId: 'local',
        modelId: 'model',
        baseUrl: 'http://127.0.0.1:10010/v1',
        api: 'openai-responses',
      }),
    ).rejects.toThrow(/不修改 ~\/.pi\/agent/);
    await expect(updateProfilePiConfigScope(paths, 'profile')).resolves.toBe('profile');
    await expect(
      configureProfileModel(paths, {
        providerId: 'local',
        modelId: 'model',
        baseUrl: 'http://127.0.0.1:10010/v1',
        api: 'openai-responses',
      }),
    ).resolves.toBeUndefined();
    expect((await loadRootConfig(paths.configFile))!.profiles.test!.preferences.model).toBe('local/model');
  });

  it('allows mention exceptions only for authorized personal-profile group chats', async () => {
    const { root, paths } = await fixture();
    cleanup.push(root);
    await expect(updateProfileMentionOptionalChat(paths, 'oc_missing', true)).rejects.toThrow(/allowedChats/);
    await expect(updateProfileMentionOptionalChat(paths, 'unsafe', true)).rejects.toThrow(/oc_/);
    await mutateAllowedChats(paths, ['oc_target']);
    await expect(updateProfileMentionOptionalChat(paths, 'oc_target', true)).resolves.toMatchObject({
      enabled: true,
      mentionOptionalChats: ['oc_target'],
    });
    expect((await getPublicProfile(paths)).access.mentionOptionalChats).toEqual(['oc_target']);
    await expect(updateProfileMentionOptionalChat(paths, 'oc_target', false)).resolves.toMatchObject({
      enabled: false,
      mentionOptionalChats: [],
    });
  });

  it('updates and publishes validated session retention settings', async () => {
    const { root, paths } = await fixture();
    cleanup.push(root);
    await expect(updateProfileSessionRetention(paths, { activeDays: 180, enabled: false })).resolves.toEqual({
      enabled: false,
      activeDays: 180,
      archivedDays: 7,
      orphanDays: 7,
    });
    expect((await getPublicProfile(paths)).preferences.sessionRetention).toEqual({
      enabled: false,
      activeDays: 180,
      archivedDays: 7,
      orphanDays: 7,
    });
    await expect(updateProfileSessionRetention(paths, { orphanDays: 0 })).rejects.toThrow(/orphanDays/);
  });

  it('updates only the explicit Pi transport enum', async () => {
    const { root, paths } = await fixture();
    cleanup.push(root);
    await expect(updateProfileTransport(paths, 'rpc')).resolves.toBe('rpc');
    expect((await loadRootConfig(paths.configFile))!.profiles.test!.preferences.transport).toBe('rpc');
    await expect(updateProfileTransport(paths, 'future' as never)).rejects.toThrow(/transport/);
  });

  it('activates only an existing safe profile and keeps the marker private', async () => {
    const { root, paths } = await fixture();
    cleanup.push(root);
    await activateProfile(paths, 'other');
    expect((await loadRootConfig(paths.configFile))!.activeProfile).toBe('other');
    expect(await readFile(paths.activeProfileFile, 'utf8')).toBe('other\n');
    await expect(activateProfile(paths, 'missing')).rejects.toThrow(/不存在/);
  });
});

async function mutateAllowedChats(paths: ReturnType<typeof resolveAppPaths>, allowedChats: string[]): Promise<void> {
  const root = (await loadRootConfig(paths.configFile))!;
  const profile = root.profiles[paths.profile]!;
  await saveRootConfig(paths.configFile, {
    ...root,
    profiles: {
      ...root.profiles,
      [paths.profile]: { ...profile, access: { ...profile.access, allowedChats } },
    },
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lark-pi-profile-management-'));
  const paths = resolveAppPaths({ rootDir: root, profile: 'test' });
  const rootConfig: RootConfig = {
    schemaVersion: 3,
    activeProfile: 'test',
    profiles: {
      test: createProfileConfig({
        app: { id: 'cli_test', secret: 'private-app-secret', tenant: 'feishu' },
        workspaces: { defaultAlias: 'root', named: { root } },
      }),
      other: createProfileConfig({
        app: { id: 'cli_other', secret: 'other-private-secret', tenant: 'lark' },
        workspaces: { defaultAlias: 'root', named: { root } },
      }),
    },
  };
  await saveRootConfig(paths.configFile, rootConfig);
  await writeFile(paths.activeProfileFile, 'test\n', { mode: 0o600 });
  return { root, paths };
}
