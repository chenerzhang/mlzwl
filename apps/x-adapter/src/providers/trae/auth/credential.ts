import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config/env.js';
import { TraeRealm, TraeRegion, assertTraeBaseUrl, traeRealmConfig, traeRefreshSkewMs } from '../config/realm.js';

export type TraeAccount = {
  uid?: string;
  nickname?: string;
  enterpriseId?: string;
};

export type TraeDevice = {
  machineId: string;
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

export type TraeCredential = {
  version: 1;
  source?: 'oauth' | 'official-client';
  realm: TraeRealm;
  region: TraeRegion;
  account: TraeAccount;
  auth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    refreshExpiresAt?: number;
    clientId: string;
    authBaseUrl?: string;
  };
  product: {
    appVersion: string;
    pluginVersion: string;
    versionCode: string;
    quality: string;
  };
  device: TraeDevice;
  updatedAt: string;
};

export type TraeSession = {
  realm: TraeRealm;
  region: TraeRegion;
  token: string;
  uid?: string;
  machineId: string;
  deviceId: string;
  authBaseUrl: string;
  dataBaseUrl: string;
  appVersion: string;
  pluginVersion: string;
  versionCode: string;
  quality: string;
};

export function traeCredentialPath(realm: TraeRealm): string {
  return path.join(dataDir(), realm, 'auth.json');
}

export function readTraeCredential(realm: TraeRealm): TraeCredential | null {
  const file = traeCredentialPath(realm);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw invalidCredential(realm);
  }
  try {
    const credential = parseCredential(JSON.parse(raw) as unknown, realm);
    if (process.platform !== 'win32') {
      const directoryMode = fs.statSync(path.dirname(file)).mode & 0o777;
      const fileMode = fs.statSync(file).mode & 0o777;
      if (directoryMode & 0o077 || fileMode & 0o077) {
        throw invalidCredentialPermissions(realm);
      }
    }
    return credential;
  } catch (error) {
    if (
      ['invalid_trae_credentials', 'insecure_trae_credentials'].includes(String((error as NodeJS.ErrnoException).code))
    ) {
      throw error;
    }
    throw invalidCredential(realm);
  }
}

export function writeTraeCredential(credential: TraeCredential): void {
  const validated = parseCredential(credential, credential.realm);
  const file = traeCredentialPath(validated.realm);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // POSIX modes are unavailable on some supported filesystems.
  }
  const temporary = path.join(directory, `.auth-${process.pid}-${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // rename preserves the temp file's 0600 mode. No fallible mutation occurs
    // after replacement, so a reported write failure always leaves the prior
    // complete credential in place.
    fs.renameSync(temporary, file);
    try {
      const directoryDescriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } catch {
      // Directory fsync is unsupported on some platforms; the file fsync and
      // atomic rename still prevent partial credential contents.
    }
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup; the original exception remains authoritative.
    }
  }
}

export function credentialNeedsRefresh(credential: TraeCredential, now = Date.now()): boolean {
  return credential.auth.expiresAt <= 0 || credential.auth.expiresAt - now <= traeRefreshSkewMs();
}

export function sessionFromCredential(credential: TraeCredential): TraeSession {
  const realm = traeRealmConfig(credential.realm, credential.region);
  return {
    realm: credential.realm,
    region: credential.region,
    token: credential.auth.accessToken,
    uid: credential.account.uid,
    machineId: credential.device.machineId,
    deviceId: credential.device.deviceId,
    authBaseUrl: credential.auth.authBaseUrl ?? realm.authBaseUrl,
    dataBaseUrl: realm.dataBaseUrl,
    appVersion: credential.product.appVersion,
    pluginVersion: credential.product.pluginVersion,
    versionCode: credential.product.versionCode,
    quality: credential.product.quality,
  };
}

function parseCredential(value: unknown, expectedRealm: TraeRealm): TraeCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidCredential(expectedRealm);
  }
  const input = value as Partial<TraeCredential>;
  if (input.version !== 1 || input.realm !== expectedRealm) {
    throw invalidCredential(expectedRealm);
  }
  const auth = object(input.auth);
  const device = object(input.device);
  const product = object(input.product);
  const account = object(input.account);
  const region = input.region;
  if (
    (expectedRealm === 'cn' && region !== 'cn') ||
    (expectedRealm === 'global' && !['sg', 'us'].includes(String(region)))
  ) {
    throw invalidCredential(expectedRealm);
  }
  const accessToken = requiredString(auth.accessToken, expectedRealm);
  const refreshToken = requiredString(auth.refreshToken, expectedRealm);
  const clientId = requiredString(auth.clientId, expectedRealm);
  const configuredAuthBaseUrl = optionalString(auth.authBaseUrl);
  const authBaseUrl = configuredAuthBaseUrl
    ? assertTraeBaseUrl(expectedRealm, 'auth', configuredAuthBaseUrl)
    : undefined;
  const machineId = requiredString(device.machineId, expectedRealm);
  const deviceId = requiredString(device.deviceId, expectedRealm);
  const publicKey = requiredString(device.publicKey, expectedRealm);
  const privateKey = requiredString(device.privateKey, expectedRealm);
  const expiresAt = numberValue(auth.expiresAt);
  const refreshExpiresAt = numberValue(auth.refreshExpiresAt);
  return {
    version: 1,
    ...(input.source === 'official-client' || input.source === 'oauth' ? { source: input.source } : {}),
    realm: expectedRealm,
    region: region as TraeRegion,
    account: {
      uid: optionalString(account.uid),
      nickname: optionalString(account.nickname),
      enterpriseId: optionalString(account.enterpriseId),
    },
    auth: {
      accessToken,
      refreshToken,
      expiresAt,
      ...(refreshExpiresAt > 0 ? { refreshExpiresAt } : {}),
      clientId,
      ...(authBaseUrl ? { authBaseUrl } : {}),
    },
    product: {
      appVersion: requiredString(product.appVersion, expectedRealm),
      pluginVersion: requiredString(product.pluginVersion, expectedRealm),
      versionCode: requiredString(product.versionCode, expectedRealm),
      quality: requiredString(product.quality, expectedRealm),
    },
    device: { machineId, deviceId, publicKey, privateKey },
    updatedAt: optionalString(input.updatedAt) || new Date().toISOString(),
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requiredString(value: unknown, realm: TraeRealm): string {
  const text = optionalString(value);
  if (!text) {
    throw invalidCredential(realm);
  }
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function invalidCredential(realm: TraeRealm): Error {
  const error = new Error(`Stored Trae ${realm} credential is missing or invalid; sign in again.`);
  (error as NodeJS.ErrnoException).code = 'invalid_trae_credentials';
  return error;
}

function invalidCredentialPermissions(realm: TraeRealm): Error {
  const error = new Error(`Stored Trae ${realm} credential permissions are too broad.`);
  (error as NodeJS.ErrnoException).code = 'insecure_trae_credentials';
  return error;
}
