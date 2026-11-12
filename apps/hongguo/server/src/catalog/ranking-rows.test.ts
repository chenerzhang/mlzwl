import { describe, expect, it } from 'vitest';
import { pickNextCursor, toRankingEntries } from './ranking-rows.js';

type Rows = Parameters<typeof toRankingEntries>[0];

function dirty(rows: unknown[]): Rows {
  return rows as Rows;
}

describe('toRankingEntries', () => {
  it('maps a valid row and preserves display text', () => {
    expect(
      toRankingEntries([
        {
          position: 1,
          rank: 99,
          series_id: 's1',
          title: '长生',
          cover_url: 'https://example.test/cover.jpg',
          episode_count: 78,
          score: '8835万热度',
          promoted: true,
        },
      ]),
    ).toEqual([
      {
        position: 1,
        seriesId: 's1',
        title: '长生',
        coverUrl: 'https://example.test/cover.jpg',
        episodeCount: 78,
        score: '8835万热度',
        promoted: true,
      },
    ]);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN])('drops invalid position %s', (position) => {
    expect(toRankingEntries([{ position, series_id: 's1', title: '长生' }])).toEqual([]);
  });

  it('uses position even when rank is duplicated', () => {
    expect(
      toRankingEntries([
        { position: 5, rank: 5, series_id: 'promoted', title: '推广' },
        { position: 6, rank: 5, series_id: 'normal', title: '正榜' },
      ]),
    ).toEqual([
      { position: 5, seriesId: 'promoted', title: '推广' },
      { position: 6, seriesId: 'normal', title: '正榜' },
    ]);
  });

  it.each([undefined, 123, '', '   '])('drops invalid series_id %s', (seriesId) => {
    expect(toRankingEntries(dirty([{ position: 1, series_id: seriesId, title: '长生' }]))).toEqual([]);
  });

  it.each([undefined, 123, '', '   '])('drops invalid title %s', (title) => {
    expect(toRankingEntries(dirty([{ position: 1, series_id: 's1', title }]))).toEqual([]);
  });

  it.each(['78', -1, 1.5])('drops invalid episode_count %s', (episodeCount) => {
    expect(
      toRankingEntries(dirty([{ position: 1, series_id: 's1', title: '长生', episode_count: episodeCount }])),
    ).toEqual([]);
  });

  it('omits coverUrl when cover_url is not a string', () => {
    const [entry] = toRankingEntries(dirty([{ position: 1, series_id: 's1', title: '长生', cover_url: 123 }]));
    expect(entry).toEqual({ position: 1, seriesId: 's1', title: '长生' });
    expect(entry === undefined ? false : 'coverUrl' in entry).toBe(false);
  });

  it('omits score when score is not a string', () => {
    const [entry] = toRankingEntries(dirty([{ position: 1, series_id: 's1', title: '长生', score: 123 }]));
    expect(entry === undefined ? false : 'score' in entry).toBe(false);
  });

  it('omits promoted when promoted is not a boolean', () => {
    const [entry] = toRankingEntries(dirty([{ position: 1, series_id: 's1', title: '长生', promoted: 1 }]));
    expect(entry === undefined ? false : 'promoted' in entry).toBe(false);
  });

  it('deduplicates by series_id keeping the first row and position', () => {
    expect(
      toRankingEntries([
        { position: 2, series_id: 's1', title: '首次' },
        { position: 3, series_id: 's1', title: '重复' },
      ]),
    ).toEqual([{ position: 2, seriesId: 's1', title: '首次' }]);
  });

  it('keeps upstream order instead of sorting by position', () => {
    expect(
      toRankingEntries([
        { position: 3, series_id: 's3', title: '第三' },
        { position: 1, series_id: 's1', title: '第一' },
      ]).map((entry) => entry.position),
    ).toEqual([3, 1]);
  });
});

describe('pickNextCursor', () => {
  it('returns the cursor unchanged when another page exists', () => {
    expect(pickNextCursor(true, 'next')).toBe('next');
  });

  it('returns null when has_more is false', () => {
    expect(pickNextCursor(false, 'next')).toBeNull();
  });

  it('returns null when the cursor is missing, empty or not a string', () => {
    expect(pickNextCursor(true, undefined)).toBeNull();
    expect(pickNextCursor(true, '')).toBeNull();
    expect(pickNextCursor(true, 123 as unknown as string)).toBeNull();
  });
});
