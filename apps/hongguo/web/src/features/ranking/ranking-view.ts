import type { RankingBoard, RankingCatalog, RankingEntry, RankingPage } from '@mlzwl/hongguo-shared';

export const DEFAULT_SECTION_ID = 'all';
export const DEFAULT_BOARD_ID = 'ranklist_hot_play_sc';

/** 优先落在数据最完整的热播榜；目录变化时仍能安全退回第一个可用榜单。 */
export function resolveInitialSelection(catalog: RankingCatalog): { sectionId: string; boardId: string } {
  const preferredSection = catalog.sections.find((section) => section.id === DEFAULT_SECTION_ID);
  const preferredBoard = preferredSection?.boards.find((board) => board.id === DEFAULT_BOARD_ID);
  if (preferredSection !== undefined && preferredBoard !== undefined) {
    return { sectionId: preferredSection.id, boardId: preferredBoard.id };
  }

  for (const section of catalog.sections) {
    const firstBoard = section.boards[0];
    if (firstBoard !== undefined) {
      return { sectionId: section.id, boardId: firstBoard.id };
    }
  }
  return { sectionId: '', boardId: '' };
}

export function getNextRankingPageParam(lastPage: RankingPage, allPages: readonly RankingPage[]): string | undefined {
  if (lastPage.cursor === null || allPages.length >= 40) {
    return undefined;
  }
  const usedCursors = new Set(allPages.slice(0, -1).map((page) => page.cursor));
  return usedCursors.has(lastPage.cursor) ? undefined : lastPage.cursor;
}

export function boardsOf(catalog: RankingCatalog, sectionId: string): RankingBoard[] {
  return catalog.sections.find((section) => section.id === sectionId)?.boards ?? [];
}

/** 非法名次显示短横线，避免把 NaN、小数或负数暴露成看似有效的排行。 */
export function formatPosition(position: number): string {
  return Number.isInteger(position) && position > 0 ? String(position) : '—';
}

export function isPromoted(entry: RankingEntry): boolean {
  return entry.promoted === true;
}

/** 分值是上游准备好的展示文案，不能换算，否则会丢失「平台推荐」语义。 */
export function scoreLabel(entry: RankingEntry): string | undefined {
  return entry.score;
}

/** 上游翻页偶尔会重复；保留首次位置，才能维持用户已经看到的排行顺序。 */
export function mergePages(pages: readonly RankingPage[]): RankingEntry[] {
  const seen = new Set<string>();
  const entries: RankingEntry[] = [];
  for (const page of pages) {
    for (const entry of page.entries) {
      if (seen.has(entry.seriesId)) {
        continue;
      }
      seen.add(entry.seriesId);
      entries.push(entry);
    }
  }
  return entries;
}
