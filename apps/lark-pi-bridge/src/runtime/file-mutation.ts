import { setTimeout as delay } from 'node:timers/promises';
import { acquireRuntimeLock, RuntimeLockConflictError } from './locks.js';

const queues = new Map<string, Promise<void>>();

/** Serialize a read-modify-write both within this process and against peers. */
export async function withFileMutationLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  let releaseQueue: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(path, tail);
  await previous;

  let lock;
  try {
    const deadline = Date.now() + 5_000;
    while (!lock) {
      try {
        lock = await acquireRuntimeLock(`${path}.lock`);
      } catch (error) {
        if (!(error instanceof RuntimeLockConflictError) || Date.now() >= deadline) {
          throw error;
        }
        await delay(25);
      }
    }
    return await action();
  } finally {
    await lock?.release().catch(() => {});
    releaseQueue?.();
    if (queues.get(path) === tail) {
      queues.delete(path);
    }
  }
}
