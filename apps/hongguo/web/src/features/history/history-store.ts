import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createLocalStorageWriteQueue, createQueuedPersistStorage } from '../../lib/write-queue';

/** 一条观看记录。 */
export interface WatchEntry {
  seriesId: string;
  seriesTitle: string;
  coverUrl?: string;
  episodeId: string;
  episodeNumber: number;
  /** 已看到第几秒。 */
  position: number;
  /** 该集总时长。 */
  duration: number;
  /**
   * 该集是否已看完（P1-10）。
   *
   * 可选是因为旧存档里没有这个字段，水合时由 `migrate` 补 `false`；写入路径一律会
   * 显式给值，所以读取方拿到的记录总是有意义的布尔值。
   */
  completed?: boolean;
  updatedAt: number;
}

/** 进度达到这个比例就算看完。95% 是上游 `Watching.kt` 的口径。 */
export const COMPLETION_RATIO = 0.95;

/** 一集的进度是否算看完。`duration` 未知（0 / NaN）时一律不算。 */
export function isEpisodeCompleted(position: number, duration: number): boolean {
  return (
    Number.isFinite(duration) && duration > 0 && Number.isFinite(position) && position / duration >= COMPLETION_RATIO
  );
}

/** `record()` 的入参：`updatedAt` 由 store 盖，`completed` 可省略（省略时按进度算）。 */
export type RecordInput = Omit<WatchEntry, 'updatedAt' | 'completed'> & { completed?: boolean };

/** 落盘的部分：只有记录表，动作函数不进存档。 */
interface HistoryPersistedState {
  entries: Record<string, WatchEntry>;
}

interface HistoryState {
  entries: Record<string, WatchEntry>;
  record: (entry: RecordInput) => void;
  get: (seriesId: string) => WatchEntry | undefined;
  remove: (seriesId: string) => void;
  clear: () => void;
  recent: (limit?: number) => WatchEntry[];
}

/**
 * 观看记录。
 *
 * localStorage 键沿用上游 `dsh-hongguo.watch-history.v1`，便于从旧客户端迁移。
 * 只保留最近 100 条，避免无限增长。
 *
 * 写入走串行写队列（P1-2 / P1-3）：`record()` 在播放期每秒触发数次，每次整体序列化
 * 落盘既慢又浪费，改成 2 秒合并窗口内只写一次最新快照。
 */
const MAX_ENTRIES = 100;
const STORAGE_KEY = 'dsh-hongguo.watch-history.v1';

const historyQueue = createLocalStorageWriteQueue();

// 页面被隐藏或关闭时不能再等满一个合并窗口，必须**同步**写一次：
// `pagehide` 之后页面可能被 bfcache 冻结或直接被终止，排在微任务里的 `flush()` 不保证
// 执行（P1-2 要求 `pagehide` 时同步 flush）。
// `visibilitychange` 比 `pagehide` 更早也更可靠（切换 App、锁屏、切标签都会触发），
// 两个都挂上：先到的那个把值写掉，后到的看到空脏表就是空写。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    historyQueue.flushSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      historyQueue.flushSync();
    }
  });
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      entries: {},

      record: ({ completed, ...entry }) =>
        set((state) => {
          // 调用方显式标记（`ended` 事件）或进度越过 95% 阈值都算看完。
          // 不做成「一旦为真就永远为真」：用户重看同一集时进度回落到开头，
          // 应当重新从原位置续播，而不是被跳到下一集。
          const next = {
            ...state.entries,
            [entry.seriesId]: {
              ...entry,
              completed: completed === true || isEpisodeCompleted(entry.position, entry.duration),
              updatedAt: Date.now(),
            },
          };
          const sorted = Object.values(next)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_ENTRIES);
          const trimmed: Record<string, WatchEntry> = {};
          for (const item of sorted) {
            trimmed[item.seriesId] = item;
          }
          return { entries: trimmed };
        }),

      get: (seriesId) => get().entries[seriesId],

      remove: (seriesId) =>
        set((state) => {
          const next = { ...state.entries };
          delete next[seriesId];
          return { entries: next };
        }),

      clear: () => set({ entries: {} }),

      recent: (limit = 20) =>
        Object.values(get().entries)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, limit),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createQueuedPersistStorage<HistoryPersistedState>(historyQueue),
      // 旧存档没有 `completed` 字段（version 0），逐条补 `false`。
      // 这里只做「缺字段补默认」，不校验类型：写队列和 `record()` 是唯一写入路径，
      // 存档形状由本文件自己控制，校验逻辑堆在这里反而会掩盖真实 bug。
      migrate: (persistedState) => {
        if (typeof persistedState !== 'object' || persistedState === null) {
          return { entries: {} };
        }
        const entries = (persistedState as { entries?: unknown }).entries;
        if (typeof entries !== 'object' || entries === null) {
          return { entries: {} };
        }
        const migrated: Record<string, WatchEntry> = {};
        for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
          if (typeof value !== 'object' || value === null) {
            continue;
          }
          const entry = value as WatchEntry;
          migrated[key] = entry.completed === true ? entry : { ...entry, completed: false };
        }
        return { entries: migrated };
      },
    },
  ),
);
