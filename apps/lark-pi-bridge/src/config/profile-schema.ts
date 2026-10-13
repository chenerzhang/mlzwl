import type { PermissionConfig } from './permissions.js';
import { isAccessMode, normalizePermissions } from './permissions.js';

export const CURRENT_CONFIG_SCHEMA_VERSION = 3 as const;

export type AgentKind = 'pi';
export type ProfileMode = 'personal' | 'team';
export type TenantBrand = 'feishu' | 'lark';
export type PiTransport = 'spawn-per-turn' | 'rpc';
export type PiConfigScope = 'user' | 'profile';

export interface AppCredentials {
  id: string;
  /** Inline secret is accepted for programmatic and test-created profiles. */
  secret?: string;
  /** Bridge-home-relative path to a private profile-local 0600 App Secret file. */
  secretFile?: string;
  tenant: TenantBrand;
}

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  /** Authorized group chats where ordinary messages may trigger without a bot mention. */
  mentionOptionalChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
}

export interface ProfilePreferences {
  /** New profiles use the user's ordinary Pi configuration unless explicitly isolated. */
  piConfigScope: PiConfigScope;
  /** `init` supplies the product default for newly created profiles. */
  transport: PiTransport;
  model?: string;
  showToolCalls?: boolean;
  maxConcurrentRuns?: number;
  runIdleTimeoutMinutes?: number;
  agentStopGraceMs?: number;
}

export interface ProfileWorkspaces {
  /** Preferred default: an explicit pointer into named. */
  defaultAlias?: string;
  /** Direct default used when no named default alias is configured. */
  defaultPath?: string;
  /** Named workspace aliases accepted by `/workspace use <alias>`. */
  named?: Record<string, string>;
}

export interface ProfileConfig {
  schemaVersion: 3;
  agentKind: AgentKind;
  mode: ProfileMode;
  accounts: { app: AppCredentials };
  access: ProfileAccess;
  workspaces: ProfileWorkspaces;
  permissions: PermissionConfig;
  preferences: ProfilePreferences;
}

export interface RootConfig {
  schemaVersion: 3;
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
}

export interface CreateProfileInput {
  profile?: string;
  /** A direct default path, primarily for init and simple local setups. */
  workspace?: string;
  workspaces?: ProfileWorkspaces;
  app: AppCredentials;
  permissions?: Partial<PermissionConfig>;
  preferences?: Partial<ProfilePreferences>;
  access?: Partial<ProfileAccess>;
  mode?: ProfileMode;
}

export function createProfileConfig(input: CreateProfileInput): ProfileConfig {
  const mode = input.mode === 'team' ? 'team' : 'personal';
  const allowedChats = strings(input.access?.allowedChats);
  const mentionOptionalChats = [...new Set(strings(input.access?.mentionOptionalChats))];
  if (mentionOptionalChats.some((chatId) => !allowedChats.includes(chatId))) {
    throw new Error('access.mentionOptionalChats must be a subset of allowedChats');
  }
  if (mode === 'team' && mentionOptionalChats.length > 0) {
    throw new Error('access.mentionOptionalChats is only supported for personal profiles');
  }
  return {
    schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
    agentKind: 'pi',
    mode,
    accounts: { app: validateApp(input.app) },
    access: {
      allowedUsers: strings(input.access?.allowedUsers),
      allowedChats,
      mentionOptionalChats,
      admins: strings(input.access?.admins),
      requireMentionInGroup: input.access?.requireMentionInGroup ?? true,
    },
    workspaces: normalizeWorkspaces(input.workspace, input.workspaces),
    permissions: normalizePermissions(input.permissions),
    preferences: normalizePreferences(input.preferences),
  };
}

export function normalizeRootConfig(input: unknown): RootConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config must be an object');
  }
  const raw = input as { schemaVersion?: unknown; activeProfile?: unknown; profiles?: unknown };
  if (
    raw.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION ||
    typeof raw.activeProfile !== 'string' ||
    !raw.activeProfile.trim()
  ) {
    throw new Error(`config schemaVersion must be ${CURRENT_CONFIG_SCHEMA_VERSION}`);
  }
  if (!raw.profiles || typeof raw.profiles !== 'object' || Array.isArray(raw.profiles)) {
    throw new Error('profiles must be an object');
  }
  const profiles: Record<string, ProfileConfig> = {};
  for (const [name, value] of Object.entries(raw.profiles)) {
    profiles[name] = normalizeProfileConfig(value);
  }
  if (!profiles[raw.activeProfile]) {
    throw new Error('active profile not found');
  }
  return { schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION, activeProfile: raw.activeProfile, profiles };
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('profile config must be an object');
  }
  const raw = input as Partial<ProfileConfig>;
  if (raw.schemaVersion !== CURRENT_CONFIG_SCHEMA_VERSION) {
    throw new Error(`profile schemaVersion must be ${CURRENT_CONFIG_SCHEMA_VERSION}`);
  }
  if (raw.agentKind !== 'pi') {
    throw new Error('agentKind must be pi');
  }
  if (raw.permissions === undefined) {
    throw new Error('profile permissions are required');
  }
  if (
    !raw.preferences ||
    typeof raw.preferences !== 'object' ||
    (raw.preferences.piConfigScope !== 'user' && raw.preferences.piConfigScope !== 'profile')
  ) {
    throw new Error('profile preferences.piConfigScope must be user or profile');
  }
  if (raw.preferences.transport !== 'spawn-per-turn' && raw.preferences.transport !== 'rpc') {
    throw new Error('profile preferences.transport must be spawn-per-turn or rpc');
  }
  return createProfileConfig({
    app: validateApp(raw.accounts?.app),
    workspaces: raw.workspaces,
    permissions: raw.permissions,
    preferences: raw.preferences,
    access: raw.access,
    mode: raw.mode,
  });
}

