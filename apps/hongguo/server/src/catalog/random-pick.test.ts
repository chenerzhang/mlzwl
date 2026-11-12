import { describe, expect, it } from 'vitest';
import { pickRandom, toRandomCandidates } from './random-pick.js';

/**
 * 随机入口纯逻辑的边界证据（P2-5）。
 *
 * 重点有两块：
 * 1. **索引永远合法**。`random` 是注入的，越界返回值不能让「随机」偶发失败。
 * 2. **候选过滤与 `offline-catalog` 同一套严格策略**。榜单里混着演员行
 *    （只有 `user_id`）和推广重复行，不过滤会跳到 `/series/undefined`。
 */

describe('pickRandom', () => {
  it('returns undefined for an empty array', () => {
    expect(pickRandom([])).toBeUndefined();
  });

  it('always returns the only element of a single-element array', () => {
    for (const value of [0, 0.5, 0.999999, 1, -0.1]) {
      expect(pickRandom(['only'], () => value)).toBe('only');
    }
  });

  it('keeps the index inside the array for in-range randomness', () => {
    const items = ['a', 'b', 'c'];
    expect(pickRandom(items, () => 0)).toBe('a');
    expect(pickRandom(items, () => 0.5)).toBe('b');
    expect(pickRandom(items, () => 0.999999)).toBe('c');
  });

  it('clamps an out-of-range index instead of returning undefined', () => {
    const items = ['a', 'b', 'c'];
    // `Math.floor(1 * 3) === 3` 越界，必须回落到最后一项。
    expect(pickRandom(items, () => 1)).toBe('c');
    // 负数会算出负索引，必须回落到第一项。
    expect(pickRandom(items, () => -0.1)).toBe('a');
    expect(pickRandom(items, () => -5)).toBe('a');
  });

  it('falls back to the first element for non-finite randomness', () => {
    const items = ['a', 'b', 'c'];
    expect(pickRandom(items, () => Number.NaN)).toBe('a');
    expect(pickRandom(items, () => Number.POSITIVE_INFINITY)).toBe('a');
    expect(pickRandom(items, () => Number.NEGATIVE_INFINITY)).toBe('a');
  });

  it('never returns undefined for a non-empty array', () => {
    const items = [1, 2, 3, 4];
    for (const value of [-1, -0.1, 0, 0.25, 0.999999, 1, 2, Number.NaN]) {
      expect(pickRandom(items, () => value)).toBeTypeOf('number');
    }
  });
});

describe('toRandomCandidates', () => {
  it('drops rows without a series_id', () => {
    // 演员行只有 `user_id`，没有 `series_id`。
    expect(toRandomCandidates([{ title: '某演员' }])).toEqual([]);
    expect(toRandomCandidates([{ series_id: '', title: '空 id' }])).toEqual([]);
    expect(toRandomCandidates([{ series_id: '   ', title: '空白 id' }])).toEqual([]);
  });

  it('drops rows without a title', () => {
    expect(toRandomCandidates([{ series_id: '1' }])).toEqual([]);
    expect(toRandomCandidates([{ series_id: '1', title: '' }])).toEqual([]);
    expect(toRandomCandidates([{ series_id: '1', title: '   ' }])).toEqual([]);
  });

  it('drops rows whose episode_count is not a non-negative integer', () => {
    expect(toRandomCandidates([{ series_id: '1', title: '甲', episode_count: -1 }])).toEqual([]);
    expect(toRandomCandidates([{ series_id: '1', title: '甲', episode_count: 1.5 }])).toEqual([]);
    expect(toRandomCandidates([{ series_id: '1', title: '甲', episode_count: Number.NaN }])).toEqual([]);
  });

  it('keeps a valid row with all fields mapped', () => {
    expect(
      toRandomCandidates([
        { series_id: '1', title: '长生', cover_url: 'https://example.test/c.jpg', episode_count: 78 },
      ]),
    ).toEqual([{ seriesId: '1', title: '长生', coverUrl: 'https://example.test/c.jpg', episodeCount: 78 }]);
  });

  it('omits coverUrl entirely when cover_url is missing', () => {
    const [candidate] = toRandomCandidates([{ series_id: '1', title: '长生', episode_count: 0 }]);
    expect(candidate).toEqual({ seriesId: '1', title: '长生', episodeCount: 0 });
    // 键必须不存在，而不是值为 undefined：`exactOptionalPropertyTypes` 下两者不等价。
    expect(candidate === undefined ? false : 'coverUrl' in candidate).toBe(false);
  });

  it('deduplicates by series_id keeping the first occurrence', () => {
    expect(
      toRandomCandidates([
        { series_id: '1', title: '第一次', episode_count: 10 },
        { series_id: '2', title: '另一部' },
        { series_id: '1', title: '第二次', episode_count: 20 },
      ]),
    ).toEqual([
      { seriesId: '1', title: '第一次', episodeCount: 10 },
      { seriesId: '2', title: '另一部' },
    ]);
  });

  it('lets a later valid row through when the first row with the same id is invalid', () => {
    // 先去重会让这条合法候选被那条 `episode_count: -1` 的行挡掉。
    expect(
      toRandomCandidates([
        { series_id: '1', title: '坏的', episode_count: -1 },
        { series_id: '1', title: '好的', episode_count: 12 },
      ]),
    ).toEqual([{ seriesId: '1', title: '好的', episodeCount: 12 }]);
  });

  it('returns an empty array for an empty ranking', () => {
    expect(toRandomCandidates([])).toEqual([]);
  });

  it('drops rows whose series_id or title is not a string', () => {
    // 上游是松散 JSON：类型声明写 `series_id?: string` 不代表线上真的给字符串。
    // 直接 `.trim()` 会抛 `TypeError`，整个 `/api/random` 变成 500。
    const dirty = [
      { series_id: 123, title: '数字 id' },
      { series_id: '1', title: 456 },
      { series_id: null, title: 'null id' },
      { series_id: '1', title: null },
    ] as unknown as Parameters<typeof toRandomCandidates>[0];
    expect(toRandomCandidates(dirty)).toEqual([]);
  });

  it('drops a non-string cover_url instead of coercing it', () => {
    // 数字会被静默转成字符串再封成令牌，得到一个指向不存在资源的封面。
    const dirty = [{ series_id: '1', title: '长生', cover_url: 123 }] as unknown as Parameters<
      typeof toRandomCandidates
    >[0];
    expect(toRandomCandidates(dirty)).toEqual([{ seriesId: '1', title: '长生' }]);
  });
});
