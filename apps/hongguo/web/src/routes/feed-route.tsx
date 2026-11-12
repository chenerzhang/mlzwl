import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { randomFailureMessage } from '../lib/random-entry';
import { readCatalogSnapshot, writeCatalogSnapshot } from '../features/feed/offline-catalog-store';
import { buildFeedQueryOptions, shouldFallBackToSnapshot } from '../features/feed/feed-paging';
import { useInfiniteScroll } from '../lib/use-infinite-scroll';
import { useGridColumns } from '../lib/use-grid-columns';
import { SeriesCard, SeriesCardSkeleton } from '../components/series-card';
import { PageHeader, SHELL_WIDTH, type PageHeaderAction } from '../components/page-header';

/**
 * 首页推荐流。
 *
 * 滚动到底自动加载下一页，不再需要「加载更多」按钮。响应式：手机 2 列，
 * 平板 3–4 列，桌面 6 列。
 */
export function FeedRoute(): React.JSX.Element {
  const navigate = useNavigate();

  /**
   * 离线目录快照只在挂载时读一次（P1-7）。
   *
   * 读进 `useState` 的惰性初始化而不是每次渲染都读：`localStorage` 是同步 IO，
   * 放进渲染路径会在每次滚动重渲染时都摸一遍磁盘。
   */
  const [cachedSnapshot] = useState(() => readCatalogSnapshot());

  /**
   * 「随机看一部」的进行中标记与失败文案（P2-5）。
   *
   * `randomPending` 同时用于禁用按钮：上游榜单首次取要打一次网络，连点会发多次
   * 请求。禁用之外仍在 handler 里做一次提前返回，因为禁用只挡住鼠标点击。
   */
  const [randomPending, setRandomPending] = useState(false);
  const [randomError, setRandomError] = useState<string | null>(null);

  /**
   * 随机跳转。
   *
   * 成功直接进详情页：随机入口的下一步一定是「看」，中间插一个列表页没有意义。
   * 失败不弹 toast，而是在顶栏下方就地显示一行文案：toast 会被顶栏遮住，
   * 且自动消失后用户不知道刚才那一下为什么没反应。
   */
  const handleRandom = async (): Promise<void> => {
    if (randomPending) {
      return;
    }
    setRandomPending(true);
    setRandomError(null);
    try {
      const series = await api.random();
      void navigate(`/series/${series.id}`);
    } catch (error: unknown) {
      setRandomError(randomFailureMessage(error));
    } finally {
      setRandomPending(false);
    }
  };

  /**
   * 快照只作为 placeholder 展示，不写进 Query cache。这样即使全局关闭了挂载重取，
   * cache 为空时仍会请求真实第一页；断网时 placeholder 继续留在页面上兜底。
   */
  const snapshotQueryOptions = useMemo(() => buildFeedQueryOptions(cachedSnapshot), [cachedSnapshot]);

  const query = useInfiniteQuery({
    queryKey: queryKeys.feed(),
    queryFn: ({ pageParam }) => api.feed(pageParam),
    initialPageParam: undefined as string | undefined,
    ...snapshotQueryOptions,
    // 首屏 12 个，预取下一页让滚动不卡。
    staleTime: 60_000,
  });

  /**
   * 第一页数据落盘，供下次断网启动时兜底。
   *
   * 只写 `pages[0]`：推荐流是无限滚动的，后面几十页既超出 30 条上限，也不该
   * 让一次浏览把缓存撑到 200 KB。
   *
   * 用 `dataUpdatedAt` 而不是 `pages[0]` 的对象引用来判重：React Query 会做结构
   * 共享，内容完全相同的 refetch 会拿回**同一个引用**，用引用判断会让 `savedAt`
   * 永远停在第一次写入的时间，长期活跃用户的缓存在 7 天后自己过期。
   *
   * placeholder 的 `dataUpdatedAt` 不保证为 0，必须用 `isPlaceholderData` 排除快照；
   * 否则会把快照当成网络结果写回，毫无意义地刷新 `savedAt`。
   */
  const firstPage = query.data?.pages[0];
  const dataUpdatedAt = query.dataUpdatedAt;
  const isPlaceholderData = query.isPlaceholderData;
  const writtenAt = useRef(0);
  useEffect(() => {
    if (firstPage === undefined || isPlaceholderData || writtenAt.current === dataUpdatedAt) {
      return;
    }
    writtenAt.current = dataUpdatedAt;
    writeCatalogSnapshot(firstPage.items);
  }, [firstPage, dataUpdatedAt, isPlaceholderData]);

  /**
   * 请求最终失败时是否退回挂载时的离线快照。
   *
   * 不能只看 `isPlaceholderData`：TanStack Query 只在 `pending` 状态应用 placeholder，
   * 一旦进入最终 `error` 状态就会把 `isPlaceholderData` 置回 `false`，数据也不再来自
   * placeholder。若把兜底绑在它上面，断网首屏会变成一张卡片都没有，只剩一行报错。
   */
  const showingOfflineCache = shouldFallBackToSnapshot(query.isError, cachedSnapshot !== null);
  /** 退回快照时要用的数据。`showingOfflineCache` 为 true 时必然非空。 */
  const fallbackItems = showingOfflineCache && cachedSnapshot !== null ? cachedSnapshot.items : null;

  /** 跨页去重，保留首次出现的顺序。失败退回快照时只用快照内容。 */
  const items = useMemo(() => {
    if (fallbackItems !== null) {
      return [...fallbackItems];
    }
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
  }, [query.data, fallbackItems]);

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
        actions={
          [
            {
              label: '随机看一部',
              disabled: randomPending,
              iconOnly: true,
              onClick: () => {
                void handleRandom();
              },
              // 骰子比「打乱箭头」更直接地表达「随便来一部」。
              icon: (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
                  <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
                  <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
                  <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
                </svg>
              ),
            },
            {
              label: '我的收藏',
              iconOnly: true,
              onClick: () => {
                void navigate('/favorites');
              },
              icon: (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path
                    d="M12 20.5l-1.3-1.18C5.4 14.5 2 11.42 2 7.65A4.15 4.15 0 016.2 3.5 4.6 4.6 0 0112 7.25a4.6 4.6 0 015.8-3.75A4.15 4.15 0 0122 7.65c0 3.77-3.4 6.85-8.7 11.67L12 20.5z"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ),
            },
            {
              label: '热度榜',
              iconOnly: true,
              onClick: () => {
                void navigate('/ranking');
              },
              // 折线和前三根柱同时表达「排行」，桌面端只留图标以守住 640px 最窄平铺宽度。
              icon: (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path d="M5 20v-6h3v6M10.5 20V9h3v11M16 20V4h3v16" strokeLinecap="round" />
                  <path d="M4 20h16" strokeLinecap="round" />
                </svg>
              ),
            },
            {
              label: '历史',
              iconOnly: true,
              onClick: () => {
                void navigate('/history');
              },
              icon: (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path d="M4 5v5h5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M5.5 9.5A7.5 7.5 0 112 14" strokeLinecap="round" />
                  <path d="M12 8v4l2.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ),
            },
            {
              label: '搜索',
              iconOnly: true,
              onClick: () => {
                void navigate('/search');
              },
              icon: (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
                </svg>
              ),
            },
          ] satisfies readonly PageHeaderAction[]
        }
      />

      <div className="px-3 pt-4 sm:px-5">
        {randomError !== null && (
          <div className="mb-3 rounded-xl bg-surface-raised p-4 text-sm text-text-secondary ring-1 ring-border-subtle">
            随机失败：{randomError}
          </div>
        )}

        {query.isError && (
          <div className="mb-3 rounded-xl bg-surface-raised p-4 text-sm text-text-secondary ring-1 ring-border-subtle">
            {showingOfflineCache ? '当前显示的是离线缓存，联网后会自动刷新。' : '加载失败：'}
            {!showingOfflineCache && (query.error instanceof Error ? query.error.message : '未知错误')}
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

        {/*
          离线缓存只有一页，占位数据也还没取到真实结果，此时说「没有更多了」都是误导。
        */}
        {!query.hasNextPage && items.length > 0 && !showingOfflineCache && !isPlaceholderData && (
          <p className="py-6 text-center text-xs text-text-tertiary">没有更多了</p>
        )}
      </div>
    </div>
  );
}
