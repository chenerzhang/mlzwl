import { describe, expect, it } from 'vitest';
import { parseSheetIndex } from './sprite.controller.js';

describe('parseSheetIndex', () => {
  it('accepts plain non-negative integers', () => {
    expect(parseSheetIndex('0')).toBe(0);
    expect(parseSheetIndex('1')).toBe(1);
    expect(parseSheetIndex('12')).toBe(12);
  });

  it('rejects strings that parseInt would silently accept', () => {
    // `Number.parseInt('1x', 10)` 得到 1，会让畸形路径返回第 1 张图。
    expect(parseSheetIndex('1x')).toBeNull();
    expect(parseSheetIndex('1.5')).toBeNull();
    expect(parseSheetIndex('1 ')).toBeNull();
    expect(parseSheetIndex(' 1')).toBeNull();
    expect(parseSheetIndex('+1')).toBeNull();
    expect(parseSheetIndex('0x1')).toBeNull();
    expect(parseSheetIndex('1e3')).toBeNull();
  });

  it('rejects signs, decimals and empty input', () => {
    expect(parseSheetIndex('-1')).toBeNull();
    expect(parseSheetIndex('')).toBeNull();
    expect(parseSheetIndex('.5')).toBeNull();
  });

  it('rejects integers beyond the safe range', () => {
    expect(parseSheetIndex('9007199254740993')).toBeNull();
  });
});
