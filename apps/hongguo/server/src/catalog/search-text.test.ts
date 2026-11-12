import { describe, expect, it } from 'vitest';
import { normalizeSearchText } from './search-text.js';

/**
 * 归一化规则的边界证据。
 *
 * 重点是「用户输入带标点时仍能搜到」，以及「归一化结果可以直接当缓存键」——
 * 后者要求幂等：不幂等会让「长生，」与「长生」落进两个缓存条目。
 */

describe('normalizeSearchText', () => {
  it('converts fullwidth letters digits and punctuation to halfwidth', () => {
    expect(normalizeSearchText('ＡＢＣ１２３')).toBe('ABC123');
    expect(normalizeSearchText('长生！')).toBe('长生');
    expect(normalizeSearchText('ａｂｃ')).toBe('abc');
  });

  it('converts ideographic space to a normal space before collapsing', () => {
    expect(normalizeSearchText('长生\u3000短剧')).toBe('长生 短剧');
  });

  it('strips leading and trailing punctuation and whitespace', () => {
    expect(normalizeSearchText('长生，')).toBe('长生');
    expect(normalizeSearchText('，长生）')).toBe('长生');
    expect(normalizeSearchText('《长生》')).toBe('长生');
    expect(normalizeSearchText('  "长生"  ')).toBe('长生');
    expect(normalizeSearchText('【长生】!?')).toBe('长生');
  });

  it('keeps punctuation inside the keyword', () => {
    // 中间的标点不是噪音，剥掉会改变语义（「A,B」不是「AB」）。
    expect(normalizeSearchText('长生,短剧')).toBe('长生,短剧');
  });

  it('collapses consecutive whitespace into one space', () => {
    expect(normalizeSearchText('长生   短剧')).toBe('长生 短剧');
    expect(normalizeSearchText('长生\t\n短剧')).toBe('长生 短剧');
  });

  it('is idempotent', () => {
    for (const input of ['长生，', '  ＡＢ　　Ｃ  ', '，，', '长生,短剧', '']) {
      const once = normalizeSearchText(input);
      expect(normalizeSearchText(once)).toBe(once);
    }
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeSearchText('')).toBe('');
    expect(normalizeSearchText('   ')).toBe('');
  });

  it('returns an empty string for pure punctuation input', () => {
    expect(normalizeSearchText('，。、；：？！')).toBe('');
    expect(normalizeSearchText('《》（）【】')).toBe('');
    expect(normalizeSearchText('!!!???...')).toBe('');
  });
});
