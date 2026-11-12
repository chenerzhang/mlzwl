import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { HeaderTextButton, PageHeader, SHELL_WIDTH } from '../components/page-header';
import { RankingCard, RankingCardSkeleton } from '../features/ranking/ranking-card';
import {
  boardsOf,
  getNextRankingPageParam,
  mergePages,
  resolveInitialSelection,
} from '../features/ranking/ranking-view';
import { api } from '../lib/api-client';
import { queryKeys } from '../lib/query-keys';
import { useGridColumns } from '../lib/use-grid-columns';
import { useInfiniteScroll } from '../lib/use-infinite-scroll';

const TAB_CLASS =
  'relative flex h-11 shrink-0 items-center px-3 text-[13px] transition-colors after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full';

/** 热度榜。分区和榜单都来自服务端目录，避免把上游可变配置写死在浏览器里。 */
export function RankingRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const catalogQuery = useQuery({ queryKey: queryKeys.rankingCatalog(), queryFn: api.rankingCatalog });
  const catalog = catalogQuery.data;
  const [selection, setSelection] = useState({ sectionId: '', boardId: '' });

  useEffect(() => {
    if (catalog === undefined) {
      return;
    }
    setSelection((current) => {
      const currentBoards = boardsOf(catalog, current.sectionId);
      if (currentBoards.some((board) => board.id === current.boardId)) {
        return current;
      }
      return resolveInitialSelection(catalog);
    });
  }, [catalog]);

  const rankingQuery = useInfiniteQuery({
    queryKey: queryKeys.ranking(selection.sectionId || undefined, selection.boardId || undefined),
    queryFn: ({ pageParam }) =>
      api.ranking({
        content: selection.sectionId,
        board: selection.boardId,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: getNextRankingPageParam,
    enabled: selection.sectionId !== '' && selection.boardId !== '',
  });

  const entries = useMemo(() => mergePages(rankingQuery.data?.pages ?? []), [rankingQuery.data]);
  const boards = catalog === undefined ? [] : boardsOf(catalog, selection.sectionId);

  const sentinelRef = useInfiniteScroll({
    hasNextPage: rankingQuery.hasNextPage,
    isFetchingNextPage: rankingQuery.isFetchingNextPage,
    fetchNextPage: () => {
      void rankingQuery.fetchNextPage();
    },
    enabled: selection.boardId !== '' && !rankingQuery.isError,
  });

  const gridRef = useRef<HTMLDivElement>(null);
  const columns = useGridColumns(gridRef, 1);
  const placeholderCount = (columns - (entries.length % columns)) % columns || columns;
  const isFirstLoad = catalogQuery.isPending || (selection.boardId !== '' && rankingQuery.isPending);
  const showSkeleton = isFirstLoad || rankingQuery.isFetchingNextPage;

  /** 换榜后回到页面顶部，否则新榜会在旧榜的深滚动位置出现。 */
  const returnToTop = (): void => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const selectSection = (sectionId: string): void => {
    if (catalog === undefined || sectionId === selection.sectionId) {
      return;
    }
    const nextBoards = boardsOf(catalog, sectionId);
    const currentName = boards.find((board) => board.id === selection.boardId)?.name;
    const matchingBoard = nextBoards.find((board) => board.name === currentName);
    setSelection({ sectionId, boardId: matchingBoard?.id ?? nextBoards[0]?.id ?? '' });
    returnToTop();
  };

  const selectBoard = (boardId: string): void => {
    if (boardId === selection.boardId) {
      return;
    }
    setSelection((current) => ({ ...current, boardId }));
    returnToTop();
  };

  return (
    <div className={`mx-auto w-full ${SHELL_WIDTH} pb-24`}>
      <PageHeader
        left={
          <HeaderTextButton
            label="返回"
            onClick={() => {
              void navigate(-1);
            }}
          >
            返回
          </HeaderTextButton>
        }
        title="热度榜"
      />

      <div className="px-3 pt-2 sm:px-5">
        {catalog !== undefined && (
          <>
            <div
              role="tablist"
              aria-label="榜单分区"
              className="no-scrollbar flex overflow-x-auto border-b border-border-subtle"
            >
              {catalog.sections.map((section) => {
                const selected = section.id === selection.sectionId;
                return (
                  <button
                    key={section.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="ranking-results"
                    onClick={() => selectSection(section.id)}
                    className={`${TAB_CLASS} ${
                      selected
                        ? 'font-medium text-text-primary after:bg-accent'
                        : 'text-text-secondary after:bg-transparent hover:text-text-primary'
                    }`}
                  >
                    {section.name}
                  </button>
                );
              })}
            </div>

            <div role="tablist" aria-label="榜单类型" className="no-scrollbar mt-1 flex overflow-x-auto">
              {boards.map((board) => {
                const selected = board.id === selection.boardId;
                return (
                  <button
                    key={board.id}
                    id={`ranking-board-${board.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="ranking-results"
                    onClick={() => selectBoard(board.id)}
                    className={`${TAB_CLASS} ${
                      selected
                        ? 'font-medium text-text-primary after:bg-accent'
                        : 'text-text-secondary after:bg-transparent hover:text-text-primary'
                    }`}
                  >
                    {board.name}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {catalogQuery.isError && (
          <ErrorBlock
            message={`榜单目录加载失败：${catalogQuery.error instanceof Error ? catalogQuery.error.message : '未知错误'}`}
            onRetry={() => {
              void catalogQuery.refetch();
            }}
          />
        )}

        {rankingQuery.isError && (
          <ErrorBlock
            message={`榜单加载失败：${rankingQuery.error instanceof Error ? rankingQuery.error.message : '未知错误'}`}
            onRetry={() => {
              void rankingQuery.refetch();
            }}
          />
        )}

        <div
          id="ranking-results"
          role="tabpanel"
          aria-labelledby={selection.boardId === '' ? undefined : `ranking-board-${selection.boardId}`}
          aria-busy={showSkeleton}
          ref={gridRef}
          className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2"
        >
          {entries.map((entry) => (
            <RankingCard
              key={entry.seriesId}
              entry={entry}
              onSelect={(selected) => {
                void navigate(`/series/${selected.seriesId}`);
              }}
            />
          ))}
          {showSkeleton &&
            Array.from({ length: isFirstLoad ? columns * 4 : placeholderCount }, (_, index) => (
              <RankingCardSkeleton key={`ranking-ph-${index}`} />
            ))}
        </div>

        {!catalogQuery.isFetching && catalog !== undefined && catalog.sections.length === 0 && (
          <p className="pt-20 text-center text-[13px] text-text-secondary">暂时没有可用榜单</p>
        )}
        {!rankingQuery.isFetching && selection.boardId !== '' && entries.length === 0 && !rankingQuery.isError && (
          <p className="pt-20 text-center text-[13px] text-text-secondary">这个榜单暂时没有数据</p>
        )}

        <div ref={sentinelRef} aria-hidden className="h-8" />
        {!rankingQuery.hasNextPage && entries.length > 0 && (
          <p className="py-6 text-center text-xs text-text-tertiary">没有更多了</p>
        )}
      </div>
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="mt-3 rounded-xl bg-surface-raised p-4 text-sm text-text-secondary ring-1 ring-border-subtle">
      {message}
      <button type="button" onClick={onRetry} className="ml-2 text-accent-soft underline-offset-2 hover:underline">
        重试
      </button>
    </div>
  );
}
