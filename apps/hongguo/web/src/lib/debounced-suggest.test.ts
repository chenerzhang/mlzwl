import { describe, expect, it } from 'vitest';
import { createSuggestController } from './debounced-suggest';

/**
 * 防抖与取消的行为证据（P1-4）。
 *
 * 不引入 jsdom：定时器与取消都注入，测试手动推进，不依赖真实时间。
 */

interface Harness {
  /** 手动触发的定时器数量。 */
  pendingCount(): number;
  /** 已发出的请求前缀。 */
  calls: string[];
  /** 已中止的信号数量。 */
  aborted(): number;
  /** 成功回调收到的结果。 */
  results: Array<readonly string[]>;
  errors: unknown[];
  controller: ReturnType<typeof createSuggestController>;
  /** 触发所有挂起的定时器。 */
  tick(): void;
}

interface HarnessOptions {
  /** 请求返回的结果。 */
  reply?: (prefix: string) => Promise<readonly string[]>;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const scheduled = new Map<number, () => void>();
  const signals: AbortSignal[] = [];
  const calls: string[] = [];
  const results: Array<readonly string[]> = [];
  const errors: unknown[] = [];
  let nextHandle = 0;

  const controller = createSuggestController({
    fetchSuggest: (prefix, signal) => {
      calls.push(prefix);
      signals.push(signal);
      return options.reply === undefined ? Promise.resolve([`${prefix}-suggest`]) : options.reply(prefix);
    },
    onResult: (items) => {
      results.push(items);
    },
    onError: (error) => {
      errors.push(error);
    },
    schedule: (fn) => {
      nextHandle += 1;
      scheduled.set(nextHandle, fn);
      return nextHandle;
    },
    // 取消即出队：被取消的定时器永远不该再触发。
    cancel: (handle) => {
      scheduled.delete(handle as number);
    },
  });

  return {
    pendingCount: () => scheduled.size,
    calls,
    aborted: () => signals.filter((signal) => signal.aborted).length,
    results,
    errors,
    controller,
    tick: () => {
      const pending = [...scheduled.values()];
      scheduled.clear();
      for (const fn of pending) {
        fn();
      }
    },
  };
}

/** 等待微任务队列，让 `fetchSuggest` 的 then 回调跑完。 */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createSuggestController', () => {
  it('does not request before the debounce window elapses', () => {
    const harness = createHarness();
    harness.controller.update('长');
    expect(harness.calls).toEqual([]);
    expect(harness.pendingCount()).toBe(1);
  });

  it('requests once after the timer fires', async () => {
    const harness = createHarness();
    harness.controller.update('长生');
    harness.tick();
    await flush();
    expect(harness.calls).toEqual(['长生']);
    expect(harness.results).toEqual([['长生-suggest']]);
  });

  it('only sends the last input when the user types continuously', async () => {
    const harness = createHarness();
    harness.controller.update('长');
    harness.controller.update('长生');
    harness.controller.update('长生殿');
    harness.tick();
    await flush();
    expect(harness.calls).toEqual(['长生殿']);
    expect(harness.results).toEqual([['长生殿-suggest']]);
  });

  it('aborts the previous request when a new input arrives', async () => {
    const harness = createHarness({ reply: () => new Promise<readonly string[]>(() => undefined) });
    harness.controller.update('长');
    harness.tick();
    harness.controller.update('长生');
    expect(harness.aborted()).toBe(1);
  });

  it('discards a stale response that arrives after a newer input', async () => {
    const resolvers: Array<(items: readonly string[]) => void> = [];
    const harness = createHarness({
      reply: () =>
        new Promise<readonly string[]>((resolve) => {
          resolvers.push(resolve);
        }),
    });

    harness.controller.update('长');
    harness.tick();
    harness.controller.update('长生');
    harness.tick();

    // 先返回旧请求，再返回新请求：旧结果必须被丢掉。
    resolvers[0]?.(['旧结果']);
    resolvers[1]?.(['新结果']);
    await flush();

    expect(harness.results).toEqual([['新结果']]);
  });

  it('clears the result and skips the request for an empty input', () => {
    const harness = createHarness();
    harness.controller.update('');
    expect(harness.calls).toEqual([]);
    expect(harness.pendingCount()).toBe(0);
    expect(harness.results).toEqual([[]]);
  });

  it('treats whitespace-only input as empty', () => {
    const harness = createHarness();
    harness.controller.update('   ');
    expect(harness.calls).toEqual([]);
    expect(harness.results).toEqual([[]]);
  });

  it('cancels the pending timer and in-flight request on dispose', async () => {
    const harness = createHarness({ reply: () => new Promise<readonly string[]>(() => undefined) });
    harness.controller.update('长');
    harness.tick();
    harness.controller.update('长生');
    harness.controller.dispose();

    expect(harness.aborted()).toBe(1);
    expect(harness.pendingCount()).toBe(0);
    harness.controller.update('长生殿');
    expect(harness.pendingCount()).toBe(0);
    await flush();
    expect(harness.calls).toEqual(['长']);
  });

  it('reports non-abort failures through onError', async () => {
    const harness = createHarness({ reply: () => Promise.reject(new Error('network down')) });
    harness.controller.update('长生');
    harness.tick();
    await flush();
    expect(harness.errors).toHaveLength(1);
    expect((harness.errors[0] as Error).message).toBe('network down');
  });

  it('does not report aborts as errors', async () => {
    const harness = createHarness({
      reply: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    });
    harness.controller.update('长生');
    harness.tick();
    await flush();
    expect(harness.errors).toEqual([]);
  });
});
