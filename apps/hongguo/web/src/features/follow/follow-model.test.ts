import type { FollowRecord } from '@mlzwl/hongguo-shared';
import { describe, expect, it } from 'vitest';
import {
  applyRecord,
  buildTrackingRecord,
  clearFavoriteFlag,
  confirmEpisodes,
  followFlags,
  hasUpdates,
  isBlankRecord,
  mergeKnownEpisodes,
  newEpisodes,
  normalizeCount,
  clearFollowingFlag,
  type TrackingInput,
} from './follow-model';

/**
 * 收藏与追更纯逻辑测试（P1-8 / P1-9）。
 *
 * 不引入 jsdom：被测模块 import 期不访问 `window`，`FollowRecord` 是 type-only
 * 导入，zod 不会进测试进程。
 */

function makeRecord(overrides: Partial<FollowRecord> = {}): FollowRecord {
  return {
    seriesId: 's1',
    seriesTitle: '测试剧',
    favorite: true,
    following: true,
    knownEpisodes: 104,
    confirmedEpisodes: 100,
    checkedAt: 1_000,
    ...overrides,
  };
}

describe('newEpisodes', () => {
  it('returns the difference when upstream is ahead', () => {
    expect(newEpisodes({ knownEpisodes: 104, confirmedEpisodes: 100 })).toBe(4);
  });

  it('never goes negative when confirmed is ahead of known', () => {
    expect(newEpisodes({ knownEpisodes: 100, confirmedEpisodes: 104 })).toBe(0);
    expect(newEpisodes({ knownEpisodes: 0, confirmedEpisodes: 0 })).toBe(0);
  });
});

describe('hasUpdates', () => {
  it('reports updates only for records that are being followed', () => {
    expect(hasUpdates({ following: true, knownEpisodes: 104, confirmedEpisodes: 100 })).toBe(true);
    // 只收藏不追更：不弹「更新 N 集」角标。
    expect(hasUpdates({ following: false, knownEpisodes: 104, confirmedEpisodes: 100 })).toBe(false);
  });

  it('reports no updates once everything is confirmed', () => {
    expect(hasUpdates({ following: true, knownEpisodes: 104, confirmedEpisodes: 104 })).toBe(false);
    expect(hasUpdates({ following: true, knownEpisodes: 100, confirmedEpisodes: 104 })).toBe(false);
  });
});

describe('followFlags', () => {
  it('returns both flags from a record', () => {
    expect(followFlags(makeRecord({ favorite: true, following: false }))).toEqual({ favorite: true, following: false });
    expect(followFlags(makeRecord({ favorite: false, following: true }))).toEqual({ favorite: false, following: true });
  });

  it('treats a missing record as both flags off', () => {
    expect(followFlags(undefined)).toEqual({ favorite: false, following: false });
  });
});

describe('clearFollowingFlag', () => {
  it('only ever turns following off, never on', () => {
    // 清位语义：已关的保持关，已开的变关。若是「翻转」，第二条会变成 true。
    expect(clearFollowingFlag({ favorite: true, following: false })).toEqual({ favorite: true, following: false });
    expect(clearFollowingFlag({ favorite: true, following: true })).toEqual({ favorite: true, following: false });
  });

  it('leaves the favorite flag untouched in both directions', () => {
    expect(clearFollowingFlag({ favorite: false, following: false }).favorite).toBe(false);
    expect(clearFollowingFlag({ favorite: false, following: true }).favorite).toBe(false);
  });
});

describe('clearFavoriteFlag', () => {
  it('clears favorite and keeps following', () => {
    expect(clearFavoriteFlag({ favorite: true, following: true })).toEqual({ favorite: false, following: true });
  });

  it('is idempotent when favorite is already off', () => {
    expect(clearFavoriteFlag({ favorite: false, following: true })).toEqual({ favorite: false, following: true });
  });
});

describe('isBlankRecord', () => {
  it('is blank only when both flags are off', () => {
    expect(isBlankRecord({ favorite: false, following: false })).toBe(true);
    expect(isBlankRecord({ favorite: true, following: false })).toBe(false);
    expect(isBlankRecord({ favorite: false, following: true })).toBe(false);
    expect(isBlankRecord({ favorite: true, following: true })).toBe(false);
  });
});

