import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppPaths } from '../config/app-paths.js';
import { resolveAppPaths } from '../config/app-paths.js';
import {
  activateProfile,
  configureProfileModel,
  getPublicProfile,
  listPublicProfiles,
  removeWorkspace,
  setDefaultWorkspace,
  setWorkspace,
  publicModelStatus,
  updateProfileMentionOptionalChat,
  updateProfilePermissions,
  updateProfilePiConfigScope,
  updateProfileTransport,
} from '../config/profile-management.js';
import type { CompatiblePiApi } from '../config/pi-models.js';
import { loadRootConfig } from '../config/store.js';
import { LocalServiceController } from '../daemon/service.js';
import { createRuntimeAgent } from '../runtime/agent-runtime.js';
import { optionalRuntimeControlStatus, refreshRuntime } from '../runtime/control.js';
import { runDoctor, type DoctorCheck } from '../cli/doctor.js';
import {
  assertBrowserApiRequest,
  assertLoopbackRequest,
  equalToken,
  readCookie,
  readJsonBody,
  requireJsonContentType,
  sendHtml,
  sendJson,
  WebHttpError,
} from './http.js';
import { renderWebConsole } from './view.js';

const SESSION_COOKIE = 'lark-pi-bridge-session';
const REQUEST_ID_LIMIT = 1_024;
const REQUEST_ID_TTL_MS = 10 * 60_000;

export interface WebConsoleOptions {
  rootDir?: string;
  port?: number;
  piBin?: string;
  /** Test-only path isolation for the per-user App ID lock. */
  appLockRoot?: string;
}

export interface WebConsoleHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface WebSession {
  cookie: string;
  csrf: string;
  nonce: string;
}

