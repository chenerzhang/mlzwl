import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { randomFailureMessage } from '../lib/random-entry';
import { readCatalogSnapshot, writeCatalogSnapshot } from '../features/feed/offline-catalog-store';
import {
  buildFeedQueryOptions,
  canAdvanceFeedPage,
  canStartFeedFill,
  FEED_FILL_COOLDOWN_MS,
  nextVisibleCount,
  shouldFallBackToSnapshot,
  shouldFillFeed,
  targetFeedCount,
  visibleFeedItems,
} from '../features/feed/feed-paging';
import { HeartIcon, HistoryIcon, SearchIcon, SparkleIcon, TrendUpIcon } from '../components/icons';
import { useInfiniteScroll } from '../lib/use-infinite-scroll';
import { useWideViewport } from '../lib/use-wide-viewport';
import { useScrollIntent } from '../lib/use-scroll-intent';
import { useGridColumns } from '../lib/use-grid-columns';
import { SeriesCard, SeriesCardSkeleton } from '../components/series-card';
import { PageHeader, SHELL_WIDTH, type PageHeaderAction } from '../components/page-header';

/**
 * 首页推荐流。
 *
 * 滚动到底自动加载下一页，不再需要「加载更多」按钮。响应式：手机 2 列，
 * 平板 3–4 列，桌面 6 列。
 *
 * **分页量按条数而不是按页**。上游 `discover` 单次只返回 4–7 条（实测首页 7 条、
 * 后续每页 6 条），且没有 `pageSize` 参数。若直接渲染「已加载条数」，序列会是
 * 7 → 13 → 19，永远落不到 18。所以渲染量由 `visibleCount` 控制：首屏 18（PC）
 * 或 12（移动），用户每滚到底再加一档，后台只负责把数据拉够 `visibleCount`。
 */
