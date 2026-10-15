import { createDecipheriv, createHash, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraeCredential, TraeDevice, readTraeCredential, writeTraeCredential } from './credential.js';
import { TraeRealm, TraeRegion, assertTraeBaseUrl, inferTraeRegion, traeRealmConfig } from '../config/realm.js';

const AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';
const DEVICE_STORAGE_PREFIX = 'iCubeAuthInfo://icube-dc:';
const MAX_STORAGE_BYTES = 16 * 1024 * 1024;
const AES_HEADER = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);
const AES_PRIVATE_HEADER = Buffer.from([18, 57, 32, 32, 2, 3]);
const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52,
  142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161,
  102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
]);
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122,
  159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126,
  186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
]);
const SALT_C = Uint8Array.from([
  191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102,
  191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55,
  62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209,
]);
const SALT_D = Uint8Array.from([
  246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244,
  207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173,
  125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170,
]);

export type TraeOfficialImportOptions = {
  storagePath?: string;
  force?: boolean;
  product?: {
    appVersion?: string;
    pluginVersion?: string;
    versionCode?: string;
    quality?: string;
  };
};

export type TraeOfficialImportResult = {
  realm: TraeRealm;
  region: TraeRegion;
  sourcePath: string;
  credential: TraeCredential;
};

export function importTraeOfficialCredential(
  realm: TraeRealm,
  options: TraeOfficialImportOptions = {},
): TraeOfficialImportResult {
  let previous: TraeCredential | null = null;
  try {
    previous = readTraeCredential(realm);
  } catch (error) {
    if (!options.force) {
      throw error;
    }
  }
  if (!options.force && previous) {
    throw importError(
      `Trae ${realm} credentials already exist. Re-run with --force to replace them.`,
      'trae_credentials_exist',
    );
  }
  const sourcePath = options.storagePath
    ? path.resolve(expandHome(options.storagePath))
    : findOfficialStoragePath(realm);
  const root = readStorageDocument(sourcePath);
  const auth = decodedObject(root[AUTH_STORAGE_KEY], 'official authentication');
  const device = importedDevice(root, realm);
  const regionSignal = firstString(
    object(auth.userRegion).region,
    object(auth.userRegion)._aiRegion,
    auth.userRegion,
    object(auth.account).userTag,
    object(auth.account).storeRegion,
  );
  assertRealmMatches(realm, regionSignal);
  const configuredRegion = inferTraeRegion(realm, regionSignal, auth.host, auth.loginHost);
  const config = traeRealmConfig(realm, configuredRegion);
  const authHost = firstString(auth.host, auth.loginHost);
  const authBaseUrl = authHost ? assertTraeBaseUrl(realm, 'auth', normalizeBase(authHost)) : config.authBaseUrl;
  const accessToken = requiredString(firstString(auth.token, auth.accessToken), realm, 'access token');
  const refreshToken = requiredString(auth.refreshToken, realm, 'refresh token');
  if (previous?.auth.refreshToken === refreshToken) {
    throw importError(
      `Trae ${realm} already stores this official refresh token. Re-import after the official client has produced a newer credential.`,
      'trae_official_credentials_unchanged',
    );
  }
  const expiresAt = timestamp(auth.expiredAt ?? auth.expiresAt) || jwtExpiresAt(accessToken);
  if (expiresAt <= 0) {
    throw importError(
      `Trae ${realm} official token expiry is missing or invalid.`,
      'invalid_trae_official_credentials',
    );
  }
  const refreshExpiresAt = timestamp(auth.refreshExpiredAt ?? auth.refreshExpiresAt);
  const account = object(auth.account);
  const credential: TraeCredential = {
    version: 1,
    source: 'official-client',
    realm,
    region: configuredRegion,
    account: {
      uid: optionalString(auth.userId),
      nickname: optionalString(account.username),
      enterpriseId: optionalString(account.organization),
    },
    auth: {
      accessToken,
      refreshToken,
      expiresAt,
      ...(refreshExpiresAt > 0 ? { refreshExpiresAt } : {}),
      clientId: config.identity.clientId,
      authBaseUrl,
    },
    product: {
      appVersion: options.product?.appVersion || config.identity.appVersion,
      pluginVersion: options.product?.pluginVersion || config.identity.pluginVersion,
      versionCode: options.product?.versionCode || config.identity.versionCode,
      quality: options.product?.quality || config.identity.quality,
    },
    device,
    updatedAt: new Date().toISOString(),
  };
  writeTraeCredential(credential);
  return {
    realm,
    region: configuredRegion,
    sourcePath,
    credential: readTraeCredential(realm) ?? credential,
  };
}

