import { describe, expect, it } from 'vitest';
import { createWriteQueue } from './write-queue';

/**
 * 串行写队列的纯逻辑测试。
 *
 * 不引入 jsdom：存储与定时器全部注入，被测模块 import 期不访问全局对象。
 */

interface Recorded {
  writes: Array<[string, string]>;
  /** 某个 key 被写了几次。 */
  countOf(key: string): number;
  /** 某个 key 最后一次写入的值。 */
  lastOf(key: string): string | undefined;
}

function createRecordingStorage(failKeys: readonly string[] = []): Recorded & Pick<Storage, 'setItem'> {
  const writes: Array<[string, string]> = [];
  const failures = new Set(failKeys);
  return {
    writes,
    countOf: (key) => writes.filter(([written]) => written === key).length,
    lastOf: (key) => writes.filter(([written]) => written === key).at(-1)?.[1],
    setItem: (key: string, value: string) => {
      if (failures.has(key)) {
        throw new Error(`quota exceeded: ${key}`);
      }
      writes.push([key, value]);
    },
  };
}

interface FakeTimers {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** 已安排但未触发的回调。 */
  readonly pending: number[];
  /** 触发当前挂起的定时器。 */
  fire(): void;
}

function createFakeTimers(): FakeTimers {
  let nextHandle = 1;
  const handles: number[] = [];
  const callbacks = new Map<number, () => void>();
  return {
    schedule: (fn) => {
      const handle = nextHandle++;
      handles.push(handle);
      callbacks.set(handle, fn);
      return handle;
    },
    cancel: (handle) => {
      const index = handles.indexOf(handle as number);
      if (index >= 0) {
        handles.splice(index, 1);
      }
      callbacks.delete(handle as number);
    },
    get pending() {
      return [...handles];
    },
    fire: () => {
      const handle = handles.shift();
      if (handle === undefined) {
        throw new Error('没有挂起的定时器');
      }
      const callback = callbacks.get(handle);
      callbacks.delete(handle);
      callback?.();
    },
  };
}