export function FeedRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const isWideViewport = useWideViewport();
  const targetCount = targetFeedCount(isWideViewport);

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
    // 首屏只请求并渲染上游第一页；哨兵进入视口后才连续补到当前视口目标。
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

  /**
   * 目标渲染条数。首屏一档，用户每滚到底再加一档。
   *
   * 视口变化时按「用户有没有手动翻过页」分两种：
   * - 还在第一页：直接跟随新目标。桌面拉窄到手机宽度时应该变回 12 条，
   *   否则窗口从 1440 拖到 390 会留下一个 18 条的手机首屏。
   * - 已经翻过页：保留现有值，不把用户已经看到的内容重新藏起来。
   */
  const [visibleCount, setVisibleCount] = useState<number>(targetCount);
  const previousTarget = useRef(targetCount);
  useEffect(() => {
    const oldTarget = previousTarget.current;
    previousTarget.current = targetCount;
    setVisibleCount((current) => (current <= oldTarget ? targetCount : current));
  }, [targetCount]);

  /** 真正渲染的条目。数据可能多于 `visibleCount`（补页会越过目标），这里截断。 */
  const visibleItems = visibleFeedItems(items, visibleCount);

  /**
   * 补页的唯一网络请求所有者。
   *
   * **为什么必须只有一个所有者**：之前哨兵回调与补页 effect 都能调
   * `fetchNextPage`，而 700ms 冷却只包住了哨兵那条。两条路径同时看到旧的
   * `isFetchingNextPage === false` 时会各发一次请求；TanStack Query v5 的
   * `cancelRefetch` 默认 `true`，重复调用会重跑 `queryFn` 并丢弃前一次结果。
   *
   * 现在的分工：
   * - 哨兵**只**负责增大 `visibleCount`，不发网络请求；
   * - 这个 effect 是唯一的请求发出点，带自己的冷却；
   * - `cancelRefetch: false` 作为并发保险：即使某次调度仍重叠，也不会取消
   *   已在飞行的请求。
   *
   * 用 `setTimeout` 而不是「到点直接跳过」：冷却期间如果不安排重查，哨兵又
   * 已离开视口，补页就再也不会发生，首屏会停在 7 条。
   */
  /** 冷却到期后唤醒补页 effect 的计数器。 */
  const [fillTick, setFillTick] = useState(0);
  const lastFilledAt = useRef(0);
  const needsFill = shouldFillFeed(items.length, visibleCount, query.hasNextPage);
  /**
   * 依赖里必须放 `items.length`，不能只放 `needsFill`。
   *
   * `needsFill` 是布尔值：10 条 → 13 条时它一直是 `true`，值没变，effect 不会
   * 重跑，补页就停在 10 条。这是实测踩到的（只发了 2 次请求就停）。
   * `query.isFetchingNextPage` 也必须在依赖里，它 `true → false` 的翻转是
   * 请求完成的信号，用来唤醒下一次判定。
   */
  useEffect(() => {
    if (query.isError) {
      return undefined;
    }
    const now = Date.now();
    const canStart = canStartFeedFill(
      items.length,
      visibleCount,
      query.hasNextPage,
      query.isFetchingNextPage,
      now,
      lastFilledAt.current,
    );
    if (!canStart) {
      // 冷却中或正在请求：冷却才需要安排重查；正在请求时由 isFetchingNextPage
      // 翻转来唤醒，不需要额外 timer。
      if (query.isFetchingNextPage || !needsFill) {
        return undefined;
      }
      const wait = FEED_FILL_COOLDOWN_MS - (now - lastFilledAt.current);
      const timer = setTimeout(() => setFillTick((value) => value + 1), wait);
      return () => clearTimeout(timer);
    }
    lastFilledAt.current = now;
    void query.fetchNextPage({ cancelRefetch: false });
    return undefined;
  }, [
    needsFill,
    items.length,
    visibleCount,
    query.hasNextPage,
    query.isFetchingNextPage,
    query.isError,
    query.fetchNextPage,
    fillTick,
  ]);

  /** 用户是否有未消费的向下滚动意图；首屏自动补页不受它影响，翻页受它约束。 */
  const scrollIntent = useScrollIntent();

  const sentinelRef = useInfiniteScroll({
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    /**
     * 哨兵进入视口时翻一档。**不发网络请求**，只扩大可见条数；数据不够时由
     * 上面的 effect 补。
     *
     * 只有当前页已经渲染满（`items.length >= visibleCount`）才翻页；否则这次
     * 进入只是在等补页，翻页会让首屏一次跳两档。
     */
    fetchNextPage: () => {
      if (!canAdvanceFeedPage(items.length, visibleCount, scrollIntent.pending)) {
        return;
      }
      setVisibleCount((current) => nextVisibleCount(current, targetCount));
      // 消费意图：一次滚动只换一档。不消费会让后续每次请求结束、每次冷却
      // 重试都再次放行，一次滚动把 visibleCount 从 18 推到 36、54。
      scrollIntent.consume();
    },
    // `enabled` 同时承担两件事：出错时停用，以及把滚动意图合进依赖数组。
    // 后者是必需的——超高视口下哨兵常驻视口、observer 不再回调，只有意图翻转
    // 能唤醒判定；否则用户滚动后也不会翻页。
    enabled: !query.isError && scrollIntent.pending,
  });

  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(gridRef, 2);
  /** 骨架格只补当前行的剩余格位，让骨架永远不溢出到下一行。 */
  const placeholderCount =
    query.isPending || query.isFetchingNextPage ? (columns - (visibleItems.length % columns)) % columns || columns : 0;

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
              // 星光比「打乱箭头」更直接地表达「随便来一部」。
              icon: <SparkleIcon />,
            },
            {
              label: '我的收藏',
              iconOnly: true,
              onClick: () => {
                void navigate('/favorites');
              },
              icon: <HeartIcon />,
            },
            {
              label: '热度榜',
              iconOnly: true,
              onClick: () => {
                void navigate('/ranking');
              },
              // 上升折线直接表达「排行」，桌面端只留图标以守住 640px 最窄平铺宽度。
              icon: <TrendUpIcon />,
            },
            {
              label: '历史',
              iconOnly: true,
              onClick: () => {
                void navigate('/history');
              },
              icon: <HistoryIcon />,
            },
            {
              label: '搜索',
              iconOnly: true,
              onClick: () => {
                void navigate('/search');
              },
              icon: <SearchIcon />,
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
          {visibleItems.map((series) => (
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
