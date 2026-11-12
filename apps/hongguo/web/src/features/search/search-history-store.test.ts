import { describe, expect, it } from 'vitest';
import { addToHistory, MAX_HISTORY_ITEMS, MAX_KEYWORD_LENGTH } from './search-history-store';

/**
 * 搜索历史规则的纯逻辑测试（P1-5）。
 *
 * 不引入 jsdom：`search-history-store.ts` 的 import 期只在 `typeof window !== 'undefined'`
 * 时才注册 `pagehide`，node 环境下不碰任何全局对象。
 */

describe('addToHistory', () => {
  it('puts a new keyword at the front', () => {
    expect(addToHistory(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('trims the keyword before storing', () => {
    expect(addToHistory([], '  长生  ')).toEqual(['长生']);
  });

  it('moves a repeated keyword to the front without duplicating it', () => {
    const result = addToHistory(['a', 'b', 'c'], 'b');
    expect(result).toEqual(['b', 'a', 'c']);
    expect(result.filter((item) => item === 'b')).toHaveLength(1);
  });

  it('ignores an empty or whitespace-only keyword', () => {
    const history = ['a'];
    expect(addToHistory(history, '')).toBe(history);
    expect(addToHistory(history, '   ')).toBe(history);
    expect(addToHistory(history, '\t\n')).toBe(history);
  });

  it('accepts a keyword exactly at the length limit', () => {
    const keyword = '长'.repeat(MAX_KEYWORD_LENGTH);
    expect(addToHistory([], keyword)).toEqual([keyword]);
  });

  it('ignores a keyword longer than the length limit', () => {
    const history = ['a'];
    const keyword = '长'.repeat(MAX_KEYWORD_LENGTH + 1);
    expect(addToHistory(history, keyword)).toBe(history);
  });

  it('measures the limit after trimming', () => {
    // 首尾空白不占长度，trim 后正好 80 字符应该被接受。
    const keyword = `  ${'长'.repeat(MAX_KEYWORD_LENGTH)}  `;
    expect(addToHistory([], keyword)).toHaveLength(1);
  });

  it('keeps at most the newest 20 items', () => {
    let history: readonly string[] = [];
    for (let index = 0; index < 25; index += 1) {
      history = addToHistory(history, `关键词${index}`);
    }
    expect(history).toHaveLength(MAX_HISTORY_ITEMS);
    // 最新在前：最后一条是第 25 个（索引 24），第一条是第 6 个（索引 5）。
    expect(history[0]).toBe('关键词24');
    expect(history.at(-1)).toBe('关键词5');
  });

  it('does not grow when the same keyword is searched repeatedly', () => {
    let history: readonly string[] = [];
    for (let index = 0; index < 5; index += 1) {
      history = addToHistory(history, '长生');
    }
    expect(history).toEqual(['长生']);
  });
});
