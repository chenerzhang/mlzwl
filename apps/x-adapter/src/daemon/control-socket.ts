import fs from 'node:fs';
import net from 'node:net';
import { ensureRuntimePaths, getRuntimePaths } from './runtime-paths.js';

export type ControlRequest = { command?: string; args?: Record<string, unknown> };
export type ControlHandler = (request: ControlRequest) => Promise<unknown> | unknown;

function encode(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function startControlServer(handler: ControlHandler): net.Server {
  const paths = ensureRuntimePaths();
  try {
    fs.unlinkSync(paths.socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) {
          return;
        }
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) {
          continue;
        }
        let request: ControlRequest;
        try {
          request = JSON.parse(line) as ControlRequest;
        } catch {
          socket.write(
            encode({ ok: false, error: { code: 'invalid_json', message: 'Invalid JSON control request.' } }),
          );
          continue;
        }
        Promise.resolve(handler(request))
          .then((result) => socket.write(encode({ ok: true, result })))
          .catch((error) =>
            socket.write(
              encode({
                ok: false,
                error: { code: (error as NodeJS.ErrnoException).code ?? 'control_error', message: errorMessage(error) },
              }),
            ),
          );
      }
    });
  });
  server.listen(paths.socketPath, () => {
    try {
      fs.chmodSync(paths.socketPath, 0o600);
    } catch {
      // best effort
    }
  });
  return server;
}

export function isControlSocketReachable(timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: getRuntimePaths().socketPath });
    let done = false;
    const finish = (reachable: boolean) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function requestControl(
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 1500,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: getRuntimePaths().socketPath });
    let done = false;
    let buffer = '';
    const rejectUnreachable = (cause?: unknown) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const error = new Error('x-adapter is not running or the control socket is unreachable.');
      (error as NodeJS.ErrnoException).code = 'daemon_unreachable';
      (error as Error & { cause?: unknown }).cause = cause;
      reject(error);
    };
    const timer = setTimeout(() => rejectUnreachable(), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(encode({ command, args })));
    socket.on('error', rejectUnreachable);
    socket.on('data', (chunk) => {
      if (done) {
        return;
      }
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index < 0) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, index)) as {
          ok?: boolean;
          result?: unknown;
          error?: { code?: string; message?: string };
        };
        if (response.ok) {
          resolve(response.result);
        } else {
          const error = new Error(response.error?.message || 'Control request failed.');
          (error as NodeJS.ErrnoException).code = response.error?.code || 'control_error';
          reject(error);
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
