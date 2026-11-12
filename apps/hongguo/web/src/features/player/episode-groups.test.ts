import { describe, expect, it } from 'vitest';
import { groupEpisodes, groupIndexOf, validateEpisodeJump } from './episode-groups';

/** 选集分组与跳转校验的纯逻辑测试。用数字数组代替 `Episode`，分组逻辑与字段无关。 */

function makeItems(total: number): number[] {
  return Array.from({ length: total }, (_unused, index) => index + 1);
}

describe('groupEpisodes', () => {
  it('renders a single group at exactly the threshold', () => {
    const groups = groupEpisodes(makeItems(40));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ start: 1, end: 40, items: makeItems(40) });
  });

  it('splits into 20-item groups just above the threshold', () => {
    const groups = groupEpisodes(makeItems(41));
    expect(groups.map((group) => [group.start, group.end, group.items.length])).toEqual([
      [1, 20, 20],
      [21, 40, 20],
      [41, 41, 1],
    ]);
  });

  it('covers a 104-episode series without gaps or overlaps', () => {
    const groups = groupEpisodes(makeItems(104));
    expect(groups).toHaveLength(6);
    expect(groups[0]?.start).toBe(1);
    expect(groups.at(-1)?.end).toBe(104);
    const flattened = groups.flatMap((group) => group.items);
    expect(flattened).toEqual(makeItems(104));
  });

  it('returns no groups for an empty list', () => {
    expect(groupEpisodes([])).toEqual([]);
  });

  it('honours custom group size and threshold', () => {
    const groups = groupEpisodes(makeItems(10), { groupSize: 4, threshold: 5 });
    expect(groups.map((group) => [group.start, group.end])).toEqual([
      [1, 4],
      [5, 8],
      [9, 10],
    ]);
  });

  it('guards against a non-positive group size', () => {
    const groups = groupEpisodes(makeItems(6), { groupSize: 0, threshold: 1 });
    expect(groups).toHaveLength(6);
    expect(groups[0]).toEqual({ start: 1, end: 1, items: [1] });
  });
});

describe('groupIndexOf', () => {
  const groups = groupEpisodes(makeItems(104));

  it('finds the group holding the current episode', () => {
    expect(groupIndexOf(groups, 1)).toBe(0);
    expect(groupIndexOf(groups, 21)).toBe(1);
    expect(groupIndexOf(groups, 104)).toBe(5);
  });

  it('returns -1 outside every group', () => {
    expect(groupIndexOf(groups, 0)).toBe(-1);
    expect(groupIndexOf(groups, 105)).toBe(-1);
  });
});

describe('validateEpisodeJump', () => {
  it('accepts the boundaries', () => {
    expect(validateEpisodeJump('1', 104)).toBeNull();
    expect(validateEpisodeJump('104', 104)).toBeNull();
  });

  it('accepts surrounding whitespace', () => {
    expect(validateEpisodeJump(' 12 ', 104)).toBeNull();
  });

  it('rejects an empty input', () => {
    expect(validateEpisodeJump('', 104)).toBe('请输入集数');
    expect(validateEpisodeJump('   ', 104)).toBe('请输入集数');
  });

  it('rejects non-numeric input', () => {
    expect(validateEpisodeJump('abc', 104)).toBe('请输入 1 到 104 之间的整数');
    expect(validateEpisodeJump('1e3', 104)).toBe('请输入 1 到 104 之间的整数');
  });

  it('rejects decimals', () => {
    expect(validateEpisodeJump('1.5', 104)).toBe('请输入 1 到 104 之间的整数');
  });

  it('rejects 0 and negatives', () => {
    expect(validateEpisodeJump('0', 104)).toBe('请输入 1 到 104 之间的整数');
    expect(validateEpisodeJump('-3', 104)).toBe('请输入 1 到 104 之间的整数');
  });

  it('rejects values past the last episode instead of clamping', () => {
    expect(validateEpisodeJump('105', 104)).toBe('请输入 1 到 104 之间的整数');
  });
});
