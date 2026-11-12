import { MAX_SEARCH_KEYWORD_LENGTH } from '@mlzwl/hongguo-shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createLocalStorageWriteQueue, createQueuedPersistStorage } from '../../lib/write-queue';

/**
 * 搜索历史（P1-5）。
 *
 * 规则对齐上游客户端 `SearchHistory`：`trim` 后为空或超过 80 字符不记录、去重后
 * 只留最近 20 条、最新在前。这几条都在纯函数 `addToHistory` 里，store 只负责
 * 持久化与调用。
 */

/** localStorage 键。沿用上游命名前缀，便于从旧客户端迁移。 */
export const SEARCH_HISTORY_KEY = 'dsh-hongguo.search-history.v1';
/** 单个关键词的最大长度。与后端 schema 共用同一个常量，不再各写一套。 */
export const MAX_KEYWORD_LENGTH = MAX_SEARCH_KEYWORD_LENGTH;
/** 保留条数上限。 */
export const MAX_HISTORY_ITEMS = 20;

/**
 * 把关键词并入历史。
 *
 * 纯函数：同样的输入永远得到同样的输出，方便直接测边界（去重、80 字符、20 条）。
 * 不合法输入（空、纯空白、超长）原样返回 `history`，**返回同一引用**——这样
 * store 里可以用 `===` 判断「没变化就不 set」，避免无意义的落盘。
 */
export function addToHistory(history: readonly string[], keyword: string): readonly string[] {
  const trimmed = keyword.trim();
  if (trimmed === '' || trimmed.length > MAX_KEYWORD_LENGTH) {
    return history;
  }
  // 已存在则先移除，再放到最前：重复搜索同一词应该把它顶到最新，而不是产生第二项。
  const withoutDuplicate = history.filter((item) => item !== trimmed);
  return [trimmed, ...withoutDuplicate].slice(0, MAX_HISTORY_ITEMS);
}

interface SearchHistoryState {
  history: string[];
  add: (keyword: string) => void;
  remove: (keyword: string) => void;
  clear: () => void;
  items: () => string[];
}

/**
 * 写入走串行写队列：搜索历史虽然只在提交时写一次，但和观看记录共用同一套
 * 持久化设施，读同步、写合并，行为一致。
 *
 * `pagehide` / `visibilitychange` 时同步 flush：提交搜索后立刻切走 App 的情况很常见，
 * 排在一个合并窗口之后的写不保证执行。
 */
const searchHistoryQueue = createLocalStorageWriteQueue();

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    searchHistoryQueue.flushSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      searchHistoryQueue.flushSync();
    }
  });
}

export const useSearchHistoryStore = create<SearchHistoryState>()(
  persist(
    (set, get) => ({
      history: [],

      add: (keyword) =>
        set((state) => {
          const next = addToHistory(state.history, keyword);
          // 没变化就不 set：避免一次无意义的持久化写入。
          return next === state.history ? state : { history: [...next] };
        }),

      remove: (keyword) =>
        set((state) => {
          const next = state.history.filter((item) => item !== keyword);
          return next.length === state.history.length ? state : { history: next };
        }),

      clear: () => set({ history: [] }),

      items: () => get().history,
    }),
    {
      name: SEARCH_HISTORY_KEY,
      // 与观看记录用同一套 storage 适配（读同步、写走串行队列）。函数字段
      // `JSON.stringify` 时自然被丢弃，不需要 `partialize`。
      storage: createQueuedPersistStorage<SearchHistoryState>(searchHistoryQueue),
    },
  ),
);