describe('createWriteQueue', () => {
  it('collapses repeated writes of the same key into one, keeping the latest value', async () => {
    const storage = createRecordingStorage();
    const queue = createWriteQueue({ storage, schedule: () => 0, cancel: () => {} });

    queue.enqueue('history', 'v1');
    queue.enqueue('history', 'v2');
    queue.enqueue('history', 'v3');
    expect(queue.pending).toBe(true);

    await queue.flush();

    expect(storage.countOf('history')).toBe(1);
    expect(storage.lastOf('history')).toBe('v3');
    expect(queue.pending).toBe(false);
  });

  it('writes each of two keys exactly once', async () => {
    const storage = createRecordingStorage();
    const queue = createWriteQueue({ storage, schedule: () => 0, cancel: () => {} });

    queue.enqueue('history', 'h1');
    queue.enqueue('player', 'p1');
    queue.enqueue('history', 'h2');
    await queue.flush();

    expect(storage.countOf('history')).toBe(1);
    expect(storage.countOf('player')).toBe(1);
    expect(storage.lastOf('history')).toBe('h2');
    expect(storage.lastOf('player')).toBe('p1');
  });

  it('flushes automatically when the injected timer fires', async () => {
    const storage = createRecordingStorage();
    const timers = createFakeTimers();
    const queue = createWriteQueue({ storage, schedule: timers.schedule, cancel: timers.cancel });

    queue.enqueue('history', 'v1');
    expect(timers.pending).toHaveLength(1);
    expect(storage.writes).toHaveLength(0);

    timers.fire();
    await queue.flush();

    expect(storage.lastOf('history')).toBe('v1');
    expect(queue.pending).toBe(false);
  });

  it('keeps a single timer across enqueues in the same window', () => {
    const timers = createFakeTimers();
    const queue = createWriteQueue({
      storage: createRecordingStorage(),
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    queue.enqueue('history', 'v1');
    queue.enqueue('history', 'v2');
    queue.enqueue('history', 'v3');

    // 持续写入不得无限顺延定时器，否则播放期间永远不落盘。
    expect(timers.pending).toHaveLength(1);
  });

  it('serialises flushes so a late enqueue lands after the running write', async () => {
    const storage = createRecordingStorage();
    const queue = createWriteQueue({ storage, schedule: () => 0, cancel: () => {} });

    queue.enqueue('history', 'v1');
    const first = queue.flush();
    // 第一个 flush 还没落盘时又有新值。
    queue.enqueue('history', 'v2');
    await first;

    expect(storage.lastOf('history')).toBe('v1');
    expect(queue.pending).toBe(true);

    await queue.flush();

    expect(storage.writes).toEqual([
      ['history', 'v1'],
      ['history', 'v2'],
    ]);
    expect(queue.pending).toBe(false);
  });

  it('reports a failing key without retrying and still writes the other keys', async () => {
    const storage = createRecordingStorage(['history']);
    const errors: Array<{ error: unknown; key: string }> = [];
    const queue = createWriteQueue({
      storage,
      schedule: () => 0,
      cancel: () => {},
      onError: (error, key) => {
        errors.push({ error, key });
      },
    });

    queue.enqueue('history', 'h1');
    queue.enqueue('player', 'p1');
    await queue.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.key).toBe('history');
    expect(errors[0]?.error).toBeInstanceOf(Error);
    // 不重试：失败的 key 一次都没写进去。
    expect(storage.countOf('history')).toBe(0);
    expect(storage.lastOf('player')).toBe('p1');
    expect(queue.pending).toBe(false);
  });

  it('does not write the same key twice when flush is called concurrently', async () => {
    const storage = createRecordingStorage();
    const queue = createWriteQueue({ storage, schedule: () => 0, cancel: () => {} });

    queue.enqueue('history', 'v1');
    const [a, b] = await Promise.all([queue.flush(), queue.flush()]);

    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(storage.countOf('history')).toBe(1);
  });

  it('keeps the chain alive when storage throws without an onError callback', async () => {
    // 异常不得冒到链上，否则后续写会被静默丢弃。
    const storage = createRecordingStorage(['history']);
    const queue = createWriteQueue({ storage, schedule: () => 0, cancel: () => {} });

    queue.enqueue('history', 'h1');
    await expect(queue.flush()).resolves.toBeUndefined();

    queue.enqueue('player', 'p1');
    await queue.flush();

    expect(storage.lastOf('player')).toBe('p1');
  });

  it('cancels the pending timer when flushed early', async () => {
    const timers = createFakeTimers();
    const queue = createWriteQueue({
      storage: createRecordingStorage(),
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    queue.enqueue('history', 'v1');
    await queue.flush();

    expect(timers.pending).toHaveLength(0);
  });
});

describe('createWriteQueue flushSync', () => {
  it('writes dirty values synchronously before returning', () => {
    const storage = createRecordingStorage();
    const timers = createFakeTimers();
    const queue = createWriteQueue({ storage, schedule: timers.schedule, cancel: timers.cancel });

    queue.enqueue('history', 'v1');
    queue.enqueue('player', 'p1');

    queue.flushSync();

    // 关键断言：没有 await，`flushSync` 返回时写已经全部发生。
    expect(storage.lastOf('history')).toBe('v1');
    expect(storage.lastOf('player')).toBe('p1');
    expect(queue.pending).toBe(false);
    // 脏表已清空，已安排的定时器也要取消，不能到点再写一次。
    expect(timers.pending).toHaveLength(0);
  });

  it('skips while the async chain is pending instead of reordering writes', async () => {
    const storage = createRecordingStorage();
    const timers = createFakeTimers();
    const queue = createWriteQueue({ storage, schedule: timers.schedule, cancel: timers.cancel });

    queue.enqueue('history', 'v1');
    const first = queue.flush();
    queue.enqueue('history', 'v2');

    // 链上已有快照 v1 没落盘，插队写 v2 会让旧值后到、把新值盖掉。
    expect(() => queue.flushSync()).not.toThrow();
    expect(storage.writes).toHaveLength(0);
    // 脏值仍在表里，且仍挂在合并窗口定时器上（不变式：脏表非空 ⇒ 定时器已武装），
    // 所以跳过只是推迟一个窗口，不是丢掉。
    expect(queue.pending).toBe(true);
    expect(timers.pending).toHaveLength(1);

    await first;
    expect(storage.lastOf('history')).toBe('v1');

    await queue.flush();
    expect(storage.writes).toEqual([
      ['history', 'v1'],
      ['history', 'v2'],
    ]);
  });

  it('reports a throwing setItem through onError without throwing', () => {
    const storage = createRecordingStorage(['history']);
    const errors: Array<{ error: unknown; key: string }> = [];
    const queue = createWriteQueue({
      storage,
      schedule: () => 0,
      cancel: () => {},
      onError: (error, key) => {
        errors.push({ error, key });
      },
    });

    queue.enqueue('history', 'h1');
    queue.enqueue('player', 'p1');

    expect(() => queue.flushSync()).not.toThrow();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.key).toBe('history');
    expect(errors[0]?.error).toBeInstanceOf(Error);
    // 一个 key 失败不影响同批次的其它 key。
    expect(storage.lastOf('player')).toBe('p1');
  });
});