export async function startWebConsole(options: WebConsoleOptions = {}): Promise<WebConsoleHandle> {
  const session: WebSession = {
    cookie: randomBytes(32).toString('base64url'),
    csrf: randomBytes(32).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
  };
  const requestIds = new RequestIdCache();
  const server = createServer((request, response) => {
    handleRequest(request, response, options, session, requestIds).catch((error) => {
      const status = error instanceof WebHttpError ? error.status : 500;
      const message = error instanceof WebHttpError ? error.message : 'internal error';
      if (!response.headersSent) {
        sendJson(response, status, { error: message });
      } else {
        response.end();
      }
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebConsoleOptions,
  session: WebSession,
  requestIds: RequestIdCache,
): Promise<void> {
  assertLoopbackRequest(request);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/' && request.method === 'GET') {
    sendHtml(
      response,
      renderWebConsole({ csrfToken: session.csrf, nonce: session.nonce }),
      session.nonce,
      `${SESSION_COOKIE}=${session.cookie}; Path=/; HttpOnly; SameSite=Strict`,
    );
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  assertBrowserApiRequest(request);
  if (!equalToken(readCookie(request, SESSION_COOKIE), session.cookie)) {
    throw new WebHttpError(401, 'invalid session');
  }
  if (!equalToken(header(request, 'x-csrf-token'), session.csrf)) {
    throw new WebHttpError(403, 'invalid CSRF token');
  }
  const method = request.method ?? 'GET';
  const mutation = method !== 'GET' && method !== 'HEAD';
  if (mutation && !request.headers.origin) {
    throw new WebHttpError(403, 'mutation requires Origin');
  }
  if (mutation) {
    requireJsonContentType(request);
    requestIds.accept(header(request, 'x-request-id'));
  }
  await route(request, response, options, url);
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebConsoleOptions,
  url: URL,
): Promise<void> {
  const method = request.method ?? 'GET';
  const path = url.pathname;
  const paths = await selectedPaths(options, url.searchParams.get('profile') ?? undefined);

  if (method === 'GET' && path === '/api/status') {
    const profiles = await listPublicProfiles(paths);
    const local = await new LocalServiceController(paths.profileLockFile, `${paths.runtimeDir}/service.pid`).status();
    let runtime: Awaited<ReturnType<typeof optionalRuntimeControlStatus>> | { ready: false; error: string };
    try {
      runtime = await optionalRuntimeControlStatus(paths);
    } catch {
      runtime = local.running ? { ready: false, error: 'runtime control unavailable' } : undefined;
    }
    sendJson(response, 200, {
      loopback: true,
      activeProfile: profiles.find((item) => item.active)?.name,
      profileCount: profiles.length,
      localForeground: { ...local, ...(runtime ? { runtime } : {}) },
      registration: {
        available: false,
        reason: '请在本机终端运行 lark-pi-bridge init --register；短效授权 URL 不进入 Web 控制面。',
      },
    });
    return;
  }
  if (method === 'GET' && path === '/api/profiles') {
    sendJson(response, 200, { profiles: await listPublicProfiles(paths) });
    return;
  }
  if (method === 'GET' && path === '/api/profile') {
    sendJson(response, 200, await getPublicProfile(paths));
    return;
  }
  if (method === 'POST' && path === '/api/profile/activate') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['profile']);
    await managedMutation(() => activateProfile(paths, requiredString(body.profile, 'profile')));
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === 'POST' && path === '/api/workspaces/set') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['alias', 'path']);
    const result = await managedMutation(() =>
      setWorkspace(paths, {
        alias: requiredString(body.alias, 'alias'),
        path: requiredString(body.path, 'path'),
      }),
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/workspaces/default') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['alias']);
    const selected = await managedMutation(() => setDefaultWorkspace(paths, requiredString(body.alias, 'alias')));
    sendJson(response, 200, { ok: true, default: selected });
    return;
  }
  if (method === 'POST' && path === '/api/workspaces/remove') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['alias']);
    await managedMutation(() => removeWorkspace(paths, requiredString(body.alias, 'alias')));
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === 'POST' && path === '/api/runtime/refresh') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, []);
    try {
      sendJson(response, 200, await refreshRuntime(paths));
    } catch {
      throw new WebHttpError(409, 'runtime refresh unavailable or busy');
    }
    return;
  }
  if (method === 'POST' && path === '/api/pi-config-scope') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['scope']);
    const scope = requiredString(body.scope, 'scope');
    if (scope !== 'user' && scope !== 'profile') {
      throw new WebHttpError(400, 'unsupported Pi config scope');
    }
    await managedMutation(() => updateProfilePiConfigScope(paths, scope));
    sendJson(response, 200, { ok: true, profile: paths.profile, piConfigScope: scope });
    return;
  }
  if (method === 'POST' && path === '/api/transport') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['transport']);
    const transport = requiredString(body.transport, 'transport');
    if (transport !== 'spawn-per-turn' && transport !== 'rpc') {
      throw new WebHttpError(400, 'unsupported transport');
    }
    await managedMutation(() => updateProfileTransport(paths, transport));
    sendJson(response, 200, { ok: true, profile: paths.profile, transport });
    return;
  }
  if (method === 'POST' && path === '/api/mention-optional') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['chatId', 'enabled']);
    if (typeof body.enabled !== 'boolean') {
      throw new WebHttpError(400, 'enabled must be boolean');
    }
    sendJson(response, 200, {
      ok: true,
      ...(await managedMutation(() =>
        updateProfileMentionOptionalChat(paths, requiredString(body.chatId, 'chatId'), body.enabled as boolean),
      )),
      refreshRequired: true,
    });
    return;
  }
  if (method === 'POST' && path === '/api/permissions') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['defaultAccess', 'maxAccess']);
    sendJson(response, 200, {
      ok: true,
      permissions: await managedMutation(() =>
        updateProfilePermissions(paths, {
          defaultAccess: body.defaultAccess,
          maxAccess: body.maxAccess,
        }),
      ),
    });
    return;
  }
  if (method === 'POST' && path === '/api/model') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['providerId', 'modelId', 'baseUrl', 'api', 'input']);
    const api = compatibleApi(requiredString(body.api, 'api'));
    await managedMutation(() =>
      configureProfileModel(paths, {
        providerId: requiredString(body.providerId, 'providerId'),
        modelId: requiredString(body.modelId, 'modelId'),
        baseUrl: requiredString(body.baseUrl, 'baseUrl'),
        api,
        input: modelInput(body.input),
      }),
    );
    sendJson(response, 200, { ok: true, profile: await getPublicProfile(paths) });
    return;
  }
  if (method === 'POST' && path === '/api/doctor') {
    const body = await readJsonBody(request);
    assertOnlyKeys(body, ['checkProvider']);
    const { profile } = await requiredProfile(paths);
    const agent = createRuntimeAgent(profile, paths, options.piBin);
    const report = await runDoctor(paths, profile, agent, { checkProvider: body.checkProvider === true });
    sendJson(response, 200, {
      ok: report.ok,
      profile: report.profile,
      checks: report.checks.map(publicDoctorCheck),
      model: publicModelStatus(report.model),
    });
    return;
  }
  throw new WebHttpError(404, 'not found');
}

