import { realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { resolveAppPaths, type AppPaths } from './app-paths.js';
import { isAccessMode, normalizePermissions, type AccessMode } from './permissions.js';
import {
  workspaceDefault,
  type PiTransport,
  type ProfileConfig,
  type ProfileWorkspaces,
  type RootConfig,
} from './profile-schema.js';
import { loadRootConfig, readActiveProfile, saveRootConfig, writeActiveProfile } from './store.js';
import {
  configurePiModel,
  type CompatiblePiApi,
  type PiModelConfigurationStatus,
  type PiModelInput,
} from './pi-models.js';
import { inspectEffectivePiModelConfiguration, resolveEffectivePiPaths } from './pi-paths.js';
import { withFileMutationLock } from '../runtime/file-mutation.js';

export interface PublicModelStatus {
  state: PiModelConfigurationStatus['state'];
  scope: PiModelConfigurationStatus['scope'];
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  api?: CompatiblePiApi;
  endpoint?: string;
  input?: PiModelInput[];
  credentialConfigured: boolean;
}

export interface PublicProfileView {
  name: string;
  active: boolean;
  appId: string;
  tenant: 'feishu' | 'lark';
  mode: 'personal' | 'team';
  secretConfigured: boolean;
  access: {
    allowedUsers: string[];
    allowedChats: string[];
    mentionOptionalChats: string[];
    admins: string[];
    requireMentionInGroup: boolean;
  };
  workspaces: {
    defaultAlias?: string;
    defaultPath?: string;
    named: Record<string, string>;
    unavailable: string[];
  };
  permissions: {
    defaultAccess: AccessMode;
    maxAccess: AccessMode;
  };
  preferences: {
    piConfigScope: ProfileConfig['preferences']['piConfigScope'];
    transport: PiTransport;
    model?: string;
    showToolCalls?: boolean;
    maxConcurrentRuns?: number;
    runIdleTimeoutMinutes?: number;
    agentStopGraceMs?: number;
  };
  model: PublicModelStatus;
}

export async function listPublicProfiles(paths: AppPaths): Promise<PublicProfileView[]> {
  const root = await requiredRoot(paths);
  return Promise.all(
    Object.entries(root.profiles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, profile]) => publicProfileView(paths, root, name, profile)),
  );
}

export async function getPublicProfile(paths: AppPaths, name = paths.profile): Promise<PublicProfileView> {
  const root = await requiredRoot(paths);
  const profile = root.profiles[name];
  if (!profile) {
    throw new Error(`profile 不存在：${name}`);
  }
  return publicProfileView(paths, root, name, profile);
}

