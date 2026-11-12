import { describe, expect, it } from 'vitest';
import { selectBatchTargets, selectionState, toggleAllEpisodes, toggleEpisode } from './download-selection';
import { initialEntry, type DownloadEntry } from './download-state';

const done = (): DownloadEntry => ({ status: 'done', received: 10, total: 10 });
const downloading = (): DownloadEntry => ({ status: 'downloading', received: 1, total: 10 });
const failed = (): DownloadEntry => ({ status: 'failed', received: 0, total: null, error: '网络错误' });

describe('toggleEpisode', () => {
  it('adds an id that is not selected', () => {
    expect([...toggleEpisode(new Set(), 'a')]).toEqual(['a']);
  });

  it('removes an id that is already selected', () => {
    expect([...toggleEpisode(new Set(['a', 'b']), 'a')]).toEqual(['b']);
  });

  it('does not mutate the input set', () => {
    const input = new Set(['a']);

    toggleEpisode(input, 'b');

    expect([...input]).toEqual(['a']);
  });
});

describe('selectionState', () => {
  it('reports none for an empty selection', () => {
    expect(selectionState(new Set(), ['a', 'b'])).toBe('none');
  });

  it('reports none when the candidate list is empty', () => {
    expect(selectionState(new Set(['a']), [])).toBe('none');
  });

  it('reports partial when only some are selected', () => {
    expect(selectionState(new Set(['a']), ['a', 'b'])).toBe('partial');
  });

  it('reports all when every candidate is selected', () => {
    expect(selectionState(new Set(['a', 'b']), ['a', 'b'])).toBe('all');
  });

  it('ignores ids outside the candidate list', () => {
    expect(selectionState(new Set(['a', 'z']), ['a', 'b'])).toBe('partial');
  });
});

describe('toggleAllEpisodes', () => {
  it('selects everything from a partial selection', () => {
    expect([...toggleAllEpisodes(new Set(['a']), ['a', 'b'])].sort()).toEqual(['a', 'b']);
  });

  it('clears everything when already fully selected', () => {
    expect([...toggleAllEpisodes(new Set(['a', 'b']), ['a', 'b'])]).toEqual([]);
  });

  it('selects everything from an empty selection', () => {
    expect([...toggleAllEpisodes(new Set(), ['a', 'b'])].sort()).toEqual(['a', 'b']);
  });
});

describe('selectBatchTargets', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];

  it('keeps only ids that still need work', () => {
    // 状态按「集号 → 档位」两级存；这里不传档位，落在默认桶里。
    const entries: Record<string, Record<string, DownloadEntry>> = {
      a: { auto: done() },
      b: { auto: downloading() },
      c: { auto: initialEntry() },
      d: { auto: failed() },
    };
    const queued = new Set(['e']);
    const selected = new Set(['a', 'b', 'c', 'd', 'e']);

    expect(selectBatchTargets(selected, all, entries, queued)).toEqual(['c', 'd']);
  });

  it('preserves the selection order', () => {
    const selected = new Set(['c', 'a', 'b']);

    expect(selectBatchTargets(selected, all, {}, new Set())).toEqual(['c', 'a', 'b']);
  });

  it('returns an empty list when everything is already queued', () => {
    expect(selectBatchTargets(new Set(['a', 'b']), all, {}, new Set(['a', 'b']))).toEqual([]);
  });

  it('re-targets an episode already downloaded at another definition', () => {
    // 同一集的不同档是两份文件。1080p 已下载，切到 360p 后仍应可提交。
    const entries: Record<string, Record<string, DownloadEntry>> = {
      a: { '1080p': done() },
    };

    expect(selectBatchTargets(new Set(['a']), all, entries, new Set(), '360p')).toEqual(['a']);
    // 同一档则视为已完成，不再重复下载。
    expect(selectBatchTargets(new Set(['a']), all, entries, new Set(), '1080p')).toEqual([]);
  });

  it('keeps both definitions downloadable after both finished', () => {
    // 两档都下完之后，两条记录必须同时存在：切回任一档都显示「已下载」。
    const entries: Record<string, Record<string, DownloadEntry>> = {
      a: { '1080p': done(), '360p': done() },
    };

    expect(selectBatchTargets(new Set(['a']), all, entries, new Set(), '1080p')).toEqual([]);
    expect(selectBatchTargets(new Set(['a']), all, entries, new Set(), '360p')).toEqual([]);
    // 第三档仍未下载，应可提交。
    expect(selectBatchTargets(new Set(['a']), all, entries, new Set(), '540p')).toEqual(['a']);
  });

  it('skips an episode that is downloading at another definition', () => {
    // 队列按集号去重：1080p 在跑时提交 360p 会被 `enqueue()` 拒绝。
    // 批量目标必须提前排除，否则面板清空了选择却什么也没发生。
    const entries: Record<string, Record<string, DownloadEntry>> = {
      a: { '1080p': downloading() },
    };

    expect(selectBatchTargets(new Set(['a']), all, entries, new Set(), '360p')).toEqual([]);
    // 另一集不受影响。
    expect(selectBatchTargets(new Set(['a', 'b']), all, entries, new Set(), '360p')).toEqual(['b']);
  });

  it('drops a selected id that is no longer available', () => {
    // 剧集数据刷新后某集变成 `playable === false`，但 selected 里还留着它。
    const selected = new Set(['a', 'gone']);

    expect(selectBatchTargets(selected, ['a'], {}, new Set())).toEqual(['a']);
  });

  it('returns an empty list when nothing selected is available', () => {
    expect(selectBatchTargets(new Set(['gone']), ['a'], {}, new Set())).toEqual([]);
  });
});
