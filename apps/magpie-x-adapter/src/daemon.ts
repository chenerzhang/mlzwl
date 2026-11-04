import { spawn } from 'node:child_process';
import { readLockOwner } from './lock.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:10100';
const HEALTH_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 30_000;
const START_POLL_INTERVAL_MS = 250;
const FAILURE_COOLDOWN_MS = 60_000;

export type XAdapterHealth = {
  ok: true;
  name: 'x-adapter';
  version: string;
  host: string;
  port: number;
};

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/**
 * The gateway address. Only a loopback http(s) origin is accepted, because
 * magpie forwards this computer's requests and x-adapter refuses to serve
 * any other host.
 *
 * A configured but invalid value is an error rather than a reason to fall back
 * to the default: silently retargeting would send the requests to whatever
 * gateway happens to run on the default port.
 */
export function baseUrl(): URL {
  const configured = process.env.X_ADAPTER_BASE_URL?.trim();
  if (!configured) {
    return new URL(DEFAULT_BASE_URL);
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('X_ADAPTER_BASE_URL is not a valid URL.');
  }
  if (url.username || url.password) {
    throw new Error('X_ADAPTER_BASE_URL must not contain a username or password. Use X_ADAPTER_CLIENT_TOKEN instead.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopbackHost(url.hostname)) {
    throw new Error('magpie-x-adapter only accepts a loopback http(s) X_ADAPTER_BASE_URL.');
  }
  if (url.pathname !== '/' && url.pathname !== '/v1' && url.pathname !== '/v1/') {
    throw new Error('X_ADAPTER_BASE_URL must not contain a custom path.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function expectedPort(base: URL): number {
  if (base.port) {
    return Number(base.port);
  }
  return base.protocol === 'https:' ? 443 : 80;
}

/** The optional local client token; it guards the data plane, not an upstream login. */
export function clientToken(): string {
  // The daemon reads its token verbatim, so do not trim a configured value.
  const value = process.env.X_ADAPTER_CLIENT_TOKEN;
  return value && value.length > 0 ? value : 'dummy-token';
}

function parseHealth(value: unknown, base: URL): XAdapterHealth | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const health = value as Record<string, unknown>;
  if (
    health.ok !== true ||
    health.name !== 'x-adapter' ||
    typeof health.version !== 'string' ||
    typeof health.host !== 'string' ||
    typeof health.port !== 'number' ||
    !Number.isFinite(health.port) ||
    !isLoopbackHost(health.host) ||
    // Direct HTTP access must identify the exact requested daemon port. An
    // HTTPS loopback URL is a user-managed reverse proxy, so its backend health
    // payload legitimately reports the daemon's HTTP port instead.
    (base.protocol === 'http:' && health.port !== expectedPort(base))
  ) {
    return undefined;
  }
  return {
    ok: true,
    name: 'x-adapter',
    version: health.version,
    host: health.host,
    port: health.port,
  };
}

export async function readHealth(base: URL): Promise<XAdapterHealth> {
  let response: Response;
  try {
    response = await fetch(`${base.origin}/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Unable to request x-adapter /health.');
  }
  if (!response.ok) {
    throw new Error(`x-adapter /health answered HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('x-adapter /health returned invalid JSON.');
  }
  const health = parseHealth(payload, base);
  if (!health) {
    throw new Error(`x-adapter /health did not identify a gateway on ${base.origin}`);
  }
  return health;
}

/**
 * What the gateway looks like right now.
 *
 * `absent` means nothing is listening, so starting one is safe. `unresponsive`
 * means something answered badly or too slowly, or the connection failed for a
 * reason that is not a refusal: a gateway may well be there and busy.
 * `x-adapter start` treats a live daemon whose control socket stays
 * unreachable as an orphan and terminates it, so the plugin must not start one
 * in that state.
 */
export type GatewayProbe =
  { state: 'healthy'; health: XAdapterHealth } | { state: 'absent' } | { state: 'unresponsive'; reason: string };

/**
 * Whether an error means "nothing is listening on this address".
 *
 * Node reports a refusal as `cause.code === 'ECONNREFUSED'`. Bun, which is what
 * magpie runs plugins on, reports it as a bare `code: 'ConnectionRefused'` with
 * no cause. Only a refusal counts: a timeout, an aborted signal, a proxy
 * failure or an unexpected status all leave the gateway possibly alive.
 *
 * Bun also reports an unresolvable host with the same code, so this is only
 * trusted for a loopback address, where resolution cannot fail.
 */
function isConnectionRefused(error: unknown): boolean {
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  const code = record?.cause?.code ?? record?.code;
  return code === 'ECONNREFUSED' || code === 'ConnectionRefused';
}

export async function probeGateway(base: URL): Promise<GatewayProbe> {
  let response: Response;
  try {
    response = await fetch(`${base.origin}/health`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (error) {
    if (isConnectionRefused(error)) {
      return { state: 'absent' };
    }
    return { state: 'unresponsive', reason: 'x-adapter /health request failed or timed out' };
  }
  if (!response.ok) {
    return { state: 'unresponsive', reason: `x-adapter /health answered HTTP ${response.status}` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { state: 'unresponsive', reason: 'x-adapter /health returned invalid JSON' };
  }
  const health = parseHealth(payload, base);
  if (!health) {
    return { state: 'unresponsive', reason: `x-adapter /health did not identify a gateway on ${base.origin}` };
  }
  return { state: 'healthy', health };
}

type StartResult = { status?: unknown; daemon?: unknown; pid?: unknown };

const CAPABILITIES_TIMEOUT_MS = 5_000;

/**
 * Whether the installed CLI can start a gateway without ever terminating a
 * running one.
 *
 * Reading the lock before starting is a check that another process can win the
 * race against, so the check alone is not a safety guarantee. The CLI's
 * `capabilities` command reports the only durable answer: whether `start`
 * supports `--no-orphan-recovery`. A CLI without it may recover an "orphan"
 * by sending SIGTERM to a live daemon, so the plugin refuses to start one.
 */
async function cliSupportsNoOrphanRecovery(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('x-adapter', ['capabilities'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      resolve(false);
    }, CAPABILITIES_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-4_096);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(false);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout);
        const capabilities = parsed as {
          noOrphanRecovery?: unknown;
          startNoOrphanRecoveryFlag?: unknown;
        };
        resolve(capabilities.noOrphanRecovery === true && capabilities.startNoOrphanRecoveryFlag === true);
      } catch {
        // An older CLI prints its usage text here instead of JSON.
        resolve(false);
      }
    });
  });
}

