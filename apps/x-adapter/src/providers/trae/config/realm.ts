import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env, expandHome, intEnv } from './env.js';

export const TRAE_REALMS = ['global', 'cn'] as const;
export type TraeRealm = (typeof TRAE_REALMS)[number];
export type TraeRegion = 'sg' | 'us' | 'cn';
export type TraeFunction = 'chat_v3' | 'solo_work_lite' | 'solo_agent' | 'solo_agent_lite';

export const TRAE_FUNCTIONS: readonly TraeFunction[] = ['chat_v3', 'solo_work_lite', 'solo_agent', 'solo_agent_lite'];

export type TraeProductIdentity = {
  clientId: string;
  appId: string;
  appVersion: string;
  pluginVersion: string;
  versionCode: string;
  quality: string;
  deviceBrand: string;
  deviceType: string;
  osVersion: string;
};

export type TraeRealmConfig = {
  realm: TraeRealm;
  displayName: string;
  webBaseUrl: string;
  guidanceUrls: string[];
  authBaseUrl: string;
  dataBaseUrl: string;
  identity: TraeProductIdentity;
};

type ProductJson = {
  appVersion?: unknown;
  tronBuildVersion?: unknown;
  traeVersionCode?: unknown;
  quality?: unknown;
  iCubeApp?: {
    authConfig?: {
      TRAE?: Record<string, unknown>;
    };
  };
};

const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const CLIENT_ID = 'ono9krqynydwx5';
const GLOBAL_WEB = 'https://www.trae.ai';
const CN_WEB = 'https://www.trae.cn';
const GLOBAL_SG_AUTH = 'https://growsg-normal.trae.ai';
const GLOBAL_US_AUTH = 'https://growsg-normal.trae.ai';
const CN_AUTH = 'https://api.trae.cn';
const GLOBAL_SG_DATA = 'https://coresg-normal.trae.ai';
const GLOBAL_US_DATA = 'https://coreva-normal.trae.ai';
const CN_DATA = 'https://trae-api-cn.mchost.guru';

const ALLOWED_WEB_HOSTS: Record<TraeRealm, ReadonlySet<string>> = {
  global: new Set(['www.trae.ai']),
  cn: new Set(['www.trae.cn']),
};

const ALLOWED_AUTH_HOSTS: Record<TraeRealm, ReadonlySet<string>> = {
  global: new Set(['growsg-normal.trae.ai', 'grow-normal.trae.ai', 'grow-normal.traeapi.us']),
  cn: new Set(['api.trae.cn', 'api.trae.com.cn']),
};

const ALLOWED_LOGIN_HOSTS: Record<TraeRealm, ReadonlySet<string>> = {
  global: new Set(['api-sg-central.trae.ai', 'api-us-east.trae.ai']),
  cn: new Set(['api.trae.cn', 'api.trae.com.cn']),
};

const ALLOWED_DATA_HOSTS: Record<TraeRealm, ReadonlySet<string>> = {
  global: new Set(['coresg-normal.trae.ai', 'coreva-normal.trae.ai']),
  cn: new Set(['trae-api-cn.mchost.guru']),
};

const ALLOWED_GUIDANCE_HOSTS: Record<TraeRealm, ReadonlySet<string>> = {
  global: new Set(['api.marscode.com', 'api.trae.ai', 'www.trae.ai']),
  cn: new Set(['api.trae.cn', 'api.trae.com.cn', 'www.trae.cn']),
};

function realmPrefix(realm: TraeRealm): string {
  return `X_ADAPTER_TRAE_${realm.toUpperCase()}`;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function productClientId(product: ProductJson): string {
  const group = product.iCubeApp?.authConfig?.TRAE;
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    return '';
  }
  const quality = stringValue(product.quality).toLowerCase() || 'stable';
  return stringValue(group[quality]) || stringValue(group.stable);
}

