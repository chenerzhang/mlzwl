import type { SeriesPage } from '@mlzwl/hongguo-shared';
import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from './offline-catalog';
import { buildFeedQueryOptions, nextFeedCursor, shouldFallBackToSnapshot } from './feed-paging';

function page(ids: readonly string[], cursor: string | null): SeriesPage {
  return {
    items: ids.map((id) => ({ id, title: `短剧 ${id}` })),
    cursor,
  };
}

const snapshot: CatalogSnapshot = {
  version: 1,
  savedAt: 1,
  items: [{ id: '1', title: '短剧 1' }],
};

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
