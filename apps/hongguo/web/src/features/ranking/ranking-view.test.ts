import type { RankingCatalog, RankingEntry, RankingPage } from '@mlzwl/hongguo-shared';
import { describe, expect, it } from 'vitest';
import {
  boardsOf,
  formatPosition,
  getNextRankingPageParam,
  isPromoted,
  mergePages,
  resolveInitialSelection,
  scoreLabel,
} from './ranking-view';

const catalog: RankingCatalog = {
  sections: [
    {
      id: 'all',
      name: '全部',
      boards: [
        { id: 'ranklist_hot_sc', name: '推荐榜' },
        { id: 'ranklist_hot_play_sc', name: '热播榜' },
      ],
    },
    { id: 'human', name: '真人剧', boards: [{ id: 'human_hot', name: '热播榜' }] },
  ],
};

function entry(seriesId: string, overrides: Partial<RankingEntry> = {}): RankingEntry {
  return { position: 1, seriesId, title: seriesId, ...overrides };
}

function page(entries: RankingEntry[], cursor: string | null = null): RankingPage {
  return { entries, cursor, board: 'board' };
}

describe('resolveInitialSelection', () => {
  it('优先命中全部分区的热播榜', () => {
    expect(resolveInitialSelection(catalog)).toEqual({ sectionId: 'all', boardId: 'ranklist_hot_play_sc' });
  });

  it('默认榜不存在时退回第一个分区的第一个榜单', () => {
    const fallback: RankingCatalog = {
      sections: [
        { id: 'comic', name: '漫剧', boards: [{ id: 'comic_new', name: '新剧榜' }] },
        { id: 'human', name: '真人剧', boards: [{ id: 'human_hot', name: '热播榜' }] },
      ],
    };
    expect(resolveInitialSelection(fallback)).toEqual({ sectionId: 'comic', boardId: 'comic_new' });
  });

  it('第一个分区没有榜单时退回后续第一个可用榜单', () => {
    const unavailable: RankingCatalog = {
      sections: [
        { id: 'empty', name: '空分区', boards: [] },
        { id: 'comic', name: '漫剧', boards: [{ id: 'comic_new', name: '新剧榜' }] },
      ],
    };
    expect(resolveInitialSelection(unavailable)).toEqual({ sectionId: 'comic', boardId: 'comic_new' });
  });

  it('空目录返回空字符串', () => {
    expect(resolveInitialSelection({ sections: [] })).toEqual({ sectionId: '', boardId: '' });
  });
});

describe('boardsOf', () => {
  it('返回命中分区的榜单', () => {
    expect(boardsOf(catalog, 'human')).toEqual([{ id: 'human_hot', name: '热播榜' }]);
  });

  it('未命中分区时返回空数组', () => {
    expect(boardsOf(catalog, 'missing')).toEqual([]);
  });
});

describe('formatPosition', () => {
  it.each([
    [1, '1'],
    [2, '2'],
    [3, '3'],
    [10, '10'],
  ])('格式化有效名次 %s', (position, expected) => {
    expect(formatPosition(position)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN])('非法名次 %s 返回短横线', (position) => {
    expect(formatPosition(position)).toBe('—');
  });
});

describe('scoreLabel', () => {
  it('原样返回上游展示文案', () => {
    expect(scoreLabel(entry('a', { score: '8835万热度' }))).toBe('8835万热度');
  });

  it('没有分值时返回 undefined', () => {
    expect(scoreLabel(entry('a'))).toBeUndefined();
  });
});

describe('getNextRankingPageParam', () => {
  it('全重复中间页仍继续追踪新的游标并获得后续新条目', () => {
    const first = page([entry('a')], 'cursor-2');
    const duplicate = page([entry('a')], 'cursor-3');
    const last = page([entry('b')]);

    expect(getNextRankingPageParam(duplicate, [first, duplicate])).toBe('cursor-3');
    expect(mergePages([first, duplicate, last]).map((item) => item.seriesId)).toEqual(['a', 'b']);
  });

  it('游标重复时停止防止分页环路', () => {
    const first = page([entry('a')], 'loop');
    const duplicateCursor = page([entry('b')], 'loop');
    expect(getNextRankingPageParam(duplicateCursor, [first, duplicateCursor])).toBeUndefined();
  });

  it('保留 40 页上限', () => {
    const pages = Array.from({ length: 40 }, (_, index) => page([entry(String(index))], `cursor-${index}`));
    expect(getNextRankingPageParam(pages[39]!, pages)).toBeUndefined();
  });
});

describe('mergePages', () => {
  it('按页序拼接条目', () => {
    expect(mergePages([page([entry('a')]), page([entry('b')])]).map((item) => item.seriesId)).toEqual(['a', 'b']);
  });

  it('跨页重复 seriesId 保留首次', () => {
    const first = entry('a', { position: 1, title: '首次' });
    const duplicate = entry('a', { position: 11, title: '重复' });
    expect(mergePages([page([first]), page([duplicate, entry('b')])])).toEqual([first, entry('b')]);
  });

  it('空页数组返回空数组', () => {
    expect(mergePages([])).toEqual([]);
  });
});

describe('isPromoted', () => {
  it('仅把明确的 true 视为推广', () => {
    expect(isPromoted(entry('a', { promoted: true }))).toBe(true);
    expect(isPromoted(entry('b'))).toBe(false);
  });
});
