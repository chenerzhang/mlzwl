import type { SeriesPage } from '@mlzwl/hongguo-shared';
import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from './offline-catalog';
import {
  buildFeedQueryOptions,
  canAdvanceFeedPage,
  canStartFeedFill,
  FEED_FILL_COOLDOWN_MS,
  nextFeedCursor,
  nextVisibleCount,
  shouldFallBackToSnapshot,
  shouldFillFeed,
  targetFeedCount,
  visibleFeedItems,
} from './feed-paging';

function page(ids: readonly string[], cursor: string | null): SeriesPage {
  return {
    items: ids.map((id) => ({ id, title: `短剧 ${id}` })),
    cursor,
  };
}

const snapshot: CatalogSnapshot = {
  version: 2,
  savedAt: 1,
  items: [{ id: '1', title: '短剧 1' }],
};

describe('feed target paging', () => {
  it('uses 18 items on wide viewports and 12 on mobile viewports', () => {
    expect(targetFeedCount(true)).toBe(18);
    expect(targetFeedCount(false)).toBe(12);
  });

  it('renders exactly the visible count, not the loaded count', () => {
    // 回归点：上游首页返回 7 条、后续每页 6 条，直接渲染已加载条数会得到
    // 7 → 13 → 19，永远落不到 18。
    const loaded = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's'];

    expect(visibleFeedItems(loaded, 18)).toHaveLength(18);
    expect(visibleFeedItems(loaded, 12)).toHaveLength(12);
  });

  it('renders fewer than the visible count when data is short', () => {
    expect(visibleFeedItems(['a', 'b', 'c'], 18)).toEqual(['a', 'b', 'c']);
  });

  it('renders nothing for a non-positive visible count', () => {
    expect(visibleFeedItems(['a', 'b'], 0)).toEqual([]);
    expect(visibleFeedItems(['a', 'b'], -3)).toEqual([]);
  });

  it('fills until the loaded count covers the visible count', () => {
    expect(shouldFillFeed(7, 18, true)).toBe(true);
    expect(shouldFillFeed(18, 18, true)).toBe(false);
    expect(shouldFillFeed(7, 18, false)).toBe(false);
  });

  it('advances a page only after the current page is full', () => {
    // 首屏 7 条、目标 18 条时不能翻页，否则一次挂载就跳两页。
    expect(canAdvanceFeedPage(7, 18, true)).toBe(false);
    expect(canAdvanceFeedPage(18, 18, true)).toBe(true);
    expect(canAdvanceFeedPage(21, 18, true)).toBe(true);
  });

  it('does not advance before the user has scrolled', () => {
    // 回归点：视口比内容高时哨兵常驻视口，没有这道门槛会一路补到几十条。
    expect(canAdvanceFeedPage(18, 18, false)).toBe(false);
    expect(canAdvanceFeedPage(54, 18, false)).toBe(false);
  });

  it('adds one target worth of items per page turn', () => {
    expect(nextVisibleCount(18, 18)).toBe(36);
    expect(nextVisibleCount(12, 12)).toBe(24);
  });
});

describe('canStartFeedFill', () => {
  const cooldown = FEED_FILL_COOLDOWN_MS;

  it('starts when data is short, a next page exists and the cooldown has passed', () => {
    expect(canStartFeedFill(7, 18, true, false, 10_000, 10_000 - cooldown)).toBe(true);
  });

  it('does not start while a request is already in flight', () => {
    expect(canStartFeedFill(7, 18, true, true, 10_000, 0)).toBe(false);
  });

  it('does not start when there is no next page', () => {
    expect(canStartFeedFill(7, 18, false, false, 10_000, 0)).toBe(false);
  });

  it('does not start once the loaded count covers the visible count', () => {
    expect(canStartFeedFill(18, 18, true, false, 10_000, 0)).toBe(false);
    expect(canStartFeedFill(21, 18, true, false, 10_000, 0)).toBe(false);
  });

  it('respects the cooldown window', () => {
    // 回归点：没有冷却时，上游只回一两条新剧会让 7 → 9 → 11 背靠背发请求。
    expect(canStartFeedFill(7, 18, true, false, 10_000, 10_000)).toBe(false);
    expect(canStartFeedFill(7, 18, true, false, 10_000, 10_000 - cooldown + 1)).toBe(false);
    expect(canStartFeedFill(7, 18, true, false, 10_000, 10_000 - cooldown)).toBe(true);
  });
});

describe('nextFeedCursor', () => {
  it('stops when the last page has no cursor', () => {
    const last = page(['1'], null);

    expect(nextFeedCursor(last, [last])).toBeUndefined();
  });

  it('stops at the 40-page limit', () => {
    const pages = Array.from({ length: 40 }, (_, index) => page([String(index)], `cursor-${index}`));

    expect(nextFeedCursor(pages[39]!, pages)).toBeUndefined();
  });

  it('stops when every id on the last page has appeared before', () => {
    const last = page(['1', '2'], 'next');

    expect(nextFeedCursor(last, [page(['1', '2'], 'previous'), last])).toBeUndefined();
  });

  it('returns the cursor when the last page contains a new id', () => {
    const last = page(['1', '2'], 'next');

    expect(nextFeedCursor(last, [page(['1'], 'previous'), last])).toBe('next');
  });

  it('ignores a snapshot page when a real page repeats its ids', () => {
    const last = page(['1'], 'next');

    expect(nextFeedCursor(last, [page(['1'], null), last])).toBe('next');
  });
});

describe('shouldFallBackToSnapshot', () => {
  it('falls back only when the request failed and a snapshot exists', () => {
    expect(shouldFallBackToSnapshot(true, true)).toBe(true);
  });

  it('does not fall back while the request is still pending', () => {
    expect(shouldFallBackToSnapshot(false, true)).toBe(false);
  });

  it('does not fall back without a snapshot', () => {
    expect(shouldFallBackToSnapshot(true, false)).toBe(false);
  });
});

describe('buildFeedQueryOptions', () => {
  it('uses placeholder data instead of initial data when a snapshot exists', () => {
    const options = buildFeedQueryOptions(snapshot);

    expect(options).not.toHaveProperty('initialData');
    expect(options).toHaveProperty('placeholderData');
  });

  it('omits both data keys when no snapshot exists', () => {
    const options = buildFeedQueryOptions(null);

    expect(options).not.toHaveProperty('initialData');
    expect(options).not.toHaveProperty('placeholderData');
  });
});
