import type { SeriesPage } from '@mlzwl/hongguo-shared';
import type { InfiniteData } from '@tanstack/react-query';
import type { CatalogSnapshot } from './offline-catalog';

export type FeedData = InfiniteData<SeriesPage, string | undefined>;

export type FeedPageTarget = 12 | 18;

/**
 * 宽视口与 Tailwind 的 `sm`（640px）保持同一套断点语义。
 */
export function targetFeedCount(isWideViewport: boolean): FeedPageTarget {
  return isWideViewport ? 18 : 12;
}

/**
 * 当前应该渲染多少条。
 *
 * 为什么不用「已加载条数」直接渲染：上游首页实测返回 7 条，后续每页 6 条，
 * 补页序列是 7 → 13 → 19，按页粒度永远落不到 18 或 12。所以渲染量由
 * `visibleCount` 控制，补页只负责把数据拉到足够。
 */
export function visibleFeedItems<T>(items: readonly T[], visibleCount: number): readonly T[] {
  return items.slice(0, Math.max(visibleCount, 0));
}

/** 数据还不够渲染目标条数，且上游还有下一页。 */
export function shouldFillFeed(loadedCount: number, visibleCount: number, hasNextPage: boolean): boolean {
  return loadedCount < visibleCount && hasNextPage;
}

/**
 * 用户滚到底时是否该翻页。
 *
 * 条件里的 `loadedCount >= visibleCount` 是为了区分两种哨兵进入：
 * 1. 上一页数据已经给满，用户继续往下滚 → 翻页；
 * 2. 上一页数据还没给满（首屏 7 条、目标 18 条）→ 只补齐，不翻页。
 * 没有这个区分，首屏一挂载就会直接跳到两页。
 */
export function canAdvanceFeedPage(loadedCount: number, visibleCount: number): boolean {
  return loadedCount >= visibleCount;
}

/**
 * 自动补页的最小间隔。
 *
 * 与 `use-infinite-scroll` 的 `COOLDOWN_MS` 保持同一个量级，但两者不共用常量：
 * 那个是「滚动触发」的防抖，这个是「补数据」的限速，语义不同。
 */
export const FEED_FILL_COOLDOWN_MS = 700;

/**
 * 现在是否允许发下一次补页请求。
 *
 * 冷却必须有，不能只靠 `isFetchingNextPage`：上游有时只回一两条新剧，
 * 7 → 9 → 11 这种小步补页会背靠背发好几个请求，形成一条长请求链。
 */
export function canStartFeedFill(
  loadedCount: number,
  visibleCount: number,
  hasNextPage: boolean,
  isFetching: boolean,
  now: number,
  lastFilledAt: number,
): boolean {
  if (isFetching || !hasNextPage) {
    return false;
  }
  if (loadedCount >= visibleCount) {
    return false;
  }
  return now - lastFilledAt >= FEED_FILL_COOLDOWN_MS;
}

/** 翻页后的可见条数。 */
export function nextVisibleCount(visibleCount: number, target: number): number {
  return visibleCount + target;
}

/**
 * 计算推荐流的下一页游标。
 *
 * 上游会跨页重复推荐同一部剧，因此整页都没有新 id 时停止；同时用 40 页
 * 作为无限推荐流的硬上限。非末页的 `cursor: null` 只可能来自离线快照，
 * 它不是网络分页历史，去重时必须忽略，否则会把真实第一页误判成重复页。
 */
export function nextFeedCursor(lastPage: SeriesPage, allPages: readonly SeriesPage[]): string | undefined {
  if (lastPage.cursor === null || allPages.length >= 40) {
    return undefined;
  }

  const seen = new Set<string>();
  for (const page of allPages.slice(0, -1)) {
    if (page.cursor === null) {
      continue;
    }
    for (const item of page.items) {
      seen.add(item.id);
    }
  }
  const fresh = lastPage.items.some((item) => !seen.has(item.id));
  return fresh ? lastPage.cursor : undefined;
}

/**
 * 判断失败时是否退回挂载时的离线快照。
 *
 * 不能依赖 TanStack Query 的 `isPlaceholderData`：它只在 `pending` 状态为真，
 * 进入最终 `error` 后会被置回 `false`，数据也不再来自 placeholder。把兜底绑在
 * 它上面会让断网首屏变成零卡片。这里只看「请求已失败」与「快照存在」两件事。
 */
export function shouldFallBackToSnapshot(isError: boolean, hasSnapshot: boolean): boolean {
  return isError && hasSnapshot;
}

/**
 * 构造首页查询中与离线快照有关的配置。
 *
 * 无快照时不返回 `placeholderData` 键，以满足 exactOptionalPropertyTypes；有快照时
 * 只作为占位数据展示，不写入 Query cache，因此挂载后仍会请求真实第一页。
 */
export function buildFeedQueryOptions(snapshot: CatalogSnapshot | null): {
  getNextPageParam: typeof nextFeedCursor;
  placeholderData?: FeedData;
} {
  const getNextPageParam = nextFeedCursor;
  if (snapshot === null) {
    return { getNextPageParam };
  }
  return {
    getNextPageParam,
    placeholderData: {
      pages: [{ items: [...snapshot.items], cursor: null }],
      pageParams: [undefined],
    },
  };
}
