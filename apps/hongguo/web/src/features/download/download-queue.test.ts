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
    run: (task) =>
      new Promise<void>((resolve) => {
        started.push(task.episodeId);
        pending.set(task.episodeId, resolve);
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

    expect(queue.enqueue({ episodeId: 'a' })).toBe(true);
    expect(queue.enqueue({ episodeId: 'b' })).toBe(true);
    expect(queue.enqueue({ episodeId: 'c' })).toBe(true);
    await Promise.resolve();

    expect(started).toEqual(['a', 'b']);
    expect(queue.activeCount).toBe(2);
    expect(queue.waitingCount).toBe(1);
    expect(queue.saturated).toBe(true);
  });

  it('ignores a duplicate submission while running or waiting', () => {
    const { queue } = makeQueue(1);

    queue.enqueue({ episodeId: 'a' });
    queue.enqueue({ episodeId: 'b' });

    expect(queue.enqueue({ episodeId: 'a' })).toBe(false);
    expect(queue.enqueue({ episodeId: 'b' })).toBe(false);
    expect(queue.waitingCount).toBe(1);
  });

  it('starts the next queued task when an active one finishes', async () => {
    const { queue, started, release, finishAll } = makeQueue(1);

    queue.enqueue({ episodeId: 'a' });
    queue.enqueue({ episodeId: 'b' });
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
        run: (task) => {
          started.push(task.episodeId);
          return task.episodeId === 'a' ? Promise.reject(new Error('download failed')) : Promise.resolve();
        },
      });

      queue.enqueue({ episodeId: 'a' });
      queue.enqueue({ episodeId: 'b' });
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

    queue.enqueue({ episodeId: 'a' });
    queue.enqueue({ episodeId: 'b' });

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

    queue.enqueue({ episodeId: 'a' });

    expect(queue.dequeue('a')).toBe(false);
    expect(queue.activeCount).toBe(1);
  });

  it('drains the waiting list on clearWaiting', () => {
    const { queue } = makeQueue(1);

    queue.enqueue({ episodeId: 'a' });
    queue.enqueue({ episodeId: 'b' });
    queue.enqueue({ episodeId: 'c' });

    // 返回完整任务（含冻结档位），调用方据此逐个上报「已取消」。
    expect(queue.clearWaiting()).toEqual([{ episodeId: 'b' }, { episodeId: 'c' }]);
    expect(queue.waitingCount).toBe(0);
  });

  it('reports saturation only once the limit is reached', () => {
    const { queue } = makeQueue(2);

    expect(queue.saturated).toBe(false);
    queue.enqueue({ episodeId: 'a' });
    expect(queue.saturated).toBe(false);
    queue.enqueue({ episodeId: 'b' });
    expect(queue.saturated).toBe(true);
  });
});

describe('DownloadQueue definition freezing', () => {
  it('runs each task with the definition captured at enqueue time', async () => {
    // 批量提交 1080p 后用户切到 360p：已排队任务必须仍按 1080p 执行，
    // 否则一次批量操作会产出混合清晰度的文件。
    const started: { episodeId: string; definition?: string }[] = [];
    const resolvers = new Map<string, () => void>();
    const queue = new DownloadQueue(1, {
      run: (task) =>
        new Promise<void>((resolve) => {
          started.push({ ...task });
          resolvers.set(task.episodeId, resolve);
        }),
    });

    queue.enqueue({ episodeId: 'a', definition: '1080p' });
    queue.enqueue({ episodeId: 'b', definition: '1080p' });
    await Promise.resolve();

    // 第一个任务在跑，第二个还在排队；此时「用户切档」不影响队列里的快照。
    expect(queue.waitingDefinition('b')).toBe('1080p');
    resolvers.get('a')?.();
    // 槽位释放 → `finally` → `pump()` 是一条微任务链，用宏任务一次性等它跑完。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual([
      { episodeId: 'a', definition: '1080p' },
      { episodeId: 'b', definition: '1080p' },
    ]);
  });

  it('reports no definition for an episode that is not waiting', () => {
    const queue = new DownloadQueue(2, { run: () => Promise.resolve() });

    expect(queue.waitingDefinition('nope')).toBeUndefined();
  });
});
