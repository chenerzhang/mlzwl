import type { PersistStorage, StorageValue } from 'zustand/middleware';

/**
 * 串行持久化写队列（P1-2 / P1-3）。
 *
 * 高频写入（播放器的 `timeupdate` 每秒触发数次）不该每次都落盘：`enqueue` 只把最新值
 * 放进内存脏表，同一 key 后写覆盖前写；合并窗口到点后一次性 flush。flush 走 Promise
 * 串行链，保证晚到的写排在后面、不会覆盖新值，一次失败也不中断后续。
 *
 * 纯逻辑模块：**import 期不读 `window` / `localStorage` / `setTimeout`**，存储与定时器
 * 都从参数注入，因此 vitest 能在默认 node 环境里直接测（见 `apps/hongguo/AGENTS.md`
 * 的 web 测试边界）。
 */

export interface WriteQueueOptions {
  /** 注入的存储实现，测试用。 */
  storage: Pick<Storage, 'setItem'>;
  /** 合并窗口，默认 2000 ms。 */
  flushDelayMs?: number;
  /** 注入的定时器，测试用。省略时用全局 setTimeout。 */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** 注入的取消函数，测试用。省略时用全局 clearTimeout。 */
  cancel?: (handle: unknown) => void;
  /** `setItem` 抛错时的回调（例如配额满）。 */
  onError?: (error: unknown, key: string) => void;
}

export interface WriteQueue {
  /** 记一次脏值。同一 key 的后写覆盖前写。 */
  enqueue(key: string, value: string): void;
  /** 立即 flush，返回 Promise。并发调用串行执行。 */
  flush(): Promise<void>;
  /**
   * 同步落盘一次脏值，不返回 Promise。
   *
   * 给 `pagehide` / `visibilitychange` 用：这两个时点上页面随时可能被终止（bfcache
   * 冻结、进程被杀），排在微任务里的写不保证执行，必须同步写完。
   *
   * 取舍：若串行链上已有未完成的写，**直接跳过**。插队会打乱顺序（旧快照晚到就
   * 覆盖新值）。跳过时脏值仍在合并窗口定时器上，不会永久丢，但会晚一个窗口落盘；
   * 不变式与残余风险见实现处注释。
   */
  flushSync(): void;
  /** 是否还有未落盘的脏值。 */
  get pending(): boolean;
}

const DEFAULT_FLUSH_DELAY_MS = 2000;

const defaultSchedule = (fn: () => void, ms: number): unknown => setTimeout(fn, ms);

const defaultCancel = (handle: unknown): void => {
  clearTimeout(handle as number);
};

export function createWriteQueue(options: WriteQueueOptions): WriteQueue {
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? defaultCancel;

  const dirty = new Map<string, string>();
  /** 串行链：所有落盘都挂在它后面，保证写入顺序。 */
  let chain: Promise<void> = Promise.resolve();
  /** 串行链上未完成的 flush 个数。`flushSync` 据此决定能否安全插队。 */
  let pendingFlushes = 0;
  let timer: unknown;
  let timerActive = false;

  const clearScheduled = (): void => {
    if (!timerActive) {
      return;
    }
    timerActive = false;
    cancel(timer);
  };

  const takeSnapshot = (): Array<[string, string]> => {
    const snapshot = [...dirty.entries()];
    dirty.clear();
    return snapshot;
  };

  const writeSnapshot = (snapshot: Array<[string, string]>): void => {
    for (const [key, value] of snapshot) {
      try {
        options.storage.setItem(key, value);
      } catch (error) {
        // 不重试：配额满之类的错误重试只会继续失败，交给调用方处理。
        options.onError?.(error, key);
      }
    }
  };

  const flush = (): Promise<void> => {
    clearScheduled();
    // 同步取快照并清空脏表：并发 flush 的第二次调用只会拿到空快照，不会重复写同一 key。
    const snapshot = takeSnapshot();
    pendingFlushes += 1;
    chain = chain
      .catch(() => {})
      .then(() => {
        try {
          writeSnapshot(snapshot);
        } finally {
          // 放在 finally 里：`onError` 自身抛错时链会 reject，计数也得回到零。
          pendingFlushes -= 1;
        }
      });
    return chain;
  };

  /**
   * 同步落盘。
   *
   * 链 pending 时跳过：链上挂着的那次 flush 在入链前就同步取走了脏表快照，此时插队
   * 只能把旧值盖回去或者打乱顺序。跳过时**不清定时器**。
   *
   * 为什么不会「脏值永久不落盘」：`enqueue` 在 `timerActive === false` 时必定排上定时器，
   * 而 `flush()` / `flushSync()` 取快照前都会先 `clearScheduled()`（把 `timerActive`
   * 置回 false）并清空脏表。因此不变式是「脏表非空 ⇒ 定时器已武装」：跳过时脏表里
   * 若有值，它一定挂着合并窗口，到点由异步链写掉。真正的丢失窗口只有一种——跳过之后、
   * 定时器到点之前页面被强杀（或在 bfcache 里被冻结，定时器不走），最长
   * `flushDelayMs`（默认 2 秒）。
   */
  const flushSync = (): void => {
    if (pendingFlushes > 0) {
      return;
    }
    clearScheduled();
    writeSnapshot(takeSnapshot());
  };

  const enqueue = (key: string, value: string): void => {
    dirty.set(key, value);
    if (timerActive) {
      // 合并窗口内只保留一个定时器，不随每次 enqueue 顺延：持续播放时每个窗口落盘一次；
      // 若每次都重置，`timeupdate` 会让定时器永远等不到到点，脏值一直不落盘。
      return;
    }
    timerActive = true;
    timer = schedule(() => {
      timerActive = false;
      void flush();
    }, flushDelayMs);
  };

  return {
    enqueue,
    flush,
    flushSync,
    get pending() {
      return dirty.size > 0;
    },
  };
}

/** 惰性读取 localStorage：import 期不碰全局，node 环境或隐私模式下返回 null。 */
function readLocalStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    // Safari 隐私模式下访问 localStorage 会抛 SecurityError。
    return null;
  }
}

/** 面向 localStorage 的写队列，合并窗口用默认的 2 秒。 */
export function createLocalStorageWriteQueue(): WriteQueue {
  return createWriteQueue({
    storage: {
      setItem: (key, value) => {
        readLocalStorage()?.setItem(key, value);
      },
    },
  });
}

function isPersistedValue(value: unknown): value is StorageValue<unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 把写队列包装成 zustand `persist` 的 storage。
 *
 * 读仍然同步走 localStorage（水合必须是同步的）；只有写进队列，因此同一 key 在一个
 * 合并窗口内只落盘一次。
 */
export function createQueuedPersistStorage<S>(queue: WriteQueue): PersistStorage<S, void> {
  return {
    getItem: (name) => {
      const raw = readLocalStorage()?.getItem(name);
      if (raw === null || raw === undefined) {
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        // 坏 JSON 或非对象存档一律当作没有存档，让 store 用初始值。
        return isPersistedValue(parsed) ? (parsed as StorageValue<S>) : null;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      queue.enqueue(name, JSON.stringify(value));
    },
    removeItem: (name) => {
      readLocalStorage()?.removeItem(name);
    },
  };
}
