import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from '../runtime/process-identity.js';
import { acquireRuntimeLock, type AcquiredRuntimeLock } from '../runtime/locks.js';

export interface ForegroundServiceHandle {
  stop(): Promise<void>;
}

export interface ServiceStatus {
  running: boolean;
  pid?: number;
  identityMatch?: boolean;
}

interface ServicePidRecord extends ProcessIdentity {
  writtenAt: string;
}

/**
 * Local foreground service ownership. It deliberately does not install a
 * launchd/systemd unit: those paths require separately authorized real-service
 * validation. The pid file is advisory; the exclusive lock is authoritative.
 */
export class LocalServiceController {
  constructor(
    private readonly lockPath: string,
    private readonly pidPath: string,
  ) {}

  async start(startForeground: () => Promise<ForegroundServiceHandle>): Promise<ForegroundServiceHandle> {
    const lock = await acquireRuntimeLock(this.lockPath);
    try {
      await mkdir(dirname(this.pidPath), { recursive: true, mode: 0o700 });
      const identity = await readProcessIdentity(process.pid);
      if (!identity) {
        throw new Error('cannot establish current process identity for service pid file');
      }
      await writeFile(this.pidPath, `${JSON.stringify({ ...identity, writtenAt: new Date().toISOString() })}\n`, {
        mode: 0o600,
      });
      const handle = await startForeground();
      return withCleanup(handle, lock, this.pidPath);
    } catch (error) {
      await cleanup(lock, this.pidPath);
      throw error;
    }
  }

  async status(): Promise<ServiceStatus> {
    const stored = await readPidRecord(this.pidPath);
    if (!stored) {
      return { running: false };
    }
    const current = await readProcessIdentity(stored.pid);
    const identityMatch = sameProcessIdentity(stored, current);
    return { running: identityMatch, pid: stored.pid, identityMatch };
  }

  /** Request a foreground service shutdown and wait briefly for its PID file to disappear. */
  async stop(): Promise<void> {
    const status = await this.status();
    if (!status.running || !status.identityMatch || status.pid === process.pid) {
      return;
    }
    process.kill(status.pid!, 'SIGTERM');
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(50);
      if (!(await this.status()).running) {
        return;
      }
    }
    throw new Error(`foreground service ${status.pid} did not stop after SIGTERM`);
  }
}

function withCleanup(
  handle: ForegroundServiceHandle,
  lock: AcquiredRuntimeLock,
  pidPath: string,
): ForegroundServiceHandle {
  let stopped = false;
  return {
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        await handle.stop();
      } finally {
        await cleanup(lock, pidPath);
      }
    },
  };
}
async function cleanup(lock: AcquiredRuntimeLock, pidPath: string): Promise<void> {
  await lock.release();
  const record = await readPidRecord(pidPath);
  if (record?.pid === process.pid && sameProcessIdentity(record, await readProcessIdentity(process.pid))) {
    await unlink(pidPath).catch(() => {});
  }
}

async function readPidRecord(path: string): Promise<ServicePidRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<ServicePidRecord>;
    return Number.isSafeInteger(raw.pid) &&
      Number(raw.pid) > 0 &&
      typeof raw.startedAt === 'string' &&
      raw.startedAt.length > 0 &&
      typeof raw.writtenAt === 'string'
      ? (raw as ServicePidRecord)
      : undefined;
  } catch {
    return undefined;
  }
}
