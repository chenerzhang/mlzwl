import { describe, expect, it } from 'vitest';
import { DownloadQueue } from './download-queue';

/** 可手动放行的任务表，用来精确控制并发时机。 */
function makeQueue(limit: number): {
  queue: DownloadQueue;
  started: string[];
  release: (episodeId: string) => void;
  finishAll: () => Promise<void>;
} {
  const started: string[] = [];
  const pending = new Map<string, () => void>();
  const queue = new DownloadQueue(limit, {
    run: (episodeId) =>
      new Promise<void>((resolve) => {
        started.push(episodeId);
        pending.set(episodeId, resolve);
      }),
  });
  return {
    queue,
    started,
    release: (episodeId) => {
      pending.get(episodeId)?.();
      pending.delete(episodeId);
    },
    finishAll: async () => {
      while (pending.size > 0) {
        for (const key of [...pending.keys()]) {
          pending.get(key)?.();
          pending.delete(key);
        }
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe('DownloadQueue', () => {
  it('rejects a non-positive limit', () => {
    expect(() => new DownloadQueue(0, { run: () => Promise.resolve() })).toThrow();
    expect(() => new DownloadQueue(-1, { run: () => Promise.resolve() })).toThrow();
  });

  it('starts at most `limit` tasks at once and queues the rest', async () => {
    const { queue, started } = makeQueue(2);

    expect(queue.enqueue('a')).toBe(true);
    expect(queue.enqueue('b')).toBe(true);
    expect(queue.enqueue('c')).toBe(true);
    await Promise.resolve();

    expect(started).toEqual(['a', 'b']);
    expect(queue.activeCount).toBe(2);
    expect(queue.waitingCount).toBe(1);
    expect(queue.saturated).toBe(true);
  });

  it('ignores a duplicate submission while running or waiting', () => {
    const { queue } = makeQueue(1);

    queue.enqueue('a');
    queue.enqueue('b');

    expect(queue.enqueue('a')).toBe(false);
    expect(queue.enqueue('b')).toBe(false);
    expect(queue.waitingCount).toBe(1);
  });

  it('starts the next queued task when an active one finishes', async () => {
    const { queue, started, release, finishAll } = makeQueue(1);

    queue.enqueue('a');
    queue.enqueue('b');
    await Promise.resolve();
    expect(started).toEqual(['a']);

    release('a');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(['a', 'b']);
    await finishAll();
  });

  it('consumes a rejected run, releases its slot, and continues pumping', async () => {
    const started: string[] = [];
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);

    try {
      const queue = new DownloadQueue(1, {
        run: (episodeId) => {
          started.push(episodeId);
          return episodeId === 'a' ? Promise.reject(new Error('download failed')) : Promise.resolve();
        },
      });

      queue.enqueue('a');
      queue.enqueue('b');
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandled).toEqual([]);
      expect(started).toEqual(['a', 'b']);
      expect(queue.activeCount).toBe(0);
      expect(queue.waitingCount).toBe(0);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('removes a queued task on dequeue so it never starts', async () => {
    const { queue, started, release, finishAll } = makeQueue(1);

    queue.enqueue('a');
    queue.enqueue('b');

    expect(queue.dequeue('b')).toBe(true);
    expect(queue.waitingCount).toBe(0);

    release('a');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(['a']);
    await finishAll();
  });

  it('does not dequeue an already running task', () => {
    const { queue } = makeQueue(1);

    queue.enqueue('a');

    expect(queue.dequeue('a')).toBe(false);
    expect(queue.activeCount).toBe(1);
  });

  it('drains the waiting list on clearWaiting', () => {
    const { queue } = makeQueue(1);

    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');

    expect(queue.clearWaiting()).toEqual(['b', 'c']);
    expect(queue.waitingCount).toBe(0);
  });

  it('reports saturation only once the limit is reached', () => {
    const { queue } = makeQueue(2);

    expect(queue.saturated).toBe(false);
    queue.enqueue('a');
    expect(queue.saturated).toBe(false);
    queue.enqueue('b');
    expect(queue.saturated).toBe(true);
  });
});