export function workspaceDefault(
  workspaces: ProfileWorkspaces,
): { kind: 'alias'; alias: string; path: string } | { kind: 'direct'; path: string } | undefined {
  if (workspaces.defaultAlias) {
    const path = workspaces.named?.[workspaces.defaultAlias];
    if (!path) {
      throw new Error(`default workspace alias 不存在：${workspaces.defaultAlias}`);
    }
    return { kind: 'alias', alias: workspaces.defaultAlias, path };
  }
  return workspaces.defaultPath ? { kind: 'direct', path: workspaces.defaultPath } : undefined;
}

export { isAccessMode };

function validateApp(input: Partial<AppCredentials> | undefined): AppCredentials {
  const secret = input?.secret;
  const secretFile = input?.secretFile?.trim();
  if (
    !input?.id?.trim() ||
    (input.tenant !== 'feishu' && input.tenant !== 'lark') ||
    Boolean(secret?.trim()) === Boolean(secretFile)
  ) {
    throw new Error('accounts.app must contain exactly one of secret or secretFile');
  }
  return {
    id: input.id.trim(),
    ...(secret ? { secret } : {}),
    ...(secretFile ? { secretFile } : {}),
    tenant: input.tenant,
  };
}

function strings(input: unknown): string[] {
  return Array.isArray(input)
    ? input.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : [];
}

function normalizeWorkspaces(
  directDefault: string | undefined,
  input: ProfileWorkspaces | undefined,
): ProfileWorkspaces {
  if (directDefault?.trim() && (input?.defaultAlias || input?.defaultPath)) {
    throw new Error('workspace direct default cannot be combined with defaultAlias/defaultPath');
  }
  const defaultAlias = input?.defaultAlias?.trim();
  const defaultPath = directDefault?.trim() || input?.defaultPath?.trim();
  if (defaultAlias && defaultPath) {
    throw new Error('workspace defaultAlias and defaultPath are mutually exclusive');
  }
  const named = Object.fromEntries(
    Object.entries(input?.named ?? {}).flatMap(([name, path]) => {
      const alias = name.trim();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias) ||
        alias === 'default' ||
        typeof path !== 'string' ||
        !path.trim()
      ) {
        return [];
      }
      return [[alias, path.trim()]];
    }),
  );
  if (defaultAlias && (!isSafeWorkspaceAlias(defaultAlias) || !named[defaultAlias])) {
    throw new Error(`default workspace alias 不存在：${defaultAlias}`);
  }
  return {
    ...(defaultAlias ? { defaultAlias } : {}),
    ...(defaultPath ? { defaultPath } : {}),
    ...(Object.keys(named).length ? { named } : {}),
  };
}

function isSafeWorkspaceAlias(alias: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias) && alias !== 'default';
}

function normalizePreferences(input: Partial<ProfilePreferences> | undefined): ProfilePreferences {
  if (!input || typeof input !== 'object') {
    return { piConfigScope: 'user', transport: 'spawn-per-turn' };
  }
  if (input.piConfigScope !== undefined && input.piConfigScope !== 'user' && input.piConfigScope !== 'profile') {
    throw new Error('preferences.piConfigScope must be user or profile');
  }
  if (input.transport !== undefined && input.transport !== 'spawn-per-turn' && input.transport !== 'rpc') {
    throw new Error('preferences.transport must be spawn-per-turn or rpc');
  }
  return {
    piConfigScope: input.piConfigScope ?? 'user',
    transport: input.transport ?? 'spawn-per-turn',
    ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
    ...(typeof input.showToolCalls === 'boolean' ? { showToolCalls: input.showToolCalls } : {}),
    ...(validPositive(input.maxConcurrentRuns) ? { maxConcurrentRuns: input.maxConcurrentRuns } : {}),
    ...(validPositive(input.runIdleTimeoutMinutes) ? { runIdleTimeoutMinutes: input.runIdleTimeoutMinutes } : {}),
    ...(validPositive(input.agentStopGraceMs) ? { agentStopGraceMs: input.agentStopGraceMs } : {}),
  };
}

function validPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
