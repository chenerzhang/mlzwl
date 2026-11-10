import { useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { useInfiniteScroll } from '../lib/use-infinite-scroll';
import { useGridColumns } from '../lib/use-grid-columns';
import { SeriesCard, SeriesCardSkeleton } from '../components/series-card';
import { HeaderTextButton, PageHeader, SHELL_WIDTH } from '../components/page-header';

/**
 * 首页推荐流。
 *
 * 滚动到底自动加载下一页，不再需要「加载更多」按钮。响应式：手机 2 列，
 * 平板 3–4 列，桌面 6 列。
 */
export function FeedRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const query = useInfiniteQuery({
    queryKey: queryKeys.feed(),
    queryFn: ({ pageParam }) => api.feed(pageParam),
    initialPageParam: undefined as string | undefined,
    /**
     * 上游推荐流按 offset 分页，**同一部剧会跨页重复出现**（实测第 3 页起
     * 就出现已见过的 id）。这里做两件事：
     * 1. 若本页没有任何新 id，说明推荐流已经到底，返回 undefined 停止。
     * 2. 否则继续用上游 cursor。
     * 不这样处理会无限请求下去，且 React 会因重复 key 报错。
     */
    getNextPageParam: (last, allPages) => {
      if (last.cursor === null) {
        return undefined;
      }
      // 兜底：推荐流理论上无限，这里限制最多 40 页（约 360 部）。
      if (allPages.length >= 40) {
        return undefined;
      }
      const seen = new Set<string>();
      for (const page of allPages.slice(0, -1)) {
        for (const item of page.items) {
          seen.add(item.id);
        }
      }
      const fresh = last.items.some((item) => !seen.has(item.id));
      return fresh ? last.cursor : undefined;
    },
    // 首屏 12 个，预取下一页让滚动不卡。
    staleTime: 60_000,
  });

  /** 跨页去重，保留首次出现的顺序。 */
  const items = useMemo(() => {
    const seen = new Set<string>();
    const merged = [];
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.id)) {
          continue;
        }
        seen.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }, [query.data]);

  const sentinelRef = useInfiniteScroll({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    enabled: !query.isError,
  });

  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(gridRef, 2);
  /** 骨架格只补当前行的剩余格位，让骨架永远不溢出到下一行。 */
  const placeholderCount =
    query.isPending || query.isFetchingNextPage ? (columns - (items.length % columns)) % columns || columns : 0;

  return (
    <div className={`mx-auto w-full ${SHELL_WIDTH} pb-24`}>
      <PageHeader
        left={<h1 className="truncate text-[15px] font-semibold tracking-tight">红果短剧</h1>}
        right={
          <>
            <HeaderTextButton
              label="历史"
              onClick={() => {
                void navigate('/history');
              }}
            />
            <HeaderTextButton
              label="搜索"
              onClick={() => {
                void navigate('/search');
              }}
            />
          </>
        }
      />

      <div className="px-3 pt-4 sm:px-5">
        {query.isError && (
          <div className="mb-3 rounded-xl bg-surface-raised p-4 text-sm text-text-secondary ring-1 ring-border-subtle">
            加载失败：{query.error instanceof Error ? query.error.message : '未知错误'}
            <button
              type="button"
              onClick={() => {
                void query.refetch();
              }}
              className="ml-2 text-accent-soft underline-offset-2 hover:underline"
            >
              重试
            </button>
          </div>
        )}

        {/*
          首屏骨架屏、真实卡片、加载更多骨架屏共用**同一个 grid**。
          骨架屏如果放在独立容器里，就永远另起一行：第一排只填了 3 个卡、
          右边空一格，下面却整排都是骨架，观感很碎。
        */}
        {/*
          `aria-busy` 告诉辅助技术「这块区域正在更新」。骨架本身是 `aria-hidden` 的
          纯装饰，所以如果没有 `aria-busy`，屏幕阅读器用户完全不知道有内容在加载。
          这是 `ui-ux-pro-max` 的 Loading Indicators 条目要求。
        */}
        <div
          ref={gridRef}
          aria-busy={query.isPending || query.isFetchingNextPage}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
        >
          {items.map((series) => (
            <SeriesCard
              key={series.id}
              series={series}
              onSelect={(selected) => {
                void navigate(`/series/${selected.id}`);
              }}
            />
          ))}

          {/*
            骨架格紧跟在最后一张真实卡片之后，数量按真实列数算，
            只补当前行的空位。这样总格数永远是列数的整数倍，
            不会多出一整排、也不会把下一行的卡片往下推。
          */}
          {(query.isPending || query.isFetchingNextPage) &&
            Array.from({ length: query.isPending ? columns * 2 : placeholderCount }, (_, index) => (
              <SeriesCardSkeleton key={`ph-${index}`} />
            ))}
        </div>

        {/* 哨兵：进入视口就预取下一页 */}
        <div ref={sentinelRef} aria-hidden className="h-8" />

        {!query.hasNextPage && items.length > 0 && (
          <p className="py-6 text-center text-xs text-text-tertiary">没有更多了</p>
        )}
      </div>
    </div>
  );
}
