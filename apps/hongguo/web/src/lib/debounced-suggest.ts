/**
 * 搜索联想的防抖 + 取消控制器（P1-4）。
 *
 * 为什么抽成模块：组件里写 `setTimeout` + `AbortController` 既测不了，也很容易漏掉
 * 「上一次请求还在飞、用户已经改了输入」这条路径。这里把定时器与取消都做成可注入的，
 * 于是防抖、连续输入只发最后一次、`dispose` 全清这些行为可以在 node 环境下直接测
 * （见 `apps/hongguo/AGENTS.md` 的 web 测试边界）。
 *
 * 三个不变式：
 * 1. 每次 `update` 先取消上一个定时器与上一个请求，任何时刻最多一个请求在飞。
 * 2. 空串（含纯空白）不发请求，直接清空结果。
 * 3. 已作废的请求晚到时结果被丢弃——`AbortController` 只保证「请求被中止」，
 *    不保证「回调不会被调用」。
 */

export interface SuggestControllerOptions {
  /** 防抖窗口，默认 300 ms。 */
  delayMs?: number;
  /** 取联想词。`signal` 由控制器创建并在下一次 `update` 时中止。 */
  fetchSuggest: (prefix: string, signal: AbortSignal) => Promise<readonly string[]>;
  /** 成功回调。 */
  onResult: (items: readonly string[]) => void;
  /** 失败回调。中止导致的 `AbortError` 不会触发它。 */
  onError?: (error: unknown) => void;
  /** 注入的定时器，测试用。省略时用全局 setTimeout。 */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** 注入的取消函数，测试用。省略时用全局 clearTimeout。 */
  cancel?: (handle: unknown) => void;
}

export interface SuggestController {
  /** 输入变化时调用。空串会清空结果且不发请求。 */
  update(prefix: string): void;
  /** 取消挂起的请求与定时器。 */
  dispose(): void;
}

/**
 * 中止是预期行为，不是错误，不该冒到 `onError`。
 *
 * 不用 `instanceof DOMException`：浏览器与 node 里 `DOMException` 都不继承 `Error`，
 * 而 `name` 是两条运行时都稳定的契约。
 */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export function createSuggestController(options: SuggestControllerOptions): SuggestController {
  const delayMs = options.delayMs ?? 300;
  const schedule = options.schedule ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle: unknown): void => clearTimeout(handle as number));

  let timer: unknown;
  let hasTimer = false;
  let controller: AbortController | undefined;
  /** `dispose` 之后不再接受 `update`：控制器已作废，重新武装会留下无人回收的请求。 */
  let disposed = false;
  /**
   * 每次 `update` 自增；回调里比对，丢弃已被取代的请求结果。
   * `dispose` 也自增，因此作废后晚到的响应同样被丢弃。
   */
  let generation = 0;

  const clearPending = (): void => {
    if (hasTimer) {
      cancel(timer);
      hasTimer = false;
    }
    controller?.abort();
    controller = undefined;
  };

  const run = (prefix: string, currentGeneration: number): void => {
    const next = new AbortController();
    controller = next;
    options.fetchSuggest(prefix, next.signal).then(
      (items) => {
        if (currentGeneration === generation) {
          options.onResult(items);
        }
      },
      (error: unknown) => {
        if (currentGeneration === generation && !isAbortError(error)) {
          options.onError?.(error);
        }
      },
    );
  };

  return {
    update(prefix: string): void {
      if (disposed) {
        return;
      }
      clearPending();
      generation += 1;
      const currentGeneration = generation;

      const trimmed = prefix.trim();
      if (trimmed === '') {
        options.onResult([]);
        return;
      }

      timer = schedule(() => {
        hasTimer = false;
        run(trimmed, currentGeneration);
      }, delayMs);
      hasTimer = true;
    },

    dispose(): void {
      disposed = true;
      generation += 1;
      clearPending();
    },
  };
}
