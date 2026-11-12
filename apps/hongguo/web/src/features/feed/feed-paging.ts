import type { SeriesPage } from '@mlzwl/hongguo-shared';
import type { InfiniteData } from '@tanstack/react-query';
import type { CatalogSnapshot } from './offline-catalog';

export type FeedData = InfiniteData<SeriesPage, string | undefined>;

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
