import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { useInfiniteScroll } from '../lib/use-infinite-scroll';
import { useGridColumns } from '../lib/use-grid-columns';
import { createSuggestController, type SuggestController } from '../lib/debounced-suggest';
import { ArrowLeftIcon, SearchIcon } from '../components/icons';
import { HOME_PATH } from '../features/navigation/back-target';
import { SeriesCard, SeriesCardSkeleton } from '../components/series-card';
import { HeaderButton, PageHeader, SHELL_WIDTH } from '../components/page-header';
import { useSearchHistoryStore } from '../features/search/search-history-store';

/**
 * 推荐关键词。
 *
 * 全部实测过有结果（每个 4–6 部）。空状态直接给可点的词，比让用户自己想
 * 「该搜什么」有用得多——这也是 `ui-ux-pro-max` 的 No Results 条目要求：
 * 「Show 'No results' with suggestions」，不要留一个空白屏。
 */
const SUGGESTIONS = ['总裁', '重生', '穿越', '甜宠', '逆袭', '战神', '复仇', '闪婚'] as const;

/**
 * 联想下拉项。
 *
 * 高亮态用 `aria-selected` 变体表达：属性已经为无障碍标好了，样式跟着它走就不会
 * 出现「视觉高亮和屏幕阅读器读到的选中项不一致」。
 */
const SUGGEST_ITEM_CLASS =
  'block h-10 w-full truncate px-4 text-left text-sm leading-10 text-text-secondary hover:text-text-primary aria-selected:bg-surface-raised aria-selected:text-text-primary';

/** 推荐题材按钮。空态与无结果态各用一次。 */
const TOPIC_CHIP_CLASS =
  'flex h-11 items-center rounded-full px-4 text-[13px] text-text-secondary ring-1 ring-border-subtle transition-colors hover:text-text-primary hover:ring-border';