function productCandidates(realm: TraeRealm): string[] {
  const configured = env(`${realmPrefix(realm)}_PRODUCT_PATH`).trim();
  const names = realm === 'global' ? ['Trae', 'TRAE'] : ['Trae CN', 'TRAE CN'];
  const candidates = configured ? [path.resolve(expandHome(configured))] : [];
  if (process.platform === 'darwin') {
    for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      for (const name of names) {
        candidates.push(path.join(root, `${name}.app`, 'Contents', 'Resources', 'app', 'product.json'));
      }
    }
  } else if (process.platform === 'win32') {
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles]) {
      if (!root) {
        continue;
      }
      for (const name of names) {
        candidates.push(path.join(root, 'Programs', name, 'resources', 'app', 'product.json'));
        candidates.push(path.join(root, name, 'resources', 'app', 'product.json'));
      }
    }
  } else {
    for (const root of ['/opt/trae', '/opt/Trae', '/usr/share/trae', '/usr/lib/trae']) {
      candidates.push(path.join(root, 'resources', 'app', 'product.json'));
    }
  }
  return [...new Set(candidates)];
}

/** Read only the public product manifest; this configuration path never inspects account storage. */
export function installedTraeProduct(realm: TraeRealm): ProductJson | undefined {
  for (const candidate of productCandidates(realm)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const product = parsed as ProductJson;
        return {
          appVersion: stringValue(product.appVersion),
          tronBuildVersion: stringValue(product.tronBuildVersion),
          traeVersionCode: stringValue(product.traeVersionCode),
          quality: stringValue(product.quality),
          iCubeApp: { authConfig: { TRAE: product.iCubeApp?.authConfig?.TRAE } },
        };
      }
    } catch {
      // Missing or malformed product manifests are skipped; conservative
      // built-in identity values remain available for headless installations.
    }
  }
  return undefined;
}

function defaultDeviceType(): string {
  return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
}

function defaultDeviceBrand(): string {
  return process.platform === 'darwin' ? 'Apple' : process.platform === 'win32' ? 'Microsoft' : 'Linux';
}

function defaultOsVersion(): string {
  return process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
}

export function traeProductIdentity(realm: TraeRealm): TraeProductIdentity {
  const prefix = realmPrefix(realm);
  const product = installedTraeProduct(realm);
  const fallbackVersion = realm === 'global' ? '3.6.2' : '3.4.2';
  const fallbackPlugin = realm === 'global' ? '2.3.91093' : '2.3.91092';
  return {
    clientId: env(`${prefix}_CLIENT_ID`, productClientId(product ?? {}) || CLIENT_ID).trim() || CLIENT_ID,
    appId: env(`${prefix}_APP_ID`, APP_ID).trim() || APP_ID,
    appVersion:
      env(`${prefix}_APP_VERSION`, stringValue(product?.appVersion) || fallbackVersion).trim() || fallbackVersion,
    pluginVersion:
      env(`${prefix}_PLUGIN_VERSION`, stringValue(product?.tronBuildVersion) || fallbackPlugin).trim() ||
      fallbackPlugin,
    versionCode:
      env(`${prefix}_VERSION_CODE`, stringValue(product?.traeVersionCode) || '20260917').trim() || '20260917',
    quality: env(`${prefix}_QUALITY`, stringValue(product?.quality) || 'stable').trim() || 'stable',
    deviceBrand: env(`${prefix}_DEVICE_BRAND`, defaultDeviceBrand()).trim() || defaultDeviceBrand(),
    deviceType: env(`${prefix}_DEVICE_TYPE`, defaultDeviceType()).trim() || defaultDeviceType(),
    osVersion: env(`${prefix}_OS_VERSION`, defaultOsVersion()).trim() || defaultOsVersion(),
  };
}

function configuredHttpsBaseUrl(name: string, fallback: string, allowed: ReadonlySet<string>): string {
  const raw = env(name, fallback).trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidHost(name);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/, '') !== ''
  ) {
    throw invalidHost(name);
  }
  if (!allowed.has(parsed.hostname.toLowerCase())) {
    throw invalidHost(name);
  }
  parsed.pathname = '';
  return parsed.toString().replace(/\/$/, '');
}

