import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolveAppPathsOptions {
  rootDir?: string;
  profile?: string;
  /** Test/in-process override. Production uses one per-user lock root across every --home. */
  appLockRoot?: string;
}

export interface AppPaths {
  rootDir: string;
  profile: string;
  profileDir: string;
  configFile: string;
  activeProfileFile: string;
  appSecretFile: string;
  registrationQrFile: string;
  sessionsFile: string;
  sessionCatalogFile: string;
  scopeSettingsFile: string;
  /** Profile-owned Pi files that must never be shared with ordinary Pi. */
  profilePiAgentDir: string;
  piSessionDir: string;
  bridgeSystemPromptFile: string;
  mediaDir: string;
  logsDir: string;
  runtimeDir: string;
  profileLockFile: string;
  controlSocketFile: string;
  controlTokenFile: string;
  connectionRetryFile: string;
  launchdManifestFile: string;
  appLockFile(appId: string): string;
}

const DEFAULT_PROFILE = 'default';

export function resolveAppPaths(opts: ResolveAppPathsOptions = {}): AppPaths {
  const rootDir = opts.rootDir ?? process.env.LARK_PI_BRIDGE_HOME ?? join(homedir(), '.lark-pi-bridge');
  const profile = normalizeProfileName(opts.profile ?? DEFAULT_PROFILE);
  const profileDir = join(rootDir, 'profiles', profile);
  const runtimeDir = join(profileDir, 'runtime');
  const appLockRoot = opts.appLockRoot ?? join(homedir(), '.lark-pi-bridge', 'runtime', 'app-locks');
  return {
    rootDir,
    profile,
    profileDir,
    configFile: join(rootDir, 'config.json'),
    activeProfileFile: join(rootDir, 'active-profile'),
    appSecretFile: join(profileDir, 'app-secret'),
    registrationQrFile: join(runtimeDir, 'app-registration-qr.png'),
    sessionsFile: join(profileDir, 'sessions.json'),
    sessionCatalogFile: join(profileDir, 'sessions.json.catalog.json'),
    scopeSettingsFile: join(profileDir, 'scope-settings.json'),
    profilePiAgentDir: join(profileDir, 'pi-agent'),
    piSessionDir: join(profileDir, 'pi-agent', 'sessions'),
    bridgeSystemPromptFile: join(profileDir, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    mediaDir: join(profileDir, 'media'),
    logsDir: join(profileDir, 'logs'),
    runtimeDir,
    profileLockFile: join(runtimeDir, 'profile.lock'),
    controlSocketFile: join(runtimeDir, process.platform === 'win32' ? 'control.port' : 'control.sock'),
    controlTokenFile: join(runtimeDir, 'control-token'),
    connectionRetryFile: join(runtimeDir, 'connection-retry.json'),
    launchdManifestFile: join(runtimeDir, `ai.x-connect.lark-pi-bridge.${profile}.plist`),
    appLockFile: (appId) => join(appLockRoot, `app-${lockSafeName(appId)}.lock`),
  };
}

function normalizeProfileName(profile: string): string {
  const trimmed = profile.trim();
  if (
    !trimmed ||
    /[\s/\\:*?"<>|]/.test(trimmed) ||
    [...trimmed].some((char) => char.codePointAt(0)! < 32) ||
    trimmed === '.' ||
    trimmed === '..'
  ) {
    throw new Error(`invalid profile name: ${profile}`);
  }
  return trimmed;
}

function lockSafeName(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
