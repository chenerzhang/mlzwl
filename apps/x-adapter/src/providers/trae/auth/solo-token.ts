import fs from 'node:fs';
import path from 'node:path';
import { TraeRealm } from '../config/realm.js';
import { dataDir } from '../config/env.js';

/**
 * SOLO-identity credential management.
 *
 * The `solo_work_lite` chat pool is only reachable with a token whose OAuth
 * client is the SOLO client (`en1oxy7wnw8j9n`) — IDE-identity tokens are
 * rejected with 4120 CAN_NOT_USE_SOLO_MODE. The credential lives beside the
 * IDE credential at `<dataDir>/<realm>/solo-token.json` and is minted once by
 * the SOLO OAuth login (browser-assisted); this module only loads and renews
 * it via the Cloud-IDE ExchangeToken endpoint.
 */

export type SoloTokenRecord = {
  token: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  clientId: string;
  deviceId?: string;
  updatedAt?: string;
};

type SoloTokenFile = {
  Result?: {
    Token?: string;
    RefreshToken?: string;
    TokenExpireAt?: number;
    RefreshExpireAt?: number;
    BoundDeviceID?: string;
  };
  _clientID?: string;
  _fetchedAt?: string;
};

export const SOLO_OAUTH_CLIENT_ID = 'en1oxy7wnw8j9n';

export function soloTokenPath(realm: TraeRealm): string {
  return path.join(dataDir(), realm, 'solo-token.json');
}

function parseFile(raw: string): SoloTokenRecord | null {
  try {
    const file = JSON.parse(raw) as SoloTokenFile;
    const token = file.Result?.Token;
    const refreshToken = file.Result?.RefreshToken;
    if (typeof token !== 'string' || !token || typeof refreshToken !== 'string' || !refreshToken) {
      return null;
    }
    return {
      token,
      refreshToken,
      expiresAt: Number(file.Result?.TokenExpireAt ?? 0),
      refreshExpiresAt: Number(file.Result?.RefreshExpireAt ?? 0),
      clientId: file._clientID ?? SOLO_OAUTH_CLIENT_ID,
      deviceId: typeof file.Result?.BoundDeviceID === 'string' ? file.Result.BoundDeviceID : undefined,
      updatedAt: file._fetchedAt,
    };
  } catch {
    return null;
  }
}

export function readSoloToken(realm: TraeRealm): SoloTokenRecord | null {
  const file = soloTokenPath(realm);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseFile(raw);
}

export function writeSoloToken(realm: TraeRealm, record: SoloTokenRecord): void {
  const file = soloTokenPath(realm);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload: SoloTokenFile & { Result: Required<NonNullable<SoloTokenFile['Result']>> } = {
    Result: {
      Token: record.token,
      RefreshToken: record.refreshToken,
      TokenExpireAt: record.expiresAt,
      RefreshExpireAt: record.refreshExpiresAt,
      BoundDeviceID: record.deviceId ?? '',
    },
    _clientID: record.clientId,
    _fetchedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function soloTokenNeedsRefresh(record: SoloTokenRecord, now = Date.now()): boolean {
  if (!record.expiresAt) {
    return false;
  }
  return record.expiresAt - now < 5 * 60 * 1000;
}

/**
 * Renew the SOLO access token through the Cloud-IDE ExchangeToken endpoint.
 * The SOLO refresh token is bound to the SOLO client id; mixing in the IDE
 * client id fails with 10101 "refresh token is not matched to the client".
 */
export async function refreshSoloToken(
  realm: TraeRealm,
  record: SoloTokenRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<SoloTokenRecord> {
  const response = await fetchImpl('https://growsg-normal.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Trae/3.6.2' },
    body: JSON.stringify({
      ClientID: record.clientId || SOLO_OAUTH_CLIENT_ID,
      RefreshToken: record.refreshToken,
      ClientSecret: '-',
      UserID: '',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    Result?: { Token?: string; RefreshToken?: string; TokenExpireAt?: number; RefreshExpireAt?: number };
  } | null;
  const token = payload?.Result?.Token;
  if (!response.ok || typeof token !== 'string' || !token) {
    const error = new Error(`Trae SOLO token refresh failed with HTTP ${response.status}.`);
    (error as NodeJS.ErrnoException).code = 'solo_token_refresh_failed';
    throw error;
  }
  const next: SoloTokenRecord = {
    token,
    refreshToken: payload?.Result?.RefreshToken || record.refreshToken,
    expiresAt: Number(payload?.Result?.TokenExpireAt ?? 0),
    refreshExpiresAt: Number(payload?.Result?.RefreshExpireAt ?? record.refreshExpiresAt),
    clientId: record.clientId || SOLO_OAUTH_CLIENT_ID,
    deviceId: record.deviceId,
    updatedAt: new Date().toISOString(),
  };
  writeSoloToken(realm, next);
  return next;
}

/** Load the SOLO credential, renewing it when the access token is stale. */
export async function resolveSoloToken(
  realm: TraeRealm,
  fetchImpl: typeof fetch = fetch,
  forceRefresh = false,
): Promise<SoloTokenRecord | null> {
  const record = readSoloToken(realm);
  if (!record) {
    return null;
  }
  if (forceRefresh || soloTokenNeedsRefresh(record)) {
    return refreshSoloToken(realm, record, fetchImpl);
  }
  return record;
}