function invalidHost(name: string): Error {
  const error = new Error(`${name} must use an approved Trae HTTPS host.`);
  (error as NodeJS.ErrnoException).code = 'invalid_trae_host';
  return error;
}

export function traeRealmConfig(realm: TraeRealm, region?: TraeRegion): TraeRealmConfig {
  const prefix = realmPrefix(realm);
  const normalizedRegion = realm === 'cn' ? 'cn' : region === 'us' ? 'us' : 'sg';
  const defaults =
    realm === 'global'
      ? {
          displayName: 'Trae Global',
          web: GLOBAL_WEB,
          auth: normalizedRegion === 'us' ? GLOBAL_US_AUTH : GLOBAL_SG_AUTH,
          data: normalizedRegion === 'us' ? GLOBAL_US_DATA : GLOBAL_SG_DATA,
          guidance: [
            'https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance',
            'https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance',
            'https://www.trae.ai/cloudide/api/v3/trae/GetLoginGuidance',
          ],
        }
      : {
          displayName: 'Trae CN',
          web: CN_WEB,
          auth: CN_AUTH,
          data: CN_DATA,
          guidance: [
            'https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance',
            'https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance',
            'https://www.trae.cn/cloudide/api/v3/trae/GetLoginGuidance',
          ],
        };
  const guidanceOverride = env(`${prefix}_GUIDANCE_URL`).trim();
  const guidanceUrls = guidanceOverride
    ? [configuredHttpsEndpoint(`${prefix}_GUIDANCE_URL`, guidanceOverride, ALLOWED_GUIDANCE_HOSTS[realm])]
    : defaults.guidance;
  return {
    realm,
    displayName: defaults.displayName,
    webBaseUrl: configuredHttpsBaseUrl(`${prefix}_WEB_BASE_URL`, defaults.web, ALLOWED_WEB_HOSTS[realm]),
    guidanceUrls,
    authBaseUrl: configuredHttpsBaseUrl(`${prefix}_AUTH_BASE_URL`, defaults.auth, ALLOWED_AUTH_HOSTS[realm]),
    dataBaseUrl: configuredHttpsBaseUrl(`${prefix}_DATA_BASE_URL`, defaults.data, ALLOWED_DATA_HOSTS[realm]),
    identity: traeProductIdentity(realm),
  };
}

function configuredHttpsEndpoint(name: string, value: string, allowed: ReadonlySet<string>): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidHost(name);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !allowed.has(parsed.hostname.toLowerCase()) ||
    !/^\/cloudide\/api\/v3\/trae\/GetLoginGuidance\/?$/.test(parsed.pathname)
  ) {
    throw invalidHost(name);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

export function assertTraeBaseUrl(realm: TraeRealm, kind: 'web' | 'auth' | 'login' | 'data', value: string): string {
  const allowed =
    kind === 'web'
      ? ALLOWED_WEB_HOSTS[realm]
      : kind === 'auth'
        ? ALLOWED_AUTH_HOSTS[realm]
        : kind === 'login'
          ? ALLOWED_LOGIN_HOSTS[realm]
          : ALLOWED_DATA_HOSTS[realm];
  return configuredHttpsBaseUrl(`Trae ${realm} ${kind} URL`, value, allowed);
}

export function inferTraeRegion(realm: TraeRealm, ...signals: unknown[]): TraeRegion {
  if (realm === 'cn') {
    return 'cn';
  }
  const joined = signals
    .flatMap((value) => (typeof value === 'string' ? [value] : []))
    .join(' ')
    .toLowerCase();
  if (/\busttp\b|\bus[_-]?ttp\b|coreva|traeapi\.us|api-us|\bus\b/.test(joined)) {
    return 'us';
  }
  return 'sg';
}

export function traeAuthTimeoutMs(): number {
  return intEnv('X_ADAPTER_TRAE_AUTH_TIMEOUT_MS', 120_000);
}

export function traeRefreshSkewMs(): number {
  return intEnv('X_ADAPTER_TRAE_REFRESH_SKEW_MS', 5 * 60_000);
}
