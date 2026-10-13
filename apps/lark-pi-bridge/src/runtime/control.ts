import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { WSConnectionStatus } from '@larksuite/channel';
import type { AppPaths } from '../config/app-paths.js';
import { LocalServiceController } from '../daemon/service.js';

const MAX_REQUEST_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface RuntimeActivity {
  active: number;
  starting: number;
}

export interface RuntimeControlStatus extends RuntimeActivity {
  generation: number;
  profile: string;
  ready: boolean;
  health: 'ready' | 'degraded' | 'failed';
  channel?: WSConnectionStatus;
  lastInboundTime?: number;
}

export interface RuntimeRefreshResult extends RuntimeControlStatus {
  refreshed: boolean;
  changed: boolean;
}

export interface RuntimeControlHandler {
  status(): RuntimeControlStatus | Promise<RuntimeControlStatus>;
  refresh(): Promise<RuntimeRefreshResult>;
}

export interface RuntimeControlHandle {
  close(): Promise<void>;
}

export async function startRuntimeControlServer(
  paths: AppPaths,
  handler: RuntimeControlHandler,
): Promise<RuntimeControlHandle> {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  await writeFile(paths.controlTokenFile, token, { mode: 0o600, flag: 'wx' }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    await assertOwnedControlArtifact(paths.controlTokenFile, 'token');
    await rm(paths.controlTokenFile, { force: true });
    await writeFile(paths.controlTokenFile, token, { mode: 0o600, flag: 'wx' });
  });
  await chmod(paths.controlTokenFile, 0o600);
  await removeStaleControlEndpoint(paths.controlSocketFile);
  const server = createServer({ allowHalfOpen: true }, (socket) => consumeRequest(socket, token, handler));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (process.platform === 'win32') {
      server.listen(0, '127.0.0.1', () => resolve());
    } else {
      server.listen(paths.controlSocketFile, () => resolve());
    }
  });
  if (process.platform === 'win32') {
    const address = server.address() as AddressInfo;
    await writeFile(paths.controlSocketFile, `${address.port}\n`, { mode: 0o600, flag: 'wx' });
  }
  await chmod(paths.controlSocketFile, 0o600);
  return {
    async close(): Promise<void> {
      await closeServer(server);
      await Promise.all([rm(paths.controlSocketFile, { force: true }), rm(paths.controlTokenFile, { force: true })]);
    },
  };
}

export async function runtimeControlStatus(paths: AppPaths): Promise<RuntimeControlStatus> {
  return sendRuntimeControl(paths, 'status') as Promise<RuntimeControlStatus>;
}

export async function refreshRuntime(paths: AppPaths): Promise<RuntimeRefreshResult> {
  return sendRuntimeControl(paths, 'refresh') as Promise<RuntimeRefreshResult>;
}

/**
 * Fail closed when a matching foreground PID is still live but its private
 * control endpoint is unavailable. A stopped runtime reports `undefined`.
 */
export async function optionalRuntimeControlStatus(paths: AppPaths): Promise<RuntimeControlStatus | undefined> {
  try {
    return await runtimeControlStatus(paths);
  } catch (error) {
    if (!runtimeControlUnavailable(error)) {
      throw error;
    }
    const local = await new LocalServiceController(paths.profileLockFile, `${paths.runtimeDir}/service.pid`).status();
    if (local.running) {
      throw new Error('runtime PID 存在但私有控制通道不可用；拒绝把 runtime 当作未运行处理', { cause: error });
    }
    return undefined;
  }
}

export function runtimeControlUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ENOENT' ||
    code === 'ECONNREFUSED' ||
    (error instanceof Error && error.message === 'runtime control unavailable')
  );
}