/** 搜索页。输入停顿 300 ms 后取联想，提交后才搜索（避免每个按键都打上游）。 */
export function SearchRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [keyword, setKeyword] = useState('');
  /** 联想列表与高亮下标总是一起变化，合成一个 state 少一次渲染。 */
  const [suggest, setSuggest] = useState<{ items: readonly string[]; active: number }>({ items: [], active: -1 });

  const history = useSearchHistoryStore((state) => state.history);
  // 动作函数在 store 创建时定型、引用恒定，不需要订阅：直接取当前快照，
  // 少三次 `useSyncExternalStore` 订阅。
  const { add: addHistory, remove: removeHistory, clear: clearHistory } = useSearchHistoryStore.getState();

  /**
   * 输入法组合态。
   *
   * 中文输入法在 `compositionstart` 到 `compositionend` 之间会不断触发 `input`，
   * 每个中间态（拼音字母）都不是用户想搜的词，所以这段时间不发联想请求。
   * 用 ref 而不是 state：事件处理器里要**同步**读到最新值，state 会晚一帧。
   */
  const composingRef = useRef(false);
  const suggestRef = useRef<SuggestController | null>(null);

  useEffect(() => {
    const controller = createSuggestController({
      fetchSuggest: (prefix, signal) => api.suggest(prefix, signal),
      onResult: (items) => {
        setSuggest({ items, active: -1 });
      },
      // 联想失败静默：不弹错误，也不清空用户已经输入的内容。
      onError: () => {
        setSuggest({ items: [], active: -1 });
      },
    });
    suggestRef.current = controller;
    return () => {
      controller.dispose();
      suggestRef.current = null;
    };
  }, []);

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
    // 允许提交空串：那是用户主动清空并回到空态的方式，只是不记历史。
    setInput(next);
    setKeyword(next);
    if (next !== '') {
      addHistory(next);
    }
    // 提交后收起建议：保留列表会让用户以为还要再选一次。
    closeSuggest();
  };

  /**
   * 输入变化。
   *
   * 组合态期间只更新 `input`（让输入法正常显示候选），不发联想请求——
   * 这正是 P1-4 要求「中文输入法连续输入只发 1 个请求」的实现点。
   */
  const handleInputChange = (value: string): void => {
    setInput(value);
    if (composingRef.current) {
      return;
    }
    suggestRef.current?.update(value);
  };

  /**
   * 关闭联想下拉。
   *
   * 必须同时取消挂起的防抖与请求：只清 state 的话，300 ms 内的定时器仍会跑完，
   * `onResult` 会把下拉重新弹出来盖在结果页上。`update('')` 会取消定时器、
   * abort 请求并回调 `onResult([])`（见 `debounced-suggest.ts` 的三个不变式）。
   */
  const closeSuggest = (): void => {
    suggestRef.current?.update('');
    setSuggest({ items: [], active: -1 });
  };

  /**
   * 键盘操作：上下循环移动高亮，Esc 关闭，Enter 选词。
   *
   * `(active + delta + length) % length` 一步完成两个方向的环绕，
   * 不需要为「上越界」「下越界」各写一个分支。
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const { items, active } = suggest;
    const move = (delta: number): void => {
      if (items.length > 0) {
        event.preventDefault();
        setSuggest({ items, active: (active + delta + items.length) % items.length });
      }
    };
    if (event.key === 'ArrowDown') {
      move(1);
    } else if (event.key === 'ArrowUp') {
      move(-1);
    } else if (event.key === 'Escape') {
      closeSuggest();
    } else if (event.key === 'Enter' && items[active] !== undefined) {
      // 有高亮项时 Enter 选词，不让表单再提交一次原始输入。
      event.preventDefault();
      submit(items[active]);
    }
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
                void navigate(HOME_PATH, { replace: true });
              }}
            >
              <ArrowLeftIcon />
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
                <SearchIcon
                  size="sm"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-tertiary"
                />
                <input
                  value={input}
                  onChange={(event) => handleInputChange(event.target.value)}
                  onCompositionStart={() => {
                    composingRef.current = true;
                    // 组合一开始就收起旧列表：拼音中间态与旧建议无关，留着只会误导。
                    closeSuggest();
                  }}
                  onCompositionEnd={(event) => {
                    composingRef.current = false;
                    // 必须在这里补一次 `update`：组合态期间的 `onChange` 被跳过了，
                    // 不补的话输入完成后永远不会触发联想。
                    suggestRef.current?.update(event.currentTarget.value);
                  }}
                  onKeyDown={handleKeyDown}
                  onBlur={closeSuggest}
                  placeholder="搜索剧名、题材、演员"
                  aria-label="搜索短剧"
                  autoFocus
                  enterKeyHint="search"
                  autoComplete="off"
                  aria-expanded={suggest.items.length > 0}
                  className="h-11 w-full rounded-lg bg-surface-raised pl-10 pr-4 text-sm outline-none ring-1 ring-border-subtle transition-[background-color,box-shadow] duration-200 placeholder:text-text-tertiary hover:bg-surface-overlay focus:bg-surface-overlay focus:ring-border focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent)]"
                />
                {/*
                  联想下拉。用 `bg-surface-overlay` + 细描边，和输入框同色系，
                  不引入新的浮层样式体系。

                  `onMouseDown` 里 `preventDefault` 是必需的：输入框的 `onBlur`
                  会先触发并把列表关掉，点击事件就落不到按钮上。
                */}
                {suggest.items.length > 0 && (
                  <div
                    role="listbox"
                    // 在容器上一次性 `preventDefault`：输入框的 `onBlur` 会先触发并
                    // 关掉列表，点击就落不到选项上。逐个绑在选项上要多写 N 份。
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    className="absolute inset-x-0 top-full z-40 mt-1 overflow-hidden rounded-lg bg-surface-overlay py-1 ring-1 ring-border-subtle"
                  >
                    {suggest.items.map((item, index) => (
                      <button
                        key={item}
                        type="button"
                        role="option"
                        aria-selected={index === suggest.active}
                        tabIndex={-1}
                        onClick={() => {
                          submit(item);
                        }}
                        className={SUGGEST_ITEM_CLASS}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                )}
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
          空状态与无结果态共用一套骨架：图标 + 标题 + 说明 + 可点的推荐词。
          两者只差图标、文案，以及推荐词是否排除当前关键词，合在一起写避免
          两份几乎相同的标记各自漂移。

          图标不套圆角方块：`rounded-2xl bg-surface-raised ring-1` 在近黑底上
          会形成一个比文字还抢眼的浅灰方块，空状态的视觉重心应该在提示语上。
        */}
        {(showEmpty || showNoResult) && (
          <div className="mx-auto flex max-w-md flex-col items-center px-4 pt-20 text-center sm:pt-28">
            <SearchIcon size="lg" className="text-text-tertiary" />
            <h2 className="mt-6 text-base font-medium tracking-tight text-text-primary">
              {showNoResult ? `没有找到「${keyword}」` : '搜一部想看的短剧'}
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
              {showNoResult ? '换个词试试，或者从下面的题材开始。' : '输入剧名、题材或演员名，也可以从热门题材开始。'}
            </p>

            {/*
              搜索历史只在真正的空态出现，放在推荐词**上面**：用户自己搜过的词
              比固定题材更相关。空历史时整块不渲染，不留一条空标题。
            */}
            {showEmpty && history.length > 0 && (
              <div className="mt-8 w-full">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-text-secondary">最近搜索</span>
                  <button type="button" onClick={clearHistory} className="px-2 text-xs text-text-tertiary">
                    清空
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {history.map((word) => (
                    <span key={word} className={`${TOPIC_CHIP_CLASS} gap-1 pl-4 pr-2`}>
                      <button
                        type="button"
                        onClick={() => submit(word)}
                        className="max-w-40 truncate text-text-secondary hover:text-text-primary"
                      >
                        {word}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除「${word}」`}
                        onClick={() => removeHistory(word)}
                        className="text-base text-text-tertiary hover:text-text-primary"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 推荐词用极细描边而不是填充块：8 个填充块会形成一片"按钮墙"。 */}
            <div className="mt-7 flex max-w-sm flex-wrap justify-center gap-2">
              {SUGGESTIONS.filter((word) => word !== keyword).map((word) => (
                <button key={word} type="button" onClick={() => submit(word)} className={TOPIC_CHIP_CLASS}>
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
