import { describe, expect, it } from 'vitest';
import { continuousBuffer, isBuffered, toRanges, type TimeRange } from './buffered-ranges';

/** buffered 区间合并的纯逻辑测试，不依赖 `TimeRanges` 的真实实现。 */

function fakeRanges(pairs: readonly (readonly [number, number])[]): {
  length: number;
  start(i: number): number;
  end(i: number): number;
} {
  return {
    length: pairs.length,
    start: (index) => pairs[index]?.[0] ?? Number.NaN,
    end: (index) => pairs[index]?.[1] ?? Number.NaN,
  };
}

describe('toRanges', () => {
  it('keeps a single range', () => {
    expect(toRanges(fakeRanges([[0, 12]]))).toEqual([{ start: 0, end: 12 }]);
  });

  it('merges touching ranges', () => {
    expect(
      toRanges(
        fakeRanges([
          [0, 5],
          [5, 9],
        ]),
      ),
    ).toEqual([{ start: 0, end: 9 }]);
  });

  it('merges overlapping ranges', () => {
    expect(
      toRanges(
        fakeRanges([
          [0, 8],
          [4, 12],
        ]),
      ),
    ).toEqual([{ start: 0, end: 12 }]);
  });

  it('keeps a gap as two ranges', () => {
    expect(
      toRanges(
        fakeRanges([
          [0, 5],
          [9, 12],
        ]),
      ),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 9, end: 12 },
    ]);
  });

  it('returns nothing for an empty source', () => {
    expect(toRanges(fakeRanges([]))).toEqual([]);
  });

  it('drops empty and non-finite ranges', () => {
    expect(
      toRanges(
        fakeRanges([
          [0, 0],
          [Number.NaN, 3],
          [4, Number.NaN],
          [6, 8],
        ]),
      ),
    ).toEqual([{ start: 6, end: 8 }]);
  });
});

describe('continuousBuffer', () => {
  const ranges: readonly TimeRange[] = [
    { start: 0, end: 5 },
    { start: 10, end: 20 },
  ];

  it('measures from the start of a range', () => {
    expect(continuousBuffer(ranges, 0)).toBe(5);
  });

  it('measures from the middle of a range', () => {
    expect(continuousBuffer(ranges, 14)).toBe(6);
  });

  it('returns 0 inside an unbuffered gap', () => {
    expect(continuousBuffer(ranges, 7)).toBe(0);
  });

  it('returns 0 past the last range', () => {
    expect(continuousBuffer(ranges, 25)).toBe(0);
  });

  it('returns 0 for empty ranges', () => {
    expect(continuousBuffer([], 3)).toBe(0);
  });
});

describe('isBuffered', () => {
  const ranges: readonly TimeRange[] = [{ start: 2, end: 6 }];

  it('accepts both boundaries', () => {
    expect(isBuffered(ranges, 2)).toBe(true);
    expect(isBuffered(ranges, 6)).toBe(true);
  });

  it('accepts an interior point', () => {
    expect(isBuffered(ranges, 4)).toBe(true);
  });

  it('rejects points outside the range', () => {
    expect(isBuffered(ranges, 1.9)).toBe(false);
    expect(isBuffered(ranges, 6.1)).toBe(false);
  });
});
