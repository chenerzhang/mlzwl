import type { FollowRecord, FollowState } from '@mlzwl/hongguo-shared';
import { describe, expect, it } from 'vitest';
import { FAVORITE_GROUPS, favoritesSummary, favoritesTabs, groupFavorites, resolveInitialTab } from './favorites-view';

function record(
  seriesId: string,
  state: FollowState,
  checkedAt: number,
  knownEpisodes = 10,
  confirmedEpisodes = 10,
): FollowRecord {
  return {
    seriesId,
    seriesTitle: `短剧 ${seriesId}`,
    state,
    knownEpisodes,
    confirmedEpisodes,
    checkedAt,
  };
}

describe('groupFavorites', () => {
  it('keeps the fixed group order and includes empty groups', () => {
    const groups = groupFavorites([record('planned-1', 'planned', 1)]);

    expect(groups.map((group) => group.state)).toEqual(['watching', 'planned', 'watched']);
    expect(groups.map((group) => group.title)).toEqual(['在看', '想看', '看完']);
    expect(groups[0]?.records).toEqual([]);
    expect(groups[1]?.records.map((item) => item.seriesId)).toEqual(['planned-1']);
    expect(groups[2]?.records).toEqual([]);
    expect(groups.map((group) => group.emptyHint)).toEqual(FAVORITE_GROUPS.map((group) => group.emptyHint));
  });

  it('puts updated records first, then sorts each tier by checkedAt descending', () => {
    const groups = groupFavorites([
      record('old-current', 'watching', 10),
      record('new-update', 'watching', 40, 12, 10),
      record('old-update', 'watching', 20, 11, 10),
      record('new-current', 'watching', 30),
    ]);

    expect(groups[0]?.records.map((item) => item.seriesId)).toEqual([
      'new-update',
      'old-update',
      'new-current',
      'old-current',
    ]);
  });

  it('does not mutate the input records or their order', () => {
    const records = [record('first', 'watching', 1), record('second', 'watching', 2, 12, 10)];
    const before = structuredClone(records);

    groupFavorites(records);

    expect(records).toEqual(before);
  });

  it('returns every empty group for an empty input', () => {
    const groups = groupFavorites([]);

    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.records.length === 0)).toBe(true);
  });
});

describe('favoritesTabs', () => {
  it('maps records to tabs in watching, planned, watched order with correct counts', () => {
    const tabs = favoritesTabs([
      record('watched-1', 'watched', 1),
      record('watching-1', 'watching', 2),
      record('planned-1', 'planned', 3),
      record('watching-2', 'watching', 4),
    ]);

    expect(tabs.map((tab) => tab.state)).toEqual(['watching', 'planned', 'watched']);
    expect(tabs.map((tab) => tab.records.length)).toEqual([2, 1, 1]);
  });

  it('selects the first non-empty tab by default', () => {
    expect(resolveInitialTab(favoritesTabs([record('planned-1', 'planned', 1)]))).toBe('planned');
  });

  it('selects the first tab when every tab is empty', () => {
    expect(resolveInitialTab(favoritesTabs([]))).toBe('watching');
  });

  it('keeps a tab selectable with its empty hint after its last record is removed', () => {
    const before = favoritesTabs([record('watching-1', 'watching', 1)]);
    const after = favoritesTabs([]);
    const selectedState = resolveInitialTab(before);
    const selectedAfterRemoval = after.find((tab) => tab.state === selectedState);

    expect(selectedAfterRemoval).toMatchObject({
      state: 'watching',
      records: [],
      emptyHint: '还没有正在看的短剧',
    });
  });
});

describe('favoritesSummary', () => {
  it('counts all records and records with updates', () => {
    expect(
      favoritesSummary([
        record('current', 'watching', 1),
        record('update-1', 'planned', 2, 11, 10),
        record('update-2', 'watched', 3, 12, 10),
      ]),
    ).toEqual({ total: 3, withUpdates: 2 });
  });

  it('returns zero counts for an empty input', () => {
    expect(favoritesSummary([])).toEqual({ total: 0, withUpdates: 0 });
  });
});