export function officialTraeStorageCandidates(realm: TraeRealm): string[] {
  const names = realm === 'global' ? ['Trae', 'TRAE', 'trae'] : ['Trae CN', 'TRAE CN', 'trae-cn'];
  const candidates: string[] = [];
  if (process.platform === 'darwin') {
    for (const name of names) {
      candidates.push(
        path.join(os.homedir(), 'Library', 'Application Support', name, 'User', 'globalStorage', 'storage.json'),
      );
    }
  } else if (process.platform === 'win32') {
    const roots = [process.env.APPDATA, path.join(os.homedir(), 'AppData', 'Roaming')].filter(
      (value): value is string => Boolean(value),
    );
    for (const root of roots) {
      for (const name of names) {
        candidates.push(path.join(root, name, 'User', 'globalStorage', 'storage.json'));
      }
    }
  } else {
    const roots = [process.env.XDG_CONFIG_HOME, path.join(os.homedir(), '.config')].filter((value): value is string =>
      Boolean(value),
    );
    for (const root of roots) {
      for (const name of names) {
        candidates.push(path.join(root, name, 'User', 'globalStorage', 'storage.json'));
      }
    }
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function findOfficialStoragePath(realm: TraeRealm): string {
  const match = officialTraeStorageCandidates(realm).find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!match) {
    throw importError(
      `Trae ${realm} official client storage was not found. Start and sign in to that client, or pass --storage <path>.`,
      'missing_trae_official_storage',
    );
  }
  return match;
}

function readStorageDocument(sourcePath: string): Record<string, unknown> {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(sourcePath, 'r');
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > MAX_STORAGE_BYTES) {
      throw importError('Trae official client storage has an invalid size or type.', 'invalid_trae_official_storage');
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw importError(
        'Trae official client storage changed while it was being read; retry.',
        'trae_official_storage_changed',
      );
    }
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid document');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (String((error as NodeJS.ErrnoException).code).startsWith('trae_')) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw importError('Trae official client storage was not found.', 'missing_trae_official_storage');
    }
    throw importError('Trae official client storage is unreadable or malformed.', 'invalid_trae_official_storage');
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function importedDevice(root: Record<string, unknown>, realm: TraeRealm): TraeDevice {
  const keys = Object.keys(root).filter((key) => key.startsWith(DEVICE_STORAGE_PREFIX));
  if (keys.length !== 1) {
    throw importError(
      'Trae official client storage does not contain exactly one registered device identity.',
      'invalid_trae_official_device',
    );
  }
  const storageKey = keys[0]!;
  const deviceId = storageKey.slice(DEVICE_STORAGE_PREFIX.length).trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(deviceId)) {
    throw importError('Trae official device ID is invalid.', 'invalid_trae_official_device');
  }
  const machineId = requiredString(root['telemetry.machineId'], realm, 'machine ID');
  const keyPair = decodedObject(root[storageKey], 'official device identity');
  const rawPrivateKey = requiredString(keyPair.privateKeyPEM, realm, 'device private key');
  const rawPublicKey = requiredString(keyPair.publicKeyPEM, realm, 'device public key');
  try {
    const privateKey = createPrivateKey(rawPrivateKey);
    const publicKey = createPublicKey(rawPublicKey);
    if (
      privateKey.asymmetricKeyType !== 'ec' ||
      publicKey.asymmetricKeyType !== 'ec' ||
      privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
      publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) {
      throw new Error('not P-256');
    }
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const expected = publicKey.export({ type: 'spki', format: 'der' });
    if (derived.length !== expected.length || !timingSafeEqual(derived, expected)) {
      throw new Error('key mismatch');
    }
    return {
      machineId,
      deviceId,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    };
  } catch {
    throw importError('Trae official device keypair is invalid or mismatched.', 'invalid_trae_official_device');
  }
}

function decodedObject(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw importError(`Trae ${label} is missing.`, 'invalid_trae_official_storage');
  }
  const text = value.trim();
  try {
    const parsed = text.startsWith('{') ? (JSON.parse(text) as unknown) : decryptStorageValue(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw importError(`Trae ${label} cannot be decoded.`, 'invalid_trae_official_storage');
  }
}

function decryptStorageValue(encoded: string): unknown {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('invalid base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 118 || (bytes.length - 38) % 16 !== 0) {
    throw new Error('invalid ciphertext length');
  }
  const header = bytes.subarray(0, 6);
  const privateCipher = header.equals(AES_PRIVATE_HEADER);
  if (!privateCipher && !header.equals(AES_HEADER)) {
    throw new Error('unsupported header');
  }
  const salt = privateCipher ? xor(SALT_C, SALT_D) : xor(SALT_A, SALT_B);
  const random = bytes.subarray(6, 38);
  const first = createHash('sha512').update(random).digest();
  const material = createHash('sha512')
    .update(Buffer.concat([first, salt]))
    .digest();
  const decipher = createDecipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const plaintext = Buffer.concat([decipher.update(bytes.subarray(38)), decipher.final()]);
  if (plaintext.length < 64) {
    throw new Error('invalid plaintext length');
  }
  const payload = plaintext.subarray(64);
  const digest = createHash('sha512').update(payload).digest();
  if (!timingSafeEqual(plaintext.subarray(0, 64), digest)) {
    throw new Error('integrity mismatch');
  }
  return JSON.parse(payload.toString('utf8')) as unknown;
}

function xor(left: Uint8Array, right: Uint8Array): Buffer {
  return Buffer.from(left.map((value, index) => value ^ (right[index] ?? 0)));
}

function assertRealmMatches(realm: TraeRealm, regionSignal: string): void {
  const normalized = regionSignal.toLowerCase();
  if ((realm === 'cn' && normalized && normalized !== 'cn') || (realm === 'global' && normalized === 'cn')) {
    throw importError(
      `The official credential belongs to a different Trae realm than ${realm}.`,
      'trae_official_realm_mismatch',
    );
  }
}

function normalizeBase(value: string): string {
  return value.includes('://') ? value : `https://${value}`;
}

function expandHome(value: string): string {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function requiredString(value: unknown, realm: TraeRealm, label: string): string {
  const text = optionalString(value);
  if (!text) {
    throw importError(`Trae ${realm} official ${label} is missing.`, 'invalid_trae_official_credentials');
  }
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string {
  return values.map(optionalString).find((value): value is string => Boolean(value)) ?? '';
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function timestamp(value: unknown): number {
  if (typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric < 1e11 ? numeric * 1000 : numeric;
}

function jwtExpiresAt(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return timestamp(payload.exp);
  } catch {
    return 0;
  }
}

function importError(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

export const __testHooks = {
  decryptStorageValue,
};