export async function activateProfile(paths: AppPaths, name: string): Promise<void> {
  const profileName = validateProfileName(name);
  await withFileMutationLock(paths.configFile, async () => {
    const root = await requiredRoot(paths);
    if (!root.profiles[profileName]) {
      throw new Error(`profile 不存在：${profileName}`);
    }
    const previousMarker = await readActiveProfile(paths.activeProfileFile);
    await saveRootConfig(paths.configFile, { ...root, activeProfile: profileName });
    try {
      await writeActiveProfile(paths.activeProfileFile, profileName);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      await saveRootConfig(paths.configFile, root).catch((rollbackError) => rollbackErrors.push(rollbackError));
      if (previousMarker) {
        await writeActiveProfile(paths.activeProfileFile, previousMarker).catch((rollbackError) =>
          rollbackErrors.push(rollbackError),
        );
      } else {
        await rm(paths.activeProfileFile, { force: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'profile activation rollback failed', { cause: error });
      }
      throw error;
    }
  });
}

export async function setWorkspace(
  paths: AppPaths,
  input: { alias: string; path: string },
): Promise<{ alias: string; path: string }> {
  const alias = validateWorkspaceAlias(input.alias);
  const path = await canonicalWorkspaceDirectory(input.path);
  await mutateProfile(paths, (profile) => {
    const named = { ...(profile.workspaces.named ?? {}), [alias]: path };
    return { ...profile, workspaces: { ...profile.workspaces, named } };
  });
  return { alias, path };
}

export async function setDefaultWorkspace(
  paths: AppPaths,
  aliasInput: string,
): Promise<{ alias: string; path: string }> {
  const alias = validateWorkspaceAlias(aliasInput);
  let selectedPath = '';
  await mutateProfile(paths, (profile) => {
    const named = { ...(profile.workspaces.named ?? {}) };
    const path = named[alias];
    if (!path) {
      throw new Error(`workspace alias 不存在：${alias}`);
    }
    selectedPath = path;
    return { ...profile, workspaces: { defaultAlias: alias, named } };
  });
  return { alias, path: selectedPath };
}

export async function getDefaultWorkspace(
  paths: AppPaths,
): Promise<
  | { kind: 'alias'; alias: string; path: string; available: boolean }
  | { kind: 'direct'; path: string; available: boolean }
> {
  const root = await requiredRoot(paths);
  const profile = root.profiles[paths.profile];
  if (!profile) {
    throw new Error(`profile 不存在：${paths.profile}`);
  }
  const selected = workspaceDefault(profile.workspaces);
  if (!selected) {
    throw new Error('尚未配置默认 workspace');
  }
  return { ...selected, available: await workspaceDirectoryAvailable(selected.path) };
}

export async function loadProfileWorkspaces(paths: AppPaths): Promise<ProfileWorkspaces> {
  const root = await requiredRoot(paths);
  const profile = root.profiles[paths.profile];
  if (!profile) {
    throw new Error(`profile 不存在：${paths.profile}`);
  }
  return {
    ...(profile.workspaces.defaultAlias ? { defaultAlias: profile.workspaces.defaultAlias } : {}),
    ...(profile.workspaces.defaultPath ? { defaultPath: profile.workspaces.defaultPath } : {}),
    named: { ...(profile.workspaces.named ?? {}) },
  };
}

export async function removeWorkspace(paths: AppPaths, aliasInput: string): Promise<void> {
  const alias = validateWorkspaceAlias(aliasInput);
  await mutateProfile(paths, (profile) => {
    if (profile.workspaces.defaultAlias === alias) {
      throw new Error(`不能删除当前默认 workspace：${alias}`);
    }
    const named = { ...(profile.workspaces.named ?? {}) };
    if (!(alias in named)) {
      throw new Error(`workspace alias 不存在：${alias}`);
    }
    delete named[alias];
    return { ...profile, workspaces: { ...profile.workspaces, named } };
  });
}

export async function configureProfileModel(
  paths: AppPaths,
  input: {
    providerId: string;
    modelId: string;
    baseUrl: string;
    api: CompatiblePiApi;
    input?: PiModelInput[];
    apiKeyFile?: string;
  },
): Promise<void> {
  const root = await requiredRoot(paths);
  const profile = root.profiles[paths.profile];
  if (!profile) {
    throw new Error(`profile 不存在：${paths.profile}`);
  }
  if (profile.preferences.piConfigScope !== 'profile') {
    throw new Error('当前 profile 使用 user Pi 配置；lark-pi-bridge 不修改 ~/.pi/agent');
  }
  await configurePiModel({ piAgentDir: resolveEffectivePiPaths(profile, paths).configDir, ...input }, () =>
    selectProfileModel(paths, `${input.providerId}/${input.modelId}`),
  );
}

export async function selectProfileModel(paths: AppPaths, model: string): Promise<void> {
  await mutateProfile(paths, (profile) => ({
    ...profile,
    preferences: { ...profile.preferences, model },
  }));
}

export async function updateProfilePiConfigScope(
  paths: AppPaths,
  scope: ProfileConfig['preferences']['piConfigScope'],
): Promise<ProfileConfig['preferences']['piConfigScope']> {
  if (scope !== 'user' && scope !== 'profile') {
    throw new Error('Pi config scope 必须是 user 或 profile');
  }
  await mutateProfile(paths, (profile) => ({
    ...profile,
    preferences: { ...profile.preferences, piConfigScope: scope },
  }));
  return scope;
}

export async function updateProfileTransport(paths: AppPaths, transport: PiTransport): Promise<PiTransport> {
  if (transport !== 'spawn-per-turn' && transport !== 'rpc') {
    throw new Error('unsupported Pi transport');
  }
  await mutateProfile(paths, (profile) => ({
    ...profile,
    preferences: { ...profile.preferences, transport },
  }));
  return transport;
}

export async function updateProfileMentionOptionalChat(
  paths: AppPaths,
  chatIdInput: string,
  enabled: boolean,
): Promise<{ chatId: string; enabled: boolean; mentionOptionalChats: string[] }> {
  const chatId = validateChatId(chatIdInput);
  let mentionOptionalChats: string[] = [];
  await mutateProfile(paths, (profile) => {
    if (profile.mode !== 'personal') {
      throw new Error('按群免 @ 仅支持 personal profile；team profile 请保持全局 mention 策略');
    }
    if (!profile.access.allowedChats.includes(chatId)) {
      throw new Error(`群聊尚未进入 allowedChats：${chatId}`);
    }
    mentionOptionalChats = enabled
      ? [...new Set([...profile.access.mentionOptionalChats, chatId])]
      : profile.access.mentionOptionalChats.filter((item) => item !== chatId);
    return {
      ...profile,
      access: { ...profile.access, mentionOptionalChats },
    };
  });
  return { chatId, enabled, mentionOptionalChats };
}

export async function updateProfilePermissions(
  paths: AppPaths,
  input: { defaultAccess: unknown; maxAccess: unknown },
): Promise<{ defaultAccess: AccessMode; maxAccess: AccessMode }> {
  if (!isAccessMode(input.defaultAccess) || !isAccessMode(input.maxAccess)) {
    throw new Error('defaultAccess 和 maxAccess 必须是 read-only 或 full');
  }
  const permissions = normalizePermissions(input);
  await mutateProfile(paths, (profile) => ({ ...profile, permissions }));
  return permissions;
}

export async function mutateProfile(
  paths: AppPaths,
  mutate: (profile: ProfileConfig) => ProfileConfig,
): Promise<ProfileConfig> {
  return withFileMutationLock(paths.configFile, async () => {
    const root = await requiredRoot(paths);
    const current = root.profiles[paths.profile];
    if (!current) {
      throw new Error(`profile 不存在：${paths.profile}`);
    }
    const next = mutate(current);
    const updated: RootConfig = {
      ...root,
      profiles: { ...root.profiles, [paths.profile]: next },
    };
    await saveRootConfig(paths.configFile, updated);
    return next;
  });
}

async function publicProfileView(
  paths: AppPaths,
  root: RootConfig,
  name: string,
  profile: ProfileConfig,
): Promise<PublicProfileView> {
  const selectedPaths = name === paths.profile ? paths : resolveAppPaths({ rootDir: paths.rootDir, profile: name });
  const model = publicModelStatus(await inspectEffectivePiModelConfiguration(profile, selectedPaths));
  return {
    name,
    active: root.activeProfile === name,
    appId: profile.accounts.app.id,
    tenant: profile.accounts.app.tenant,
    mode: profile.mode,
    secretConfigured: Boolean(profile.accounts.app.secret || profile.accounts.app.secretFile),
    access: {
      allowedUsers: [...profile.access.allowedUsers],
      allowedChats: [...profile.access.allowedChats],
      mentionOptionalChats: [...profile.access.mentionOptionalChats],
      admins: [...profile.access.admins],
      requireMentionInGroup: profile.access.requireMentionInGroup,
    },
    workspaces: {
      ...(profile.workspaces.defaultAlias ? { defaultAlias: profile.workspaces.defaultAlias } : {}),
      ...(profile.workspaces.defaultPath ? { defaultPath: profile.workspaces.defaultPath } : {}),
      named: { ...(profile.workspaces.named ?? {}) },
      unavailable: await unavailableWorkspaceAliases(profile.workspaces.named ?? {}),
    },
    permissions: { ...profile.permissions },
    preferences: { ...profile.preferences },
    model,
  };
}

async function requiredRoot(paths: AppPaths): Promise<RootConfig> {
  const root = await loadRootConfig(paths.configFile);
  if (!root) {
    throw new Error(`未找到配置：${paths.configFile}`);
  }
  return root;
}

export async function canonicalWorkspaceDirectory(value: string): Promise<string> {
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) {
    throw new Error('workspace 必须是绝对路径');
  }
  const path = await realpath(trimmed);
  if (!(await stat(path)).isDirectory()) {
    throw new Error(`workspace 不是目录：${path}`);
  }
  return path;
}

