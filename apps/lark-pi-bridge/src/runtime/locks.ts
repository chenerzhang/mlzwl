import { hostname } from 'node:os';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from './process-identity.js';

export class RuntimeLockConflictError extends Error {}
export interface AcquiredRuntimeLock {
  release(): Promise<void>;
}

interface RuntimeLockRecord extends ProcessIdentity {
  hostname: string;
  nonce: string;
  createdAt: string;
}

export async function acquireRuntimeLock(path: string): Promise<AcquiredRuntimeLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const identity = await readProcessIdentity(process.pid);
  if (!identity) {
    throw new Error('cannot establish current process identity for runtime lock');
  }
  const record: RuntimeLockRecord = {
    ...identity,
    hostname: hostname(),
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + 2_000;

  while (true) {
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(record)}\n`);
        await file.sync();
      } catch (error) {
        await file.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
      return {
        async release(): Promise<void> {
          await file.close().catch(() => {});
          if ((await readLock(path))?.nonce === record.nonce) {
            await unlink(path).catch(() => {});
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const existing = await readLock(path);
      if (existing?.hostname && existing.hostname !== hostname()) {
        throw new RuntimeLockConflictError(`runtime lock belongs to another host: ${path}`);
      }
      if (existing && sameProcessIdentity(existing, await readProcessIdentity(existing.pid))) {
        throw new RuntimeLockConflictError(`runtime lock already held: ${path}`);
      }
      const metadata = await lstat(path).catch(() => undefined);
      if (!metadata) {
        continue;
      }
      if (!existing && Date.now() - metadata.mtimeMs < 1_000 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      await quarantineStaleLock(path);
    }
  }
}

async function readLock(path: string): Promise<RuntimeLockRecord | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<RuntimeLockRecord>;
    return Number.isSafeInteger(raw.pid) &&
      Number(raw.pid) > 0 &&
      typeof raw.startedAt === 'string' &&
      raw.startedAt.length > 0 &&
      typeof raw.hostname === 'string' &&
      raw.hostname.length > 0 &&
      typeof raw.nonce === 'string' &&
      raw.nonce.length > 0 &&
      typeof raw.createdAt === 'string'
      ? (raw as RuntimeLockRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

async function quarantineStaleLock(path: string): Promise<void> {
  const stalePath = `${path}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(path, stalePath);
    await unlink(stalePath).catch(() => {});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
