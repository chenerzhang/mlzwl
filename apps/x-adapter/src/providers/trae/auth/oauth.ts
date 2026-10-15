import { generateKeyPairSync, randomBytes, randomUUID, createHash, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import {
  TraeCredential,
  TraeDevice,
  TraeSession,
  credentialNeedsRefresh,
  readTraeCredential,
  sessionFromCredential,
  writeTraeCredential,
} from './credential.js';
import { TraeRealm, assertTraeBaseUrl, inferTraeRegion, traeAuthTimeoutMs, traeRealmConfig } from '../config/realm.js';

export type TraeAuthEvent =
  | { type: 'auth.login.url'; realm: TraeRealm; url: string; open: () => void }
  | { type: 'auth.login.waiting'; realm: TraeRealm }
  | { type: 'auth.login.completed'; realm: TraeRealm };

export type TraeAuthOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  openBrowser?: boolean;
  onEvent?: (event: TraeAuthEvent) => void | Promise<void>;
};

type LoginCallback = {
  authCode: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  uid: string;
  nickname: string;
  enterpriseId: string;
  regionSignal: string;
  loginHost: string;
  authHost: string;
  dataHost: string;
};

type TokenExchange = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  uid: string;
  nickname: string;
  enterpriseId: string;
  regionSignal: string;
  loginHost: string;
  authHost: string;
  dataHost: string;
};

const refreshFlights = new Map<TraeRealm, Promise<TraeCredential>>();

export async function runTraeLogin(realm: TraeRealm, options: TraeAuthOptions = {}): Promise<TraeSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? traeAuthTimeoutMs();
  const initial = traeRealmConfig(realm);
  const state = randomBytes(24).toString('hex');
  const traceId = randomUUID();
  const device = createDevice();
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const loginGuidance = await requestLoginGuidance(initial, traceId, fetchImpl, timeoutMs);
  const controller = new AbortController();
  let callbackResolve: (value: LoginCallback) => void;
  let consumed = false;
  const callback = new Promise<LoginCallback>((resolve) => {
    callbackResolve = resolve;
  });
  const server = http.createServer((request, response) => {
    const originHeaders = {
      'access-control-allow-origin': initial.webBaseUrl,
      'access-control-allow-methods': 'GET, OPTIONS',
      'cache-control': 'no-store',
    };
    if (request.method === 'OPTIONS') {
      response.writeHead(204, originHeaders).end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const finish = (status: number, title: string): void => {
      response
        .writeHead(status, { ...originHeaders, 'content-type': 'text/html; charset=utf-8' })
        .end(`<!doctype html><meta charset="utf-8"><title>${title}</title><p>${title}</p>`);
    };
    if (request.method !== 'GET' || url.pathname !== '/authorize') {
      finish(404, 'Not found');
      return;
    }
    if (consumed) {
      finish(409, 'This Trae sign-in callback has already been used.');
      return;
    }
    const callbackState = url.searchParams.get('state');
    if (callbackTrace(url.searchParams) !== traceId || (callbackState !== null && callbackState !== state)) {
      finish(400, 'Trae sign-in could not be verified.');
      return;
    }
    try {
      const parsed = validateCallbackHosts(realm, parseLoginCallback(url.searchParams));
      consumed = true;
      callbackResolve(parsed);
      finish(200, 'Trae sign-in received. You can close this tab.');
    } catch {
      finish(400, 'Trae sign-in did not return a usable authorization.');
    }
  });

  try {
    await listenLoopback(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw authError('Trae callback server did not bind a loopback port.', 'trae_oauth_callback_failed');
    }
    // Trae requires this callback to be the exact /authorize URL. The current
    // Global site rejects callback URLs with a query or a different path and
    // echoes loginTraceID, but not OAuth state, in the resulting callback.
    const callbackUrl = new URL(`http://127.0.0.1:${address.port}/authorize`);
    const loginUrl = authorizationUrl(
      initial,
      loginGuidance.webBaseUrl,
      callbackUrl.toString(),
      traceId,
      state,
      challenge,
      device,
    );
    let opened = false;
    const open = (): void => {
      if (opened || options.openBrowser === false) {
        return;
      }
      opened = true;
      openBrowser(loginUrl);
    };
    await options.onEvent?.({ type: 'auth.login.url', realm, url: loginUrl, open });
    open();
    await options.onEvent?.({ type: 'auth.login.waiting', realm });
    const received = await withTimeout(callback, timeoutMs, controller.signal);
    const region = inferTraeRegion(
      realm,
      loginGuidance.regionSignal,
      loginGuidance.authHost,
      received.regionSignal,
      received.loginHost,
      received.authHost,
      received.dataHost,
    );
    const config = traeRealmConfig(realm, region);
    const exchangeConfig = {
      ...config,
      authBaseUrl: loginGuidance.authHost || config.authBaseUrl,
    };
    const exchange = received.authCode
      ? await exchangeAuthorizationCode(exchangeConfig, received, verifier, device, fetchImpl, timeoutMs)
      : callbackTokens(received);
    const merged = { ...received, ...exchange };
    const finalRegion = inferTraeRegion(
      realm,
      loginGuidance.regionSignal,
      loginGuidance.authHost,
      merged.regionSignal,
      merged.loginHost,
      merged.authHost,
      merged.dataHost,
    );
    const finalConfig = traeRealmConfig(realm, finalRegion);
    if (merged.dataHost) {
      assertTraeBaseUrl(realm, 'data', merged.dataHost);
    }
    const credential: TraeCredential = {
      version: 1,
      source: 'oauth',
      realm,
      region: finalRegion,
      account: {
        uid: merged.uid || undefined,
        nickname: merged.nickname || undefined,
        enterpriseId: merged.enterpriseId || undefined,
      },
      auth: {
        accessToken: requiredToken(merged.accessToken),
        refreshToken: requiredRefreshToken(merged.refreshToken),
        expiresAt: merged.expiresAt || jwtExpiresAt(merged.accessToken) || Date.now() + 60 * 60_000,
        ...(merged.refreshExpiresAt > 0 ? { refreshExpiresAt: merged.refreshExpiresAt } : {}),
        clientId: finalConfig.identity.clientId,
        authBaseUrl: exchangeConfig.authBaseUrl,
      },
      product: {
        appVersion: finalConfig.identity.appVersion,
        pluginVersion: finalConfig.identity.pluginVersion,
        versionCode: finalConfig.identity.versionCode,
        quality: finalConfig.identity.quality,
      },
      device,
      updatedAt: new Date().toISOString(),
    };
    writeTraeCredential(credential);
    await options.onEvent?.({ type: 'auth.login.completed', realm });
    return sessionFromCredential(credential);
  } finally {
    controller.abort();
    await closeServer(server);
  }
}