function startXAdapter(base: URL): Promise<StartResult> {
  const env = {
    ...process.env,
    X_ADAPTER_HOST: base.hostname.replace(/^\[|\]$/g, ''),
    X_ADAPTER_PORT: String(expectedPort(base)),
    // `x-adapter start` recovers an orphaned daemon by terminating a live one
    // whose control socket stays unreachable. Magpie's model refresh must never
    // stop a gateway other clients are using, so ask it to report the conflict
    // instead of recovering from it.
    X_ADAPTER_NO_ORPHAN_RECOVERY: '1',
  };
  return new Promise<StartResult>((resolve, reject) => {
    const child = spawn('x-adapter', ['start', '--no-orphan-recovery'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      // Stop only the CLI child created by this call, never its detached
      // daemon or another process found through the shared runtime lock.
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error('`x-adapter start` timed out after 30s. Inspect `x-adapter status` and the daemon log.'));
    }, START_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-4_096);
    });
    // Consume stderr without copying untrusted CLI output into plugin errors.
    child.stderr?.on('data', () => {});
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        error.code === 'ENOENT'
          ? new Error(
              'the `x-adapter` CLI is not on PATH; install it with `npm i -g @mlzwl/x-adapter` ' +
                'or point X_ADAPTER_BASE_URL at a running gateway',
            )
          : new Error('Unable to run `x-adapter start`. Inspect the CLI installation and daemon log.'),
      );
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(`\`x-adapter start\` exited with code ${code}. Inspect \`x-adapter status\` and the daemon log.`),
        );
        return;
      }
      resolve(parseStartOutput(stdout));
    });
  });
}

function parseStartOutput(stdout: string): StartResult {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StartResult) : {};
  } catch {
    return {};
  }
}

/**
 * `x-adapter start` reports `already_running` when a daemon holds the control
 * socket of the same data directory, even if that daemon serves another port.
 * Magpie would then wait for a port nothing answers on, so say so directly.
 */