async function selectedPaths(options: WebConsoleOptions, requestedProfile?: string): Promise<AppPaths> {
  if (requestedProfile) {
    return resolveAppPaths({ ...options, profile: requestedProfile });
  }
  const initial = resolveAppPaths(options);
  const root = await loadRootConfig(initial.configFile);
  return root ? resolveAppPaths({ ...options, profile: root.activeProfile }) : initial;
}

async function requiredProfile(paths: AppPaths) {
  const root = await loadRootConfig(paths.configFile);
  const profile = root?.profiles[paths.profile];
  if (!root || !profile) {
    throw new WebHttpError(404, `profile 不存在：${paths.profile}`);
  }
  return { root, profile };
}

class RequestIdCache {
  private readonly seen = new Map<string, number>();

  accept(value: string | undefined): void {
    const now = Date.now();
    for (const [id, timestamp] of this.seen) {
      if (now - timestamp > REQUEST_ID_TTL_MS) {
        this.seen.delete(id);
      }
    }
    if (!value || !isUuid(value)) {
      throw new WebHttpError(400, 'x-request-id must be a UUID');
    }
    if (this.seen.has(value)) {
      throw new WebHttpError(409, 'duplicate request');
    }
    this.seen.set(value, now);
    while (this.seen.size > REQUEST_ID_LIMIT) {
      this.seen.delete(this.seen.keys().next().value!);
    }
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WebHttpError(400, `${name} is required`);
  }
  return value.trim();
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new WebHttpError(400, `unsupported request field: ${unknown[0]}`);
  }
}

function modelInput(value: unknown): Array<'text' | 'image'> {
  const input = value === undefined ? 'text' : requiredString(value, 'input');
  if (input === 'text') {
    return ['text'];
  }
  if (input === 'text,image') {
    return ['text', 'image'];
  }
  throw new WebHttpError(400, 'unsupported model input');
}

function compatibleApi(value: string): CompatiblePiApi {
  if (value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages') {
    return value;
  }
  throw new WebHttpError(400, 'unsupported model API');
}

async function managedMutation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new WebHttpError(400, 'invalid management request');
  }
}

function publicDoctorCheck(check: DoctorCheck): DoctorCheck {
  const detail: Record<DoctorCheck['name'], Record<DoctorCheck['status'], string>> = {
    config: {
      pass: 'profile schema is valid',
      warn: 'profile schema needs attention',
      fail: 'profile schema is invalid',
      skipped: 'profile schema check was skipped',
    },
    app_secret: {
      pass: 'profile-local App Secret is configured and private',
      warn: 'App Secret configuration needs attention',
      fail: 'App Secret is missing, invalid, or not private',
      skipped: 'App Secret check was skipped',
    },
    pi_capability: {
      pass: /^Pi \d+\.\d+\.\d+$/.test(check.detail) ? check.detail : 'Pi is compatible',
      warn: 'Pi compatibility needs attention',
      fail: 'Pi capability check failed',
      skipped: 'Pi capability check was skipped',
    },
    provider_reachability: {
      pass: 'provider TCP endpoint is reachable',
      warn: 'provider reachability needs attention',
      fail: 'provider TCP endpoint is unreachable or invalid',
      skipped: 'not requested; no network connection was attempted',
    },
    model_credentials: {
      pass: 'model credential check passed',
      warn: 'model credential status needs attention',
      fail: 'model credential check failed',
      skipped: 'not requested; no model request was made',
    },
  };
  return { name: check.name, status: check.status, detail: detail[check.name][check.status] };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
