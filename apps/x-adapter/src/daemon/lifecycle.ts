import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { requestControl } from './control-socket.js';
import { readLockPid } from './lock.js';
import { isXAdapterDaemonProcess } from './process.js';
import { ensureRuntimePaths } from './runtime-paths.js';

const STARTUP_POLL_INTERVAL_MS = 150;

type StartupFailureCode = 'daemon_exited' | 'daemon_lock_held' | 'daemon_startup_timeout';

class DaemonStartupError extends Error {
  code: StartupFailureCode;
  readonly pid?: number;
  readonly stderrPath: string;

  constructor(code: StartupFailureCode, message: string, stderrPath: string, pid?: number) {
    super(message);
    this.name = 'DaemonStartupError';
    this.code = code;
    this.stderrPath = stderrPath;
    this.pid = pid;
  }
}

export async function getDaemonStatus(): Promise<{ running: boolean; healthy: boolean; daemon: unknown | null }> {
  try {
    return { running: true, healthy: true, daemon: await requestControl('daemon.status') };
  } catch {
    return { running: false, healthy: false, daemon: null };
  }
}

export async function startDaemon(
  scriptPath: string,
  cwd = process.cwd(),
  timeoutMs = 5000,
): Promise<{ status: string; daemon?: unknown; pid?: number }> {
  const current = await getDaemonStatus();
  if (current.healthy) {
    return { status: 'already_running', daemon: current.daemon };
  }
  const paths = ensureRuntimePaths();
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const stderr = fs.openSync(paths.stderrPath, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [scriptPath, '__daemon__'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'ignore', stderr],
      detached: true,
    });
    child.unref();
  } finally {
    fs.closeSync(stderr);
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await getDaemonStatus();
    if (status.healthy) {
      return { status: 'started', daemon: status.daemon, pid: child.pid };
    }
    const failure = startupFailure(child.pid, paths.lockPath, paths.stderrPath);
    if (failure) {
      throw failure;
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
  }
  throw new DaemonStartupError(
    'daemon_startup_timeout',
    `x-adapter daemon startup timed out before the control socket became ready; inspect ${paths.stderrPath}.`,
    paths.stderrPath,
    child.pid,
  );
}

export async function stopDaemon(timeoutMs = 5000): Promise<{ status: string; pid?: number }> {
  const paths = ensureRuntimePaths();
  let result: unknown;
  try {
    result = await requestControl('daemon.shutdown', {}, Math.min(3_000, timeoutMs));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'daemon_unreachable') {
      throw error;
    }
    // During a failed upgrade an older daemon can close its control socket but
    // stay alive behind an incomplete data-plane request. Treat a live lock
    // owner as an orphaned local daemon so an explicit `x-adapter stop` can
    // recover the runtime instead of misleadingly reporting `not_running`.
    const orphanPid = readLockPid(paths.lockPath);
    if (!orphanPid || !isProcessRunning(orphanPid)) {
      return { status: 'not_running' };
    }
    if (!(await isXAdapterDaemonProcess(orphanPid))) {
      const blocked = new Error(`x-adapter runtime lock is held by an unverified process pid ${orphanPid}.`);
      (blocked as NodeJS.ErrnoException).code = 'daemon_lock_owner_unverified';
      throw blocked;
    }
    await terminateDaemon(orphanPid, timeoutMs);
    return { status: 'stopped', pid: orphanPid };
  }
  const pid = Number((result as { pid?: unknown }).pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: 'stopped' };
  }
  await terminateDaemon(pid, timeoutMs);
  return { status: 'stopped', pid };
}

async function terminateDaemon(pid: number, timeoutMs: number): Promise<void> {
  if (await waitForProcessExit(pid, timeoutMs)) {
    return;
  }
  await verifyDaemonProcess(pid);
  sendTerminationSignal(pid, 'SIGTERM');
  // Older releases can keep the lock after SIGTERM while a partial HTTP/SSE
  // request remains open. `stop` is an explicit user lifecycle action, so do
  // not report success until the owner has actually exited.
  if (await waitForProcessExit(pid, Math.min(1_000, Math.max(250, timeoutMs)))) {
    return;
  }
  // PID reuse is unlikely but must not turn a shutdown retry into a signal for
  // another local process.
  await verifyDaemonProcess(pid);
  sendTerminationSignal(pid, 'SIGKILL');
  if (await waitForProcessExit(pid, 1_000)) {
    return;
  }
  const error = new Error(`x-adapter daemon pid ${pid} did not exit after shutdown.`);
  (error as NodeJS.ErrnoException).code = 'daemon_stop_timeout';
  throw error;
}

async function verifyDaemonProcess(pid: number): Promise<void> {
  if (await isXAdapterDaemonProcess(pid)) {
    return;
  }
  const error = new Error(`x-adapter daemon pid ${pid} can no longer be verified for shutdown.`);
  (error as NodeJS.ErrnoException).code = 'daemon_lock_owner_unverified';
  throw error;
}

function sendTerminationSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

function startupFailure(pid: number | undefined, lockPath: string, stderrPath: string): DaemonStartupError | undefined {
  // A new daemon may briefly see the old lock while it safely recovers a
  // verified orphan from an earlier release. Do not preempt that child: only
  // diagnose a competing live owner after the child has itself exited.
  if (pid && isProcessRunning(pid)) {
    return undefined;
  }

  const lockPid = readLockPid(lockPath);
  if (lockPid && lockPid !== pid && isProcessRunning(lockPid)) {
    return new DaemonStartupError(
      'daemon_lock_held',
      `x-adapter daemon startup is blocked by the still-running daemon pid ${lockPid}; inspect ${stderrPath}.`,
      stderrPath,
      lockPid,
    );
  }
  return new DaemonStartupError(
    'daemon_exited',
    `x-adapter daemon exited before the control socket became ready; inspect ${stderrPath}.`,
    stderrPath,
    pid,
  );
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
  }
  return !isProcessRunning(pid);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