async function sendRuntimeControl(
  paths: AppPaths,
  action: 'status' | 'refresh',
): Promise<RuntimeControlStatus | RuntimeRefreshResult> {
  await assertPrivateControlFile(paths.controlTokenFile, 'token');
  if (process.platform === 'win32') {
    await assertPrivateControlFile(paths.controlSocketFile, 'port');
  }
  const token = (await readFile(paths.controlTokenFile, 'utf8')).trim();
  if (!token) {
    throw new Error(`runtime control token 为空：${paths.controlTokenFile}`);
  }
  const payload = `${JSON.stringify({ token, action })}\n`;
  return new Promise((resolve, reject) => {
    const connect = async (): Promise<Socket> => {
      if (process.platform !== 'win32') {
        return createConnection(paths.controlSocketFile);
      }
      const port = Number((await readFile(paths.controlSocketFile, 'utf8')).trim());
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
        throw new Error('runtime control port 无效');
      }
      return createConnection({ host: '127.0.0.1', port });
    };
    let socket: Socket | undefined;
    const timer = setTimeout(() => socket?.destroy(new Error('runtime control request timed out')), REQUEST_TIMEOUT_MS);
    timer.unref();
    connect()
      .then((connected) => {
        socket = connected;
        consumeResponse(connected, payload, timer, resolve, reject);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function consumeResponse(
  socket: Socket,
  payload: string,
  timer: NodeJS.Timeout,
  resolve: (value: RuntimeControlStatus | RuntimeRefreshResult) => void,
  reject: (reason: unknown) => void,
): void {
  let text = '';
  socket.setEncoding('utf8');
  socket.once('connect', () => socket.end(payload));
  socket.on('data', (chunk: string) => {
    text += chunk;
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
      socket.destroy(new Error('runtime control response too large'));
    }
  });
  socket.once('error', (error) => {
    clearTimeout(timer);
    const unavailable = new Error('runtime control unavailable', { cause: error });
    Object.assign(unavailable, { code: (error as NodeJS.ErrnoException).code });
    reject(unavailable);
  });
  socket.once('end', () => {
    clearTimeout(timer);
    try {
      const response = JSON.parse(text) as {
        ok?: boolean;
        error?: string;
        result?: RuntimeControlStatus | RuntimeRefreshResult;
      };
      if (!response.ok || !response.result) {
        throw new Error(response.error ?? 'invalid runtime control response');
      }
      resolve(response.result);
    } catch (error) {
      reject(error);
    }
  });
}

function consumeRequest(socket: Socket, token: string, handler: RuntimeControlHandler): void {
  socket.setEncoding('utf8');
  let text = '';
  const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
  timer.unref();
  socket.on('data', (chunk: string) => {
    text += chunk;
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
      socket.destroy();
    }
  });
  socket.once('end', () => {
    clearTimeout(timer);
    handleRequest(text, token, handler)
      .then((result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`))
      .catch((error) =>
        socket.end(
          `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'runtime control failure' })}\n`,
        ),
      );
  });
}

async function handleRequest(
  text: string,
  token: string,
  handler: RuntimeControlHandler,
): Promise<RuntimeControlStatus | RuntimeRefreshResult> {
  const raw = JSON.parse(text.trim()) as { token?: unknown; action?: unknown };
  if (typeof raw.token !== 'string' || !equalSecret(raw.token, token)) {
    throw new Error('runtime control authentication failed');
  }
  if (raw.action === 'status') {
    return handler.status();
  }
  if (raw.action === 'refresh') {
    return handler.refresh();
  }
  throw new Error('unsupported runtime control action');
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function removeStaleControlEndpoint(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    const valid = process.platform === 'win32' ? metadata.isFile() : metadata.isSocket();
    if (!valid || metadata.isSymbolicLink()) {
      throw new Error(`refusing to replace unsafe runtime control endpoint: ${path}`);
    }
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

async function assertOwnedControlArtifact(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`refusing to replace unsafe runtime control ${label}: ${path}`);
  }
  assertPrivateMode(metadata.mode, path);
}

async function assertPrivateControlFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`unsafe runtime control ${label}: ${path}`);
  }
  assertPrivateMode(metadata.mode, path);
}

function assertPrivateMode(mode: number, path: string): void {
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new Error(`runtime control artifact must not be accessible by group/others: ${path}`);
  }
}