function assertStartedOnExpectedPort(result: StartResult, base: URL): void {
  const daemon = result.daemon;
  if (typeof daemon !== 'object' || daemon === null) {
    return;
  }
  const port = (daemon as { port?: unknown }).port;
  if (typeof port !== 'number' || !Number.isFinite(port) || port === expectedPort(base)) {
    return;
  }
  throw new Error(
    `x-adapter start reported an already running gateway on port ${port}, but this plugin is set to ` +
      `${base.origin}. One data directory holds one daemon: start it on the port you want ` +
      '(`x-adapter stop` then `x-adapter start --port <port>`), or point X_ADAPTER_BASE_URL at that port.',
  );
}

async function waitForHealth(base: URL): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await probeGateway(base)).state === 'healthy') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_INTERVAL_MS));
  }
  throw new Error(
    `x-adapter did not become healthy at ${base.origin} within ${START_TIMEOUT_MS / 1000}s; ` +
      'inspect `x-adapter status` and the daemon log',
  );
}

type DaemonState = { inflight?: Promise<void>; failedAt: number; failedReason?: unknown };
// Each plugin factory captures one URL. A failure for another gateway must
// not block this one, and discarded factories must not leave permanent state.
const daemonStates = new WeakMap<URL, DaemonState>();

/**
 * Refuse to start while a live daemon holds this data directory's lock.
 *
 * `x-adapter start` recovers an orphan by terminating a live daemon whose
 * control socket stays unreachable. Older CLI releases do that unconditionally
 * and ignore `X_ADAPTER_NO_ORPHAN_RECOVERY`, so the plugin checks the lock
 * itself: a live owner is reported, never competed with. This also catches the
 * case the port probe cannot see, where the running daemon serves a different
 * port than this plugin was pointed at.
 */
function assertNoLiveLockOwner(base: URL): void {
  const owner = readLockOwner();
  if (!owner?.running) {
    return;
  }
  throw new Error(
    `an x-adapter daemon (pid ${owner.pid}) already holds this data directory's lock, but nothing answers ` +
      `as a gateway at ${base.origin}. One data directory holds one daemon: run \`x-adapter status\` to see ` +
      'where it serves, then set X_ADAPTER_BASE_URL to that address, or stop it before pointing here.',
  );
}

/**
 * Make the gateway reachable, starting it once when it is not.
 *
 * The daemon is started through its own CLI, so its lock, log and runtime
 * directories stay x-adapter's own. This plugin never stops it: magpie's
 * requests and other clients share one gateway, and a plugin has no way to
 * know whether something else still needs it.
 *
 * Only one start runs at a time. A start that fails is remembered for a
 * minute, so a listing that repeats does not spawn the CLI again on every
 * refresh.
 */
export function ensureDaemon(base: URL): Promise<void> {
  let state = daemonStates.get(base);
  if (!state) {
    state = { failedAt: 0 };
    daemonStates.set(base, state);
  }
  const current = state;
  if (current.inflight) {
    return current.inflight;
  }
  if (current.failedReason !== undefined && Date.now() - current.failedAt < FAILURE_COOLDOWN_MS) {
    return Promise.reject(current.failedReason);
  }
  current.inflight = (async () => {
    const probe = await probeGateway(base);
    if (probe.state === 'healthy') {
      return;
    }
    if (probe.state === 'unresponsive') {
      throw new Error(
        `${base.origin} answered, but not as a healthy x-adapter gateway: ${probe.reason}. ` +
          'Refusing to start another gateway that could terminate the running one; ' +
          'check `x-adapter status` first.',
      );
    }
    if (base.protocol !== 'http:') {
      throw new Error(
        `${base.origin} refused the connection, but x-adapter can only auto-start a direct HTTP loopback gateway. ` +
          'Start the HTTPS proxy yourself, or use an http:// X_ADAPTER_BASE_URL for direct daemon access.',
      );
    }
    assertNoLiveLockOwner(base);
    if (!(await cliSupportsNoOrphanRecovery())) {
      throw new Error(
        'the `x-adapter` CLI on PATH cannot start a gateway without risking a running one: ' +
          'it may terminate a live daemon it judges orphaned. Upgrade it with ' +
          '`npm i -g @mlzwl/x-adapter@latest`, or start the gateway yourself and point ' +
          'X_ADAPTER_BASE_URL at it.',
      );
    }
    assertStartedOnExpectedPort(await startXAdapter(base), base);
    await waitForHealth(base);
  })().then(
    () => {
      current.inflight = undefined;
      current.failedReason = undefined;
    },
    (error: unknown) => {
      current.inflight = undefined;
      current.failedAt = Date.now();
      current.failedReason = error;
      throw error;
    },
  );
  return current.inflight;
}
