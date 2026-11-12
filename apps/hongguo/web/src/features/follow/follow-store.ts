import type { FollowRecord, FollowState } from '@mlzwl/hongguo-shared';
// 子路径导入：barrel 会把 zod 打进首屏（见 `definition-selection.ts`）。
import { isCoverProxyUrl } from '@mlzwl/hongguo-shared/definitions';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createLocalStorageWriteQueue, createQueuedPersistStorage } from '../../lib/write-queue';
import { confirmEpisodes, mergeKnownEpisodes } from './follow-model';

/** 落盘的追更记录表。按 `seriesId` 索引，顺序无关。 */
interface FollowPersistedState {
  records: Record<string, FollowRecord>;
}

interface FollowStoreState extends FollowPersistedState {
  /** 收藏或更新一条记录。`checkedAt` 由 store 盖时间戳，调用方不用管。 */
  follow: (record: Omit<FollowRecord, 'checkedAt'>) => void;
  unfollow: (seriesId: string) => void;
  setState: (seriesId: string, state: FollowState) => void;
  /** 用上游最新集数推进高水位（P1-9）。未收藏的剧直接忽略。 */
  syncEpisodes: (seriesId: string, upstreamEpisodes: number) => void;
  /** 用户确认看到第 N 集。只增不减，且不超过已知集数。 */
  confirm: (seriesId: string, seen: number) => void;
  get: (seriesId: string) => FollowRecord | undefined;
  list: () => FollowRecord[];
}

const STORAGE_KEY = 'dsh-hongguo.follow.v1';

const followQueue = createLocalStorageWriteQueue();

// 与 history-store 同样的守卫：`pagehide` 之后页面可能被 bfcache 冻结或直接终止，
// 排在微任务里的 `flush()` 不保证执行，必须同步写一次。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    followQueue.flushSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      followQueue.flushSync();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFollowState(value: unknown): value is FollowState {
  return value === 'planned' || value === 'watching' || value === 'watched';
}

/** 集数只接受非负整数；坏数据落到 0，不能让 `NaN` 传进角标。 */
function sanitizeCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 存档里的类型不可信（用户可能手改 localStorage），逐条校验。
 * 缺字段的记录直接丢弃，`confirmedEpisodes` 不允许超过 `knownEpisodes`。
 */
function sanitizeFollowRecord(raw: unknown): FollowRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { seriesId, seriesTitle, coverUrl, state } = raw;
  if (typeof seriesId !== 'string' || seriesId === '' || typeof seriesTitle !== 'string' || seriesTitle === '') {
    return undefined;
  }
  if (!isFollowState(state)) {
    return undefined;
  }
  const knownEpisodes = sanitizeCount(raw['knownEpisodes']);
  const confirmedEpisodes = Math.min(knownEpisodes, sanitizeCount(raw['confirmedEpisodes']));
  const record: FollowRecord = {
    seriesId,
    seriesTitle,
    state,
    knownEpisodes,
    confirmedEpisodes,
    checkedAt: sanitizeCount(raw['checkedAt']),
  };
  // 只接受本服务的代理地址：旧存档里可能还留着 `/api/cover?u=<上游签名 URL>`，
  // 服务端删掉旧路由不会清掉它，继续用就等于把签名重新送进 DOM。
  if (typeof coverUrl === 'string' && isCoverProxyUrl(coverUrl)) {
    record.coverUrl = coverUrl;
  }
  return record;
}

function sanitizeRecords(persisted: unknown): FollowPersistedState {
  if (!isRecord(persisted) || !isRecord(persisted['records'])) {
    return { records: {} };
  }
  const records: Record<string, FollowRecord> = {};
  for (const [key, value] of Object.entries(persisted['records'])) {
    const record = sanitizeFollowRecord(value);
    if (record !== undefined && record.seriesId === key) {
      records[key] = record;
    }
  }
  return { records };
}

/** 追更（收藏）状态机（P1-8 / P1-9）。键 `dsh-hongguo.follow.v1`。 */
export const useFollowStore = create<FollowStoreState>()(
  persist(
    (set, get) => ({
      records: {},

      follow: (record) =>
        set((state) => ({
          records: { ...state.records, [record.seriesId]: { ...record, checkedAt: Date.now() } },
        })),

      unfollow: (seriesId) =>
        set((state) => {
          if (state.records[seriesId] === undefined) {
            return state;
          }
          const next = { ...state.records };
          delete next[seriesId];
          return { records: next };
        }),

      setState: (seriesId, nextState) =>
        set((state) => {
          const record = state.records[seriesId];
          if (record === undefined || record.state === nextState) {
            return state;
          }
          return { records: { ...state.records, [seriesId]: { ...record, state: nextState } } };
        }),

      syncEpisodes: (seriesId, upstreamEpisodes) =>
        set((state) => {
          const record = state.records[seriesId];
          if (record === undefined) {
            return state;
          }
          const merged = mergeKnownEpisodes(record, upstreamEpisodes, Date.now());
          if (merged === record) {
            return state;
          }
          return { records: { ...state.records, [seriesId]: merged } };
        }),

      confirm: (seriesId, seen) =>
        set((state) => {
          const record = state.records[seriesId];
          if (record === undefined) {
            return state;
          }
          const merged = confirmEpisodes(record, seen);
          if (merged === record) {
            return state;
          }
          return { records: { ...state.records, [seriesId]: merged } };
        }),

      get: (seriesId) => get().records[seriesId],

      list: () => Object.values(get().records),
    }),
    {
      name: STORAGE_KEY,
      /* 版本 2：水合时丢弃不符合 `/api/cover/<令牌>` 形态的 `coverUrl`。 */
      version: 2,
      storage: createQueuedPersistStorage<FollowPersistedState>(followQueue),
      // 旧存档没有版本号（version 0），统一过一遍校验，把坏数据和越界的集数清掉。
      migrate: (persistedState) => sanitizeRecords(persistedState),
      // 水合时不信任存档里的类型：即便版本号匹配也要再校验一次。
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...sanitizeRecords(persistedState),
      }),
      partialize: (state) => ({ records: state.records }),
    },
  ),
);