describe('mergeKnownEpisodes', () => {
  it('raises the high-water mark when upstream grows', () => {
    const merged = mergeKnownEpisodes(makeRecord({ knownEpisodes: 104 }), 110, 2_000);
    expect(merged.knownEpisodes).toBe(110);
    expect(merged.checkedAt).toBe(2_000);
  });

  it('keeps the old high-water mark when upstream reports fewer episodes', () => {
    const record = makeRecord({ knownEpisodes: 104, checkedAt: 1_000 });
    const merged = mergeKnownEpisodes(record, 90, 2_000);
    expect(merged.knownEpisodes).toBe(104);
    // 没有新信息就不该刷新 `checkedAt`，否则「上次对账时间」会被空跑覆盖。
    expect(merged.checkedAt).toBe(1_000);
    expect(merged).toBe(record);
  });

  it('keeps the old checkedAt when the clock goes backwards', () => {
    const merged = mergeKnownEpisodes(makeRecord({ knownEpisodes: 104, checkedAt: 5_000 }), 110, 4_000);
    expect(merged.knownEpisodes).toBe(110);
    expect(merged.checkedAt).toBe(5_000);
  });

  it('ignores invalid upstream values instead of corrupting the record', () => {
    const record = makeRecord();
    expect(mergeKnownEpisodes(record, Number.NaN, 2_000)).toBe(record);
    expect(mergeKnownEpisodes(record, -1, 2_000)).toBe(record);
    expect(mergeKnownEpisodes(record, Number.POSITIVE_INFINITY, 2_000)).toBe(record);
  });

  it('floors fractional upstream counts', () => {
    expect(mergeKnownEpisodes(makeRecord({ knownEpisodes: 10 }), 12.9, 2_000).knownEpisodes).toBe(12);
  });

  it('returns the same object when nothing changed', () => {
    const record = makeRecord({ knownEpisodes: 104, checkedAt: 2_000 });
    expect(mergeKnownEpisodes(record, 104, 2_000)).toBe(record);
  });

  it('never touches either flag or confirmedEpisodes', () => {
    const merged = mergeKnownEpisodes(makeRecord(), 200, 2_000);
    expect(merged.favorite).toBe(true);
    expect(merged.following).toBe(true);
    expect(merged.confirmedEpisodes).toBe(100);
  });
});

describe('confirmEpisodes', () => {
  it('raises confirmedEpisodes monotonically', () => {
    expect(confirmEpisodes(makeRecord({ confirmedEpisodes: 10 }), 20).confirmedEpisodes).toBe(20);
  });

  it('ignores a smaller value (high-water mark)', () => {
    const record = makeRecord({ confirmedEpisodes: 20 });
    expect(confirmEpisodes(record, 5)).toBe(record);
  });

  it('clamps to knownEpisodes', () => {
    expect(confirmEpisodes(makeRecord({ knownEpisodes: 12, confirmedEpisodes: 3 }), 99).confirmedEpisodes).toBe(12);
  });

  it('ignores invalid input', () => {
    const record = makeRecord({ confirmedEpisodes: 3 });
    expect(confirmEpisodes(record, Number.NaN)).toBe(record);
  });

  it('leaves newEpisodes at zero once everything is confirmed', () => {
    const confirmed = confirmEpisodes(makeRecord({ knownEpisodes: 104, confirmedEpisodes: 100 }), 104);
    expect(newEpisodes(confirmed)).toBe(0);
  });
});

