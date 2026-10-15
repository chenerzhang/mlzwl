import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { doubaoBaseUrl, doubaoDataDir, doubaoTimeoutSignal, env } from '../config/env.js';
import { doubaoConfigPath } from '../config/file.js';
import { DOUBAO_COMMON_QUERY_KEYS, DoubaoCredential, saveDoubaoCredential } from './doubao-cookie.js';
import { FetchLike, doubaoHeaders, doubaoUrl, jsonResponse, uuid } from '../upstream/client.js';

const CHROME_CANDIDATES_MAC = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];
const CHROME_CANDIDATES_LINUX = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
];

export type DoubaoLoginOptions = { chrome?: string; timeoutMs?: number; noSave?: boolean; verbose?: boolean };

export async function runDoubaoBrowserLogin(
  options: DoubaoLoginOptions = {},
): Promise<{ ok: true; cookieCount: number; cookieBytes: number; queryKeys: string[]; configPath?: string }> {
  const chrome = options.chrome || detectChromeBinary();
  if (!chrome) {
    throw new Error('Chrome/Chromium not found. Pass --chrome /path/to/chrome.');
  }
  const port = await freePort();
  const profileRoot = doubaoDataDir();
  mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  chmodSync(profileRoot, 0o700);
  // A login is explicitly interactive. Reusing a profile makes a previously
  // authenticated browser finish immediately and, more importantly, lets a
  // stale anonymous browser state affect a new login attempt.
  const profile = mkdtempSync(path.join(profileRoot, 'login-'));
  chmodSync(profile, 0o700);
  const child = spawn(
    chrome,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      '--new-window',
      `${doubaoBaseUrl()}/chat/`,
    ],
    { stdio: 'ignore' },
  );
  let stopping = false;
  let browserFailure = '';
  child.once('error', (error) => {
    browserFailure = `Chrome failed to start: ${error.message}`;
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      browserFailure = `Doubao Work login browser closed (${signal ?? code ?? 'unknown'}).`;
    }
  });
  process.stderr.write(
    'Complete sign-in in the opened Doubao Work browser; it will close after authentication is verified.\n',
  );
  try {
    const credential = await waitForCredential(
      port,
      options.timeoutMs ?? Number(env('DOUBAO_LOGIN_TIMEOUT_MS', '180000')),
      options.verbose,
      () => browserFailure,
    );
    if (!options.noSave) {
      saveDoubaoCredential(credential.cookie, credential.commonQuery, credential.userAgent);
    }
    return {
      ok: true,
      cookieCount: credential.summary.cookieCount,
      cookieBytes: credential.summary.cookieBytes,
      queryKeys: credential.summary.queryKeys,
      configPath: options.noSave ? undefined : doubaoConfigPath(),
    };
  } finally {
    stopping = true;
    await closeBrowser(child);
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function waitForCredential(
  port: number,
  timeoutMs: number,
  verbose = false,
  browserFailure: () => string = () => '',
): Promise<DoubaoCredential> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    if (browserFailure()) {
      throw new Error(browserFailure());
    }
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
      const tab = targets.find((item: any) => item.type === 'page' && String(item.url).startsWith(doubaoBaseUrl()));
      if (!tab?.webSocketDebuggerUrl) {
        throw new Error('Doubao page is not ready');
      }
      const cdp = await CdpConnection.connect(tab.webSocketDebuggerUrl);
      try {
        const loginState = await cdp.send('Runtime.evaluate', {
          expression: `(() => ({
            loggedIn: localStorage.getItem('flow_web_has_login') === 'true',
            userId: localStorage.getItem('flow_tea_user_id') || '',
          }))()`,
          returnByValue: true,
        });
        if (!isDoubaoPageLoggedIn(loginState?.result?.value)) {
          lastError = 'waiting for page sign-in';
        } else {
          const [cookies, navigatorResult, queryResult] = await Promise.all([
            readDoubaoCookiesFromCdp(port, cdp),
            cdp.send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }),
            cdp.send('Runtime.evaluate', {
              expression: `(() => {
              const entries = performance.getEntriesByType('resource').map(entry => entry.name);
              const latest = [...entries].reverse().find(url => url.includes('/chat/completion?'))
                || [...entries].reverse().find(url => url.includes('version_code=20800') && url.includes('device_id='));
              if (!latest) return {};
              const source = new URL(latest);
              const allowed = ${JSON.stringify(DOUBAO_COMMON_QUERY_KEYS)};
              return Object.fromEntries(allowed.flatMap(key => source.searchParams.has(key) ? [[key, source.searchParams.get(key)]] : []));
            })()`,
              returnByValue: true,
            }),
          ]);
          const selected = doubaoDomainCookies(cookies);
          const cookie = buildDoubaoCookieHeader(cookies);
          const commonQuery = queryResult?.result?.value ?? {};
          const userAgent = String(navigatorResult?.result?.value ?? '');
          if (!cookie) {
            throw new Error('browser state is not ready');
          }
          const credential: DoubaoCredential = {
            cookie,
            source: 'env',
            userAgent,
            commonQuery,
            summary: {
              cookieCount: selected.length,
              cookieBytes: Buffer.byteLength(cookie, 'utf8'),
              queryKeys: Object.keys(commonQuery).sort(),
            },
          };
          if (await validateDoubaoCredential(credential)) {
            return credential;
          }
          lastError = 'browser state found but validation failed';
        }
      } finally {
        cdp.close();
      }
    } catch (error) {
      if (browserFailure()) {
        throw new Error(browserFailure(), { cause: error });
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (verbose) {
      process.stderr.write(`Waiting for Doubao Work login: ${lastError}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Timed out waiting for Doubao Work login. Last state: ${lastError || 'unknown'}`);
}

export function isDoubaoPageLoggedIn(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const state = value as Record<string, unknown>;
  return state.loggedIn === true && typeof state.userId === 'string' && state.userId.trim().length > 0;
}

export function doubaoDomainCookies(cookies: unknown[]): Array<{ name: string; value: string }> {
  const selected: Array<{ name: string; value: string }> = [];
  const seenNames = new Set<string>();
  for (const raw of cookies) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const cookie = raw as Record<string, unknown>;
    const domain = String(cookie.domain ?? '')
      .replace(/^\./, '')
      .toLowerCase();
    const cookiePath = typeof cookie.path === 'string' ? cookie.path : '';
    if (
      typeof cookie.name !== 'string' ||
      typeof cookie.value !== 'string' ||
      !cookie.value ||
      seenNames.has(cookie.name) ||
      !isCookieDomainApplicable(domain) ||
      !isCookiePathApplicable(cookiePath)
    ) {
      continue;
    }
    seenNames.add(cookie.name);
    selected.push({ name: cookie.name, value: cookie.value });
  }
  return selected;
}

function isCookieDomainApplicable(domain: string): boolean {
  return domain === 'doubao.com' || domain === 'www.doubao.com';
}

function isCookiePathApplicable(cookiePath: string): boolean {
  if (!cookiePath || cookiePath === '/') {
    return true;
  }
  return ['/chat/completion', '/im/chain/recent_conv'].every(
    (requestPath) =>
      requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`),
  );
}

export function buildDoubaoCookieHeader(cookies: unknown[]): string {
  return doubaoDomainCookies(cookies)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export async function validateDoubaoCredential(
  credential: DoubaoCredential,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(doubaoUrl('/im/chain/recent_conv', credential), {
      method: 'POST',
      headers: doubaoHeaders(credential),
      body: JSON.stringify({
        cmd: 3200,
        uplink_body: {
          pull_recent_conv_chain_uplink_body: {
            limit: 1,
            filter: { conversation_type: [], project_filter: 0, device_filter: 1 },
            message_count_per_conv: 0,
            api_version: 1,
            conv_version: 0,
            direction: 3,
            option: { not_need_message: true, need_complete_conversation: true, exclude_archive: true },
          },
        },
        sequence_id: uuid(),
        channel: 2,
        version: '1',
      }),
      signal: doubaoTimeoutSignal(),
    });
    await jsonResponse(response, 'Doubao credential validation');
    // Authentication validation is intentionally independent from model
    // discovery. A valid login must remain saveable for a new account and when
    // the action-bar catalog is temporarily unavailable.
    return true;
  } catch {
    return false;
  }
}

async function readDoubaoCookiesFromCdp(port: number, page: CdpConnection): Promise<unknown[]> {
  try {
    const version = await fetchJsonObject(`http://127.0.0.1:${port}/json/version`);
    if (typeof version.webSocketDebuggerUrl === 'string' && version.webSocketDebuggerUrl) {
      const browser = await CdpConnection.connect(version.webSocketDebuggerUrl);
      try {
        const result = await browser.send('Storage.getCookies');
        if (Array.isArray(result?.cookies)) {
          return result.cookies;
        }
      } finally {
        browser.close();
      }
    }
  } catch {
    // Older Chromium builds may not expose browser-target Storage.getCookies.
  }
  const all = await page.send('Network.getAllCookies').catch(() => null);
  if (Array.isArray(all?.cookies)) {
    return all.cookies;
  }
  const scoped = await page.send('Network.getCookies', { urls: [doubaoBaseUrl()] });
  return Array.isArray(scoped?.cookies) ? scoped.cookies : [];
}

class CdpConnection {
  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('Failed to connect to Chrome DevTools Protocol.')), {
        once: true,
      });
    });
  }

  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const handler = this.pending.get(message.id);
      if (!handler) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        handler.reject(new Error(message.error.message || 'CDP command failed'));
      } else {
        handler.resolve(message.result ?? {});
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10_000).unref();
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function closeBrowser(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve();
    };
    const termTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 3_000);
    const killTimer = setTimeout(finish, 4_000);
    termTimer.unref();
    killTimer.unref();
    child.once('exit', finish);
    child.kill('SIGTERM');
  });
}

function detectChromeBinary(): string {
  if (process.platform === 'darwin') {
    return CHROME_CANDIDATES_MAC.find(existsSync) ?? '';
  }
  for (const command of CHROME_CANDIDATES_LINUX) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const candidate = path.join(directory, command);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return '';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        address && typeof address === 'object' ? resolve(address.port) : reject(new Error('Failed to allocate port')),
      );
    });
    server.on('error', reject);
  });
}

async function fetchJson(url: string): Promise<any[]> {
  const payload = await fetchJsonObject(url);
  return Array.isArray(payload) ? payload : [];
}

async function fetchJsonObject(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return response.json();
}