export async function resolveTraeSession(
  realm: TraeRealm,
  options: { fetchImpl?: typeof fetch; forceRefresh?: boolean } = {},
): Promise<TraeSession | null> {
  const credential = readTraeCredential(realm);
  if (!credential) {
    return null;
  }
  if (options.forceRefresh || credentialNeedsRefresh(credential)) {
    return sessionFromCredential(await refreshTraeCredential(realm, options.fetchImpl));
  }
  return sessionFromCredential(credential);
}

export function refreshTraeCredential(realm: TraeRealm, fetchImpl: typeof fetch = fetch): Promise<TraeCredential> {
  const active = refreshFlights.get(realm);
  if (active) {
    return active;
  }
  const flight = refreshCredential(realm, fetchImpl).finally(() => {
    if (refreshFlights.get(realm) === flight) {
      refreshFlights.delete(realm);
    }
  });
  refreshFlights.set(realm, flight);
  return flight;
}

async function refreshCredential(realm: TraeRealm, fetchImpl: typeof fetch): Promise<TraeCredential> {
  const previous = readTraeCredential(realm);
  if (!previous) {
    throw authError(
      `Trae ${realm} is not signed in. Run \`x-adapter trae login --realm ${realm}\`.`,
      'missing_trae_credentials',
    );
  }
  if (previous.auth.refreshExpiresAt && previous.auth.refreshExpiresAt <= Date.now()) {
    throw authError(`Trae ${realm} sign-in has expired; sign in again.`, 'expired_trae_credentials');
  }
  const config = traeRealmConfig(realm, previous.region);
  const authBaseUrl = previous.auth.authBaseUrl ?? config.authBaseUrl;
  assertTraeBaseUrl(realm, 'auth', authBaseUrl);
  const exchangePath = '/trae/api/v3/oauth/ExchangeToken';
  const response = await postJson(
    `${authBaseUrl}${exchangePath}`,
    {
      ClientID: previous.auth.clientId,
      ClientSecret: '',
      RefreshToken: previous.auth.refreshToken,
      DeviceInfo: deviceInfo(previous, config.identity),
      DeviceProof: deviceProof(exchangePath, previous),
      IDEVersion: previous.product.appVersion,
    },
    fetchImpl,
    traeAuthTimeoutMs(),
    { 'x-cloudide-token': '' },
  );
  if (!response.ok) {
    if ([400, 401, 403].includes(response.status)) {
      throw authError(`Trae ${realm} sign-in has expired; sign in again.`, 'expired_trae_credentials');
    }
    throw authError(`Trae ${realm} token refresh failed with HTTP ${response.status}.`, 'trae_refresh_failed');
  }
  const exchanged = parseTokenResponse(await response.text());
  const next: TraeCredential = {
    ...previous,
    account: {
      uid: exchanged.uid || previous.account.uid,
      nickname: exchanged.nickname || previous.account.nickname,
      enterpriseId: exchanged.enterpriseId || previous.account.enterpriseId,
    },
    auth: {
      ...previous.auth,
      accessToken: requiredToken(exchanged.accessToken),
      refreshToken: exchanged.refreshToken || previous.auth.refreshToken,
      expiresAt: exchanged.expiresAt || jwtExpiresAt(exchanged.accessToken) || Date.now() + 60 * 60_000,
      ...(exchanged.refreshExpiresAt > 0
        ? { refreshExpiresAt: exchanged.refreshExpiresAt }
        : previous.auth.refreshExpiresAt
          ? { refreshExpiresAt: previous.auth.refreshExpiresAt }
          : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  writeTraeCredential(next);
  return next;
}

type LoginGuidance = {
  webBaseUrl: string;
  authHost: string;
  regionSignal: string;
};

async function requestLoginGuidance(
  config: ReturnType<typeof traeRealmConfig>,
  traceId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<LoginGuidance> {
  const failures: string[] = [];
  for (const endpoint of config.guidanceUrls) {
    try {
      const response = await postJson(
        endpoint,
        { loginTraceID: traceId, login_trace_id: traceId },
        fetchImpl,
        timeoutMs,
      );
      if (!response.ok) {
        failures.push(String(response.status));
        continue;
      }
      const body = parseJson(await response.text());
      const candidate = deepString(body, ['LoginHost', 'loginHost', 'LoginURL', 'loginUrl']);
      if (!candidate) {
        failures.push('missing_host');
        continue;
      }
      const authCandidate = deepString(body, ['AuthHost', 'authHost', 'APIHost', 'apiHost']);
      const regionSignal = deepString(body, ['UserTag', 'userTag', 'Region', 'region', 'AIRegion', 'aiRegion']);
      return {
        webBaseUrl: assertTraeBaseUrl(config.realm, 'web', normalizeBase(candidate)),
        authHost: authCandidate
          ? assertTraeBaseUrl(config.realm, 'auth', normalizeBase(authCandidate))
          : config.authBaseUrl,
        regionSignal,
      };
    } catch (error) {
      failures.push((error as NodeJS.ErrnoException).code || 'request_failed');
    }
  }
  throw authError(`Trae ${config.realm} login guidance failed (${failures.join(', ')}).`, 'trae_login_guidance_failed');
}

function authorizationUrl(
  config: ReturnType<typeof traeRealmConfig>,
  loginBaseUrl: string,
  callbackUrl: string,
  traceId: string,
  state: string,
  challenge: string,
  device: TraeDevice,
): string {
  const url = new URL('/authorization', loginBaseUrl);
  const params: Record<string, string> = {
    login_version: '1',
    auth_from: 'trae',
    login_channel: 'native_ide',
    plugin_version: config.identity.pluginVersion,
    auth_type: 'local',
    client_id: config.identity.clientId,
    redirect: '0',
    login_trace_id: traceId,
    state,
    auth_callback_url: callbackUrl,
    machine_id: device.machineId,
    device_id: device.deviceId,
    x_device_id: device.deviceId,
    x_machine_id: device.machineId,
    x_device_brand: config.identity.deviceBrand,
    x_device_type: config.identity.deviceType,
    x_os_version: config.identity.osVersion,
    x_env: '',
    x_app_version: config.identity.appVersion,
    x_app_type: config.identity.quality,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    channel_name: 'common',
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function exchangeAuthorizationCode(
  config: ReturnType<typeof traeRealmConfig>,
  callback: LoginCallback,
  verifier: string,
  device: TraeDevice,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<TokenExchange> {
  const response = await postJson(
    `${config.authBaseUrl}/trae/api/v3/oauth/ExchangeToken`,
    {
      ClientID: config.identity.clientId,
      AuthCode: callback.authCode,
      CodeVerifier: verifier,
      IDEVersion: config.identity.appVersion,
      DeviceInfo: {
        DeviceID: device.deviceId,
        MachineID: device.machineId,
        PlatformCode: 'IDE_PC',
        DeviceType: 'PC',
        DeviceName: os.hostname(),
        DeviceModel: config.identity.deviceBrand,
        ClientVersion: config.identity.appVersion,
        DevicePublicKey: device.publicKey,
        DeviceBrand: config.identity.deviceBrand,
        DeviceCPU: '',
        OSInfo: config.identity.deviceType,
        OSVersion: config.identity.osVersion,
      },
    },
    fetchImpl,
    timeoutMs,
    { 'x-cloudide-token': '', 'user-agent': `Trae/${config.identity.appVersion}` },
  );
  const raw = await response.text();
  if (!response.ok) {
    const upstreamCode = oauthErrorCode(raw);
    if (response.status === 403 && upstreamCode === '20401') {
      throw authError(
        'Trae account device limit reached. Sign out an unused Trae device, then try again.',
        'trae_device_limit_reached',
      );
    }
    throw authError(
      `Trae ${config.realm} authorization exchange failed with HTTP ${response.status}${upstreamCode ? ` (code ${upstreamCode})` : ''}.`,
      'trae_oauth_exchange_failed',
    );
  }
  return parseTokenResponse(raw);
}

function deviceInfo(
  credential: TraeCredential,
  identity: ReturnType<typeof traeRealmConfig>['identity'],
): Record<string, string> {
  return {
    DeviceID: credential.device.deviceId,
    MachineID: credential.device.machineId,
    PlatformCode: 'IDE_PC',
    DeviceType: 'PC',
    DeviceName: os.hostname(),
    DeviceModel: identity.deviceBrand,
    ClientVersion: credential.product.appVersion,
    DevicePublicKey: credential.device.publicKey,
    DeviceBrand: identity.deviceBrand,
    DeviceCPU: '',
    OSInfo: identity.deviceType,
    OSVersion: identity.osVersion,
  };
}

function deviceProof(
  exchangePath: string,
  credential: TraeCredential,
): {
  Signature: string;
  Timestamp: number;
  Nonce: string;
} {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString('hex');
  const canonical = [
    'POST',
    exchangePath,
    credential.auth.clientId,
    credential.auth.refreshToken,
    String(timestamp),
    nonce,
  ].join('\n');
  let signature: string;
  try {
    signature = sign('sha256', Buffer.from(canonical), credential.device.privateKey).toString('base64');
  } catch {
    throw authError('Stored Trae device key is invalid; sign in again.', 'invalid_trae_credentials');
  }
  return { Signature: signature, Timestamp: timestamp, Nonce: nonce };
}

function validateCallbackHosts(realm: TraeRealm, callback: LoginCallback): LoginCallback {
  return {
    ...callback,
    loginHost: callback.loginHost ? assertTraeBaseUrl(realm, 'login', normalizeBase(callback.loginHost)) : '',
    authHost: callback.authHost ? assertTraeBaseUrl(realm, 'auth', normalizeBase(callback.authHost)) : '',
    dataHost: callback.dataHost ? assertTraeBaseUrl(realm, 'data', normalizeBase(callback.dataHost)) : '',
  };
}

function callbackTokens(callback: LoginCallback): TokenExchange {
  if (!callback.accessToken || !callback.refreshToken) {
    throw authError(
      'Trae callback did not contain an authorization code or complete token pair.',
      'trae_oauth_callback_invalid',
    );
  }
  return { ...callback };
}

function parseLoginCallback(params: URLSearchParams): LoginCallback {
  if (params.get('error')) {
    throw authError('Trae authorization was declined or failed.', 'trae_oauth_denied');
  }
  const authInfo = parseJson(params.get('authCodeInfo'));
  const userInfo = parseJson(params.get('userInfo'));
  const authCode = firstString(
    params.get('authCode'),
    authInfo.AuthCode,
    authInfo.authCode,
    authInfo.Code,
    authInfo.code,
  );
  const accessToken = firstString(params.get('userJwt'), params.get('accessToken'), authInfo.Token, authInfo.token);
  const refreshToken = firstString(params.get('refreshToken'), authInfo.RefreshToken, authInfo.refreshToken);
  if (!authCode && !(accessToken && refreshToken)) {
    throw authError('Trae callback did not contain a usable authorization.', 'trae_oauth_callback_invalid');
  }
  return {
    authCode,
    accessToken,
    refreshToken,
    expiresAt: timestamp(params.get('expiresAt') ?? authInfo.TokenExpireAt ?? authInfo.expiresAt),
    refreshExpiresAt: timestamp(authInfo.RefreshTokenExpireAt ?? authInfo.RefreshExpireAt ?? authInfo.refreshExpiresAt),
    uid: firstString(params.get('userId'), userInfo.UserID, userInfo.userId, userInfo.uid),
    nickname: firstString(userInfo.ScreenName, userInfo.screenName, userInfo.nickname),
    enterpriseId: firstString(userInfo.EnterpriseID, userInfo.enterpriseId, userInfo.TenantID, userInfo.tenantId),
    regionSignal: firstString(
      params.get('userRegion'),
      params.get('userTag'),
      params.get('region'),
      userInfo.AIRegion,
      userInfo.aiRegion,
      userInfo.UserTag,
      userInfo.userTag,
      userInfo.Region,
      userInfo.region,
    ),
    // The desktop callback's `host` describes the login service. It is
    // independently allowlisted and contributes only to region inference;
    // token exchange uses the realm/region account API selected in config.
    loginHost: firstString(params.get('host')),
    authHost: firstString(params.get('apiHost'), authInfo.APIHost, authInfo.apiHost),
    dataHost: firstString(params.get('dataHost'), userInfo.Host, userInfo.host),
  };
}

function oauthErrorCode(raw: string): string {
  const root = parseJson(raw);
  const metadata = object(root.ResponseMetadata ?? root.responseMetadata);
  const error = object(metadata.Error ?? metadata.error ?? root.Error ?? root.error);
  const candidate = error.Code ?? error.code;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return String(candidate);
  }
  if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(candidate)) {
    return candidate;
  }
  return '';
}

function parseTokenResponse(raw: string): TokenExchange {
  const root = parseJson(raw);
  const result = object(root.Result ?? root.result ?? root);
  const info = parseJson(result.UserInfo ?? result.userInfo);
  return {
    accessToken: firstString(result.Token, result.token, result.AccessToken, result.accessToken),
    refreshToken: firstString(result.RefreshToken, result.refreshToken),
    expiresAt: timestamp(result.TokenExpireAt ?? result.tokenExpireAt ?? result.ExpiresAt ?? result.expiresAt),
    refreshExpiresAt: timestamp(
      result.RefreshTokenExpireAt ?? result.RefreshExpireAt ?? result.refreshTokenExpireAt ?? result.refreshExpireAt,
    ),
    uid: firstString(info.UserID, info.userId, result.UserID, result.userId),
    nickname: firstString(info.ScreenName, info.screenName, info.nickname),
    enterpriseId: firstString(info.EnterpriseID, info.enterpriseId, info.TenantID, info.tenantId),
    regionSignal: firstString(info.UserTag, info.userTag, info.Region, info.region),
    loginHost: '',
    authHost: '',
    dataHost: firstString(info.Host, info.host),
  };
}

function createDevice(): TraeDevice {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    machineId: randomUUID(),
    deviceId: '0',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });
}

function listenLoopback(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(authError('Trae sign-in timed out.', 'trae_oauth_timeout')), timeoutMs);
    const abort = () => reject(authError('Trae sign-in was cancelled.', 'trae_oauth_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    });
  });
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // The CLI also prints the URL, so browser launch is best effort.
  }
}

function callbackTrace(params: URLSearchParams): string {
  return firstString(params.get('login_trace_id'), params.get('loginTraceID'));
}

function normalizeBase(value: string): string {
  return value.includes('://') ? value : `https://${value}`;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function deepString(root: Record<string, unknown>, keys: string[]): string {
  const wanted = new Set(keys);
  const visit = (value: unknown): string => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (wanted.has(key) && typeof child === 'string' && child.trim()) {
          return child.trim();
        }
      }
      for (const child of Object.values(value as Record<string, unknown>)) {
        const found = visit(child);
        if (found) {
          return found;
        }
      }
    } else if (Array.isArray(value)) {
      for (const child of value) {
        const found = visit(child);
        if (found) {
          return found;
        }
      }
    }
    return '';
  };
  return visit(root);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function timestamp(value: unknown): number {
  if (typeof value === 'string' && value.trim() && !/^\d+$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return number < 1e11 ? number * 1000 : number;
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

function requiredToken(value: string): string {
  if (!value) {
    throw authError('Trae token exchange did not return an access token.', 'trae_oauth_token_missing');
  }
  return value;
}

function requiredRefreshToken(value: string): string {
  if (!value) {
    throw authError('Trae token exchange did not return a refresh token.', 'trae_oauth_refresh_missing');
  }
  return value;
}

function authError(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

export const __testHooks = {
  resetRefreshFlights(): void {
    refreshFlights.clear();
  },
};
