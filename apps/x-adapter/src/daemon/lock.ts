import fs from 'node:fs';
import { ensureRuntimePaths, getRuntimePaths } from './runtime-paths.js';

export type DaemonLock = {
  path: string;
  release(): void;
};

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLockPid(lockPath: string): number | undefined {
  try {
    const pid = Number((JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown }).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function acquireDaemonLock(lockPath = getRuntimePaths().lockPath): DaemonLock {
  ensureRuntimePaths();
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const pid = readLockPid(lockPath);
    if (pid && isProcessRunning(pid)) {
      throw lockHeld(lockPath, pid);
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      throw lockHeld(lockPath, pid);
    }
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      fs.closeSync(descriptor);
    } catch {
      // best effort
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
  };
  process.once('exit', release);
  return { path: lockPath, release };
}

function lockHeld(lockPath: string, pid?: number): Error {
  const error = new Error(`x-adapter daemon lock is already held${pid ? ` by pid ${pid}` : ''}: ${lockPath}`);
  (error as NodeJS.ErrnoException).code = 'daemon_lock_held';
  return error;
}
