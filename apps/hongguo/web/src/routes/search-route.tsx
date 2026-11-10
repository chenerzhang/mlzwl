import { useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { useInfiniteScroll } from '../lib/use-infinite-scroll';
import { useGridColumns } from '../lib/use-grid-columns';
import { SeriesCard, SeriesCardSkeleton } from '../components/series-card';
import { HeaderButton, PageHeader, SHELL_WIDTH } from '../components/page-header';

/**
 * 推荐关键词。
 *
 * 全部实测过有结果（每个 4–6 部）。空状态直接给可点的词，比让用户自己想
 * 「该搜什么」有用得多——这也是 `ui-ux-pro-max` 的 No Results 条目要求：
 * 「Show 'No results' with suggestions」，不要留一个空白屏。
 */
const SUGGESTIONS = ['总裁', '重生', '穿越', '甜宠', '逆袭', '战神', '复仇', '闪婚'] as const;

/** 搜索页。输入关键词后提交才发请求，避免每个按键都打上游。 */
export function SearchRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');

  const query = useInfiniteQuery({
    queryKey: queryKeys.search(keyword),
    queryFn: ({ pageParam }) => api.search(keyword, pageParam),
    initialPageParam: undefined as string | undefined,
    // 同 feed：本页没有新 id 就停止，避免重复内容导致无限请求。
    getNextPageParam: (last, allPages) => {
      if (last.cursor === null) {
        return undefined;
      }
      if (allPages.length >= 40) {
        return undefined;
      }
      const seen = new Set<string>();
      for (const page of allPages.slice(0, -1)) {
        for (const item of page.items) {
          seen.add(item.id);
        }
      }
      return last.items.some((item) => !seen.has(item.id)) ? last.cursor : undefined;
    },
    enabled: keyword.length > 0,
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
    enabled: keyword !== '' && !query.isError,
  });

  const submit = (value: string): void => {
    const next = value.trim();
    setInput(next);
    setKeyword(next);
  };

  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(gridRef, 2);
  const placeholderCount = (columns - (items.length % columns)) % columns || columns;

  /**
   * 是否正在「首次」取数。
   *
   * **不能用 `query.isPending`**：react-query 对 `enabled: false` 的查询也返回
   * `status: 'pending'`，所以还没输入关键词时它同样是 true。之前直接用它判断，
   * 导致空状态下面多渲染一整排骨架（用户截图反馈）。
   * 必须叠加「有关键词」这个前提。
   */
  const isFirstLoad = keyword !== '' && query.isPending;
  /** 骨架只在真正有请求在飞的时候出现：首次加载，或加载更多。 */
  const showSkeleton = isFirstLoad || query.isFetchingNextPage;

  const showEmpty = keyword === '' && !query.isFetching;
  const showNoResult = !query.isFetching && keyword !== '' && items.length === 0 && !query.isError;

  return (
    <div className={`mx-auto w-full ${SHELL_WIDTH} pb-24`}>
      <PageHeader
        left={
          <>
            <HeaderButton
              label="返回"
              onClick={() => {
                void navigate(-1);
              }}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </HeaderButton>
            {/*
              搜索页不用居中标题，返回按钮与输入框同行，顶栏只占一行。

              输入框的焦点态**不用红色描边**：`:focus-visible` 对输入框总是命中，
              `autoFocus` 会让一进页就挂一圈红环（用户明确反馈过）。
              改用「底色变亮 + 边框变实 + 极淡外发光」三重弱信号，既有反馈
              又不刺眼。外发光用 accent 的 12% 透明，不构成视觉噪音。
            */}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit(input);
              }}
              role="search"
              className="flex min-w-0 max-w-xl flex-1 items-center gap-2"
            >
              <div className="relative min-w-0 flex-1">
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden
                  className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
                </svg>
                <input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  placeholder="搜索剧名、题材、演员"
                  aria-label="搜索短剧"
                  autoFocus
                  enterKeyHint="search"
                  className="h-11 w-full rounded-lg bg-surface-raised pl-10 pr-4 text-sm outline-none ring-1 ring-border-subtle transition-[background-color,box-shadow] duration-200 placeholder:text-text-tertiary hover:bg-surface-overlay focus:bg-surface-overlay focus:ring-border focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
                />
              </div>
              <button
                type="submit"
                className="h-11 flex-none rounded-lg bg-accent px-5 text-sm font-medium text-on-accent transition-[filter] hover:brightness-110 active:brightness-95"
              >
                搜索
              </button>
            </form>
          </>
        }
      />

      <div className="px-3 pt-4 sm:px-5">
        {/*
          空状态给明确视觉重心：图标 + 标题 + 说明 + 可点的推荐词。
          之前只有一行灰字浮在大片空白中央，看不出这页能做什么。
        */}
        {showEmpty && (
          <div className="mx-auto flex max-w-md flex-col items-center px-4 pt-20 text-center sm:pt-28">
            {/*
              图标不套圆角方块。之前是 `rounded-2xl bg-surface-raised ring-1`，
              在近黑底上形成一个明显的浅灰方块，比文字还抢眼——空状态的视觉
              重心应该在"提示语"，不在装饰。
            */}
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className="h-8 w-8 text-text-tertiary"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
            <h2 className="mt-6 text-base font-medium tracking-tight text-text-primary">搜一部想看的短剧</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
              输入剧名、题材或演员名，也可以从热门题材开始。
            </p>
            {/* 推荐词用极细描边而不是填充块：8 个填充块会形成一片"按钮墙"。 */}
            <div className="mt-7 flex max-w-sm flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() => submit(word)}
                  className="flex h-11 items-center rounded-full px-4 text-[13px] text-text-secondary ring-1 ring-border-subtle transition-colors hover:text-text-primary hover:ring-border"
                >
                  {word}
                </button>
              ))}
            </div>
          </div>
        )}

        {showNoResult && (
          <div className="mx-auto flex max-w-md flex-col items-center px-4 pt-20 text-center sm:pt-28">
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className="h-8 w-8 text-text-tertiary"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M8.5 8.5l5 5M13.5 8.5l-5 5" strokeLinecap="round" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
            <h2 className="mt-6 text-base font-medium tracking-tight text-text-primary">没有找到「{keyword}」</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">换个词试试，或者从下面的题材开始。</p>
            <div className="mt-7 flex max-w-sm flex-wrap justify-center gap-2">
              {SUGGESTIONS.filter((word) => word !== keyword).map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() => submit(word)}
                  className="flex h-11 items-center rounded-full px-4 text-[13px] text-text-secondary ring-1 ring-border-subtle transition-colors hover:text-text-primary hover:ring-border"
                >
                  {word}
                </button>
              ))}
            </div>
          </div>
        )}

        {query.isError && (
          <p className="rounded-xl bg-surface-raised p-4 text-sm text-text-secondary">
            搜索失败：{query.error instanceof Error ? query.error.message : '未知错误'}
          </p>
        )}

        {keyword !== '' && items.length > 0 && (
          <p className="mb-3 text-xs text-text-tertiary">
            「{keyword}」共 <span className="tabular-nums text-text-secondary">{items.length}</span> 部
          </p>
        )}

        {/*
          真实卡片与骨架屏放在**同一个 grid** 里。
          之前骨架屏是独立的 grid 容器，所以永远另起一行——用户截图里
          第一排只填了 3 个、右边空一格，下面却整排都是骨架。

          注意：首屏用 `isPending`（还没有任何数据），加载更多用 `isFetchingNextPage`。
          这里**不能用 `isFetching`**：它在 `fetchNextPage` 期间同样为 true，
          会把「补当前行」错当成「首屏」，一次画两整行骨架。
        */}
        <div
          ref={gridRef}
          aria-busy={showSkeleton}
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
            骨架格必须排在真实卡片**之后**。放在前面（DOM 顺序）时，
            搜索词改变后旧结果还在缓存里、新结果未到，骨架会顶到第一排，
            真实卡片被挤到下面——看起来像“结果跑到加载框下面了”。
            数量按真实列数算，只补当前行，不会多出一整排。
          */}
          {showSkeleton &&
            Array.from({ length: isFirstLoad ? columns * 2 : placeholderCount }, (_, index) => (
              <SeriesCardSkeleton key={`ph-${index}`} />
            ))}
        </div>

        {/* 哨兵：滚动到底自动取下一页 */}
        <div ref={sentinelRef} aria-hidden className="h-8" />

        {!query.hasNextPage && items.length > 0 && (
          <p className="py-6 text-center text-xs text-text-tertiary">没有更多了</p>
        )}
      </div>
    </div>
  );
}
