import type { FollowRecord } from '@mlzwl/hongguo-shared';
import { describe, expect, it } from 'vitest';
import { favoriteEntries, favoritesSummary } from './favorites-view';

function record(
  seriesId: string,
  flags: { favorite: boolean; following: boolean },
  checkedAt: number,
  knownEpisodes = 10,
  confirmedEpisodes = 10,
): FollowRecord {
  return {
    seriesId,
    seriesTitle: `短剧 ${seriesId}`,
    favorite: flags.favorite,
    following: flags.following,
    knownEpisodes,
    confirmedEpisodes,
    checkedAt,
  };
}

const BOTH = { favorite: true, following: true };
const FAVORITE_ONLY = { favorite: true, following: false };
const FOLLOWING_ONLY = { favorite: false, following: true };

describe('favoriteEntries', () => {
  it('only lists records that are favorited', () => {
    const entries = favoriteEntries([
      record('fav', FAVORITE_ONLY, 1),
      record('follow-only', FOLLOWING_ONLY, 2),
      record('both', BOTH, 3),
    ]);

    expect(entries.map((entry) => entry.record.seriesId)).toEqual(['both', 'fav']);
  });

  it('excludes a series whose favorite was cleared but following was kept', () => {
    const entries = favoriteEntries([record('follow-only', FOLLOWING_ONLY, 1)]);

    expect(entries).toEqual([]);
  });

  it('puts records with updates first, then sorts by checkedAt descending', () => {
    const entries = favoriteEntries([
      record('old-current', FAVORITE_ONLY, 10),
      record('new-update', BOTH, 40, 12, 10),
      record('old-update', BOTH, 20, 11, 10),
      record('new-current', FAVORITE_ONLY, 30),
    ]);

    expect(entries.map((entry) => entry.record.seriesId)).toEqual([
      'new-update',
      'old-update',
      'new-current',
      'old-current',
    ]);
  });

  it('does not count updates for a record that is only favorited', () => {
    const entries = favoriteEntries([record('fav', FAVORITE_ONLY, 1, 20, 5)]);

    expect(entries[0]?.hasUpdates).toBe(false);
  });

  it('exposes the following flag through the record so the card can render the bell', () => {
    const entries = favoriteEntries([record('both', BOTH, 1), record('fav', FAVORITE_ONLY, 2)]);

    // 按 id 取而不是按数组位置：排序规则属于另一个用例，这里只验证标志位没被丢。
    expect(Object.fromEntries(entries.map((entry) => [entry.record.seriesId, entry.record.following]))).toEqual({
      both: true,
      fav: false,
    });
  });

  it('does not mutate the input records or their order', () => {
    const records = [record('first', FAVORITE_ONLY, 1), record('second', BOTH, 2, 12, 10)];
    const before = structuredClone(records);

    favoriteEntries(records);

    expect(records).toEqual(before);
  });

  it('returns an empty list for an empty input', () => {
    expect(favoriteEntries([])).toEqual([]);
  });
});

describe('favoritesSummary', () => {
  it('counts favorited records and those with updates among them', () => {
    expect(
      favoritesSummary([
        record('current', FAVORITE_ONLY, 1),
        record('update-1', BOTH, 2, 11, 10),
        record('update-2', BOTH, 3, 12, 10),
        // 追更但没收藏：不进总数，也不进「有更新」。
        record('follow-only', FOLLOWING_ONLY, 4, 20, 10),
      ]),
    ).toEqual({ total: 3, withUpdates: 2 });
  });

  it('returns zero counts for an empty input', () => {
    expect(favoritesSummary([])).toEqual({ total: 0, withUpdates: 0 });
  });

  it('counts a favorite-only record with new episodes as no update', () => {
    expect(favoritesSummary([record('fav', FAVORITE_ONLY, 1, 20, 5)])).toEqual({ total: 1, withUpdates: 0 });
  });
});
