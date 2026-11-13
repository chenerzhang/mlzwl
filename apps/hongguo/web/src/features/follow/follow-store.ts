import type { FollowRecord } from '@mlzwl/hongguo-shared';
// 子路径导入：barrel 会把 zod 打进首屏（见 `definition-selection.ts`）。
import { isCoverProxyUrl } from '@mlzwl/hongguo-shared/definitions';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createLocalStorageWriteQueue, createQueuedPersistStorage } from '../../lib/write-queue';
import {
  applyRecord,
  buildTrackingRecord,
  clearFavoriteFlag,
  clearFollowingFlag,
  confirmEpisodes,
  followFlags,
  isBlankRecord,
  mergeKnownEpisodes,
  type TrackingInput,
} from './follow-model';

/** 落盘的记录表。按 `seriesId` 索引，顺序无关。 */
interface FollowPersistedState {
  records: Record<string, FollowRecord>;
}

interface FollowStoreState extends FollowPersistedState {
  /** 收藏。未收藏的剧直接新建一条记录（只开收藏、不开追更）。 */
  addFavorite: (input: TrackingInput) => void;
  /** 取消收藏。追更还在时保留记录，两者都没了才删整条。 */
  removeFavorite: (seriesId: string) => void;
  /** 开追更。 */
  startFollowing: (input: TrackingInput) => void;
  /** 关追更。 */
  stopFollowing: (seriesId: string) => void;
  /** 用上游最新集数推进高水位（P1-9）。未收藏的剧直接忽略。 */
  syncEpisodes: (seriesId: string, upstreamEpisodes: number) => void;
  /** 用户确认看到第 N 集。只增不减，且不超过已知集数。 */
  confirm: (seriesId: string, seen: number) => void;
}

/** 新建一条记录时需要调用方提供的信息。两个标记由具体的动作决定，不在入参里。 */
export type { TrackingInput };

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

/** 集数只接受非负整数；坏数据落到 0，不能让 `NaN` 传进角标。 */
function sanitizeCount(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 存档里的类型不可信（用户可能手改 localStorage），逐条校验。
 *
 * 两个标记必须是真正的 `boolean`；都缺或都为 `false` 的记录直接丢弃。
 * `confirmedEpisodes` 不允许超过 `knownEpisodes`。
 *
 * 旧版本的 `state: 'planned' | 'watching' | 'watched'` 存档在这里自然被丢弃：
 * 它们没有 `favorite` / `following` 字段，校验不通过。**不做迁移**——
 * 用户已确认「老数据可直接清除」。
 */
function sanitizeFollowRecord(raw: unknown): FollowRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { seriesId, seriesTitle, coverUrl, favorite, following } = raw;
  if (typeof seriesId !== 'string' || seriesId === '' || typeof seriesTitle !== 'string' || seriesTitle === '') {
    return undefined;
  }
  if (typeof favorite !== 'boolean' || typeof following !== 'boolean') {
    return undefined;
  }
  if (isBlankRecord({ favorite, following })) {
    return undefined;
  }
  const knownEpisodes = sanitizeCount(raw['knownEpisodes']);
  const confirmedEpisodes = Math.min(knownEpisodes, sanitizeCount(raw['confirmedEpisodes']));
  const record: FollowRecord = {
    seriesId,
    seriesTitle,
    favorite,
    following,
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

/** 收藏与追更（P1-8 / P1-9）。键 `dsh-hongguo.follow.v1`。 */
export const useFollowStore = create<FollowStoreState>()(
  persist(
    (set) => ({
      records: {},

      addFavorite: (input) =>
        set((state) => ({
          records: applyRecord(
            state.records,
            buildTrackingRecord(state.records[input.seriesId], input, 'favorite', Date.now()),
          ),
        })),

      removeFavorite: (seriesId) =>
        set((state) => {
          const record = state.records[seriesId];
          if (record === undefined || !record.favorite) {
            return state;
          }
          return { records: applyRecord(state.records, { ...record, ...clearFavoriteFlag(followFlags(record)) }) };
        }),

      startFollowing: (input) =>
        set((state) => ({
          records: applyRecord(
            state.records,
            buildTrackingRecord(state.records[input.seriesId], input, 'following', Date.now()),
          ),
        })),

      stopFollowing: (seriesId) =>
        set((state) => {
          const record = state.records[seriesId];
          if (record === undefined || !record.following) {
            return state;
          }
          return { records: applyRecord(state.records, { ...record, ...clearFollowingFlag(followFlags(record)) }) };
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
    }),
    {
      name: STORAGE_KEY,
      /* 版本 3：`state` 三态改为 `favorite` / `following` 两个布尔量，旧存档直接丢弃。 */
      version: 3,
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