async function unavailableWorkspaceAliases(named: Record<string, string>): Promise<string[]> {
  const unavailable = await Promise.all(
    Object.entries(named)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([alias, path]) => ((await workspaceDirectoryAvailable(path)) ? undefined : alias)),
  );
  return unavailable.filter((alias): alias is string => alias !== undefined);
}

async function workspaceDirectoryAvailable(path: string): Promise<boolean> {
  try {
    return (await stat(await realpath(path))).isDirectory();
  } catch {
    return false;
  }
}

export function validateWorkspaceAlias(value: string): string {
  const alias = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias) || alias === 'default') {
    throw new Error('workspace alias 必须是安全名称，且不能使用保留名 default');
  }
  return alias;
}

function validateChatId(value: string): string {
  const chatId = value.trim();
  if (!/^oc_[A-Za-z0-9_-]+$/.test(chatId)) {
    throw new Error('群 chat_id 必须是 oc_ 开头的安全 ID');
  }
  return chatId;
}

function validateProfileName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    /[\s/\\:*?"<>|]/.test(name) ||
    [...name].some((character) => character.codePointAt(0)! < 32) ||
    name === '.' ||
    name === '..'
  ) {
    throw new Error(`invalid profile name: ${value}`);
  }
  return name;
}

export function publicModelStatus(status: PiModelConfigurationStatus): PublicModelStatus {
  return {
    state: status.state,
    scope: status.scope,
    ...(status.providerId ? { providerId: status.providerId } : {}),
    ...(status.modelId ? { modelId: status.modelId } : {}),
    ...(status.thinkingLevel ? { thinkingLevel: status.thinkingLevel } : {}),
    ...(status.api ? { api: status.api } : {}),
    ...(status.endpoint ? { endpoint: status.endpoint } : {}),
    ...(status.input ? { input: [...status.input] } : {}),
    credentialConfigured: status.credentialSource === 'auth.json' || status.credentialSource === 'models.json',
  };
}