describe('normalizeCount', () => {
  it('floors positives and rejects everything else', () => {
    expect(normalizeCount(12)).toBe(12);
    expect(normalizeCount(12.9)).toBe(12);
    expect(normalizeCount(0)).toBe(0);
    expect(normalizeCount(-3)).toBe(0);
    expect(normalizeCount(Number.NaN)).toBe(0);
    expect(normalizeCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

function input(overrides: Partial<TrackingInput> = {}): TrackingInput {
  return { seriesId: 's1', seriesTitle: '测试剧', knownEpisodes: 78, seenEpisodes: 0, ...overrides };
}

describe('buildTrackingRecord', () => {
  it('does not report the whole back catalogue as updates when following starts', () => {
    // 用户刚点追更，一部 78 集的剧不该立刻报「更新 78 集」——
    // 他没有错过这 78 集，只是刚决定追它。
    const record = buildTrackingRecord(undefined, input(), 'following', 1_000);

    expect(record.knownEpisodes).toBe(78);
    expect(record.confirmedEpisodes).toBe(78);
    expect(hasUpdates(record)).toBe(false);
    expect(record.following).toBe(true);
    expect(record.favorite).toBe(false);
  });

  it('keeps the favorite baseline low so a later follow can still surface missed episodes', () => {
    // 收藏不产生角标，所以不该提前推高水位；否则以后真追更时看不到错过的集数。
    const record = buildTrackingRecord(undefined, input(), 'favorite', 1_000);

    expect(record.favorite).toBe(true);
    expect(record.following).toBe(false);
    expect(record.confirmedEpisodes).toBe(0);
    expect(hasUpdates(record)).toBe(false);
  });

  it('does not truncate the real watch high-water mark when upstream under-reports', () => {
    // 已经看到第 100 集，但上游这次只报 78 集。若只看上游值，
    // confirmedEpisodes 会被钳成 78，上游恢复到 104 集后就会误报「更新 26 集」。
    const record = buildTrackingRecord(undefined, input({ knownEpisodes: 78, seenEpisodes: 100 }), 'favorite', 1_000);

    expect(record.knownEpisodes).toBe(100);
    expect(record.confirmedEpisodes).toBe(100);
  });

  it('takes the max of existing, upstream and watch history for knownEpisodes', () => {
    const existing = makeRecord({ knownEpisodes: 104, confirmedEpisodes: 100 });
    const record = buildTrackingRecord(existing, input({ knownEpisodes: 90, seenEpisodes: 60 }), 'favorite', 1_000);

    expect(record.knownEpisodes).toBe(104);
    expect(record.confirmedEpisodes).toBe(100);
  });

  it('gives the same result whichever flag is opened first', () => {
    const favoriteFirst = buildTrackingRecord(undefined, input(), 'favorite', 1_000);
    const followingFirst = buildTrackingRecord(favoriteFirst, input(), 'following', 1_000);

    const followingOnly = buildTrackingRecord(undefined, input(), 'following', 1_000);
    const favoriteSecond = buildTrackingRecord(followingOnly, input(), 'favorite', 1_000);

    expect(favoriteSecond.favorite).toBe(true);
    expect(favoriteSecond.following).toBe(true);
    expect(followingFirst.favorite).toBe(true);
    expect(followingFirst.following).toBe(true);
    // 两个标记都在，且数字不因点击顺序不同而不同。
    expect(favoriteSecond.knownEpisodes).toBe(followingFirst.knownEpisodes);
    expect(favoriteSecond.confirmedEpisodes).toBe(followingFirst.confirmedEpisodes);
  });

  it('does not reset the baseline when following is already on', () => {
    const existing = makeRecord({ following: true, knownEpisodes: 104, confirmedEpisodes: 100 });
    const record = buildTrackingRecord(existing, input({ knownEpisodes: 104 }), 'following', 1_000);

    // 已经在追更，再点一次不该把「更新 4 集」抹掉。
    expect(record.confirmedEpisodes).toBe(100);
    expect(hasUpdates(record)).toBe(true);
  });

  it('keeps the existing cover when this call has none', () => {
    const existing = makeRecord({ coverUrl: '/api/cover/token' });
    const record = buildTrackingRecord(existing, input(), 'favorite', 1_000);

    expect(record.coverUrl).toBe('/api/cover/token');
  });

  it('prefers the new cover when one is provided', () => {
    const existing = makeRecord({ coverUrl: '/api/cover/old' });
    const record = buildTrackingRecord(existing, input({ coverUrl: '/api/cover/new' }), 'favorite', 1_000);

    expect(record.coverUrl).toBe('/api/cover/new');
  });

  it('stamps the injected time instead of reading the clock', () => {
    expect(buildTrackingRecord(undefined, input(), 'favorite', 12_345).checkedAt).toBe(12_345);
  });
});

describe('applyRecord', () => {
  it('keeps a record that still has one flag on', () => {
    const records = applyRecord({}, makeRecord({ favorite: false, following: true }));

    expect(Object.keys(records)).toEqual(['s1']);
  });

  it('drops the record once both flags are off', () => {
    const records = applyRecord({ s1: makeRecord() }, makeRecord({ favorite: false, following: false }));

    expect(records).toEqual({});
  });

  it('does not mutate the input table', () => {
    const original = { s1: makeRecord() };
    const before = structuredClone(original);

    applyRecord(original, makeRecord({ favorite: false, following: false }));

    expect(original).toEqual(before);
  });
});
