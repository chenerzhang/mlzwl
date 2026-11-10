import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  updatedAt: number;
}

interface HistoryState {
  entries: Record<string, WatchEntry>;
  record: (entry: Omit<WatchEntry, 'updatedAt'>) => void;
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
 */
const MAX_ENTRIES = 100;

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set, get) => ({
      entries: {},

      record: (entry) =>
        set((state) => {
          const next = { ...state.entries, [entry.seriesId]: { ...entry, updatedAt: Date.now() } };
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
    { name: 'dsh-hongguo.watch-history.v1' },
  ),
);
