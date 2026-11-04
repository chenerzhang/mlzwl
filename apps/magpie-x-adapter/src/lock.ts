import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where x-adapter keeps its runtime files.
 *
 * This mirrors the CLI exactly (`apps/x-adapter/src/config/env.ts`):
 *
 * - a variable counts only when it is set and non-empty, and its value is used
 *   verbatim, spaces included;
 * - `~` alone and `~/` are expanded, and nothing else is (`~user/` is a path
 *   the CLI treats literally);
 * - the data directory comes from `X_ADAPTER_DATA_DIR`, else
 *   `~/.x-adapter`, and the runtime directory from
 *   `X_ADAPTER_RUNTIME_DIR`, else `<data>/runtime`.
 *
 * Any divergence here makes the plugin read a lock file the CLI does not
 * write, so the two must agree byte for byte. Only paths are computed;
 * nothing is created.
 */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function expandHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function dataDir(): string {
  return path.resolve(expandHome(envValue('X_ADAPTER_DATA_DIR') ?? path.join(os.homedir(), '.x-adapter')));
}

export function runtimeDir(): string {
  return path.resolve(expandHome(envValue('X_ADAPTER_RUNTIME_DIR') ?? path.join(dataDir(), 'runtime')));
}

export function lockPath(): string {
  return path.join(runtimeDir(), 'x-adapter.lock');
}

/** A daemon recorded in the lock file, with whether it is still running. */
export type LockOwner = { pid: number; running: boolean };

/**
 * The daemon that holds this data directory's lock, if one is recorded.
 *
 * x-adapter locks by data directory rather than by port, so this is the
 * authoritative answer to "is another gateway already using these files".
 * Reading it needs no running daemon.
 */
export function readLockOwner(file = lockPath()): LockOwner | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let pid: number;
  try {
    const parsed: unknown = JSON.parse(raw);
    pid = Number((parsed as { pid?: unknown })?.pid);
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return { pid, running: isProcessRunning(pid) };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
