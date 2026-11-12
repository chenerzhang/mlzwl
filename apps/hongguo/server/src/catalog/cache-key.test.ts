import { describe, expect, it } from 'vitest';
import { cacheKeyOf } from './cache-key.js';

describe('cacheKeyOf', () => {
  it('separates a NUL inside a value from a field boundary', () => {
    // 关键回归：`z.string()` 不拒绝 NUL，URL 的 `%00` 能还原成真实 NUL 字节。
    // 用 NUL 当分隔符时这两个查询会拼出同一个键，互相污染缓存。
    expect(cacheKeyOf('a\u0000b', 'c')).not.toBe(cacheKeyOf('a', 'b\u0000c'));
  });

  it('separates a missing field from an empty string', () => {
    expect(cacheKeyOf(undefined, 'x')).not.toBe(cacheKeyOf('', 'x'));
  });

  it('separates a missing field from the literal "first"', () => {
    // 旧实现用 `cursor ?? 'first'`，字面量游标 "first" 会撞上「没有游标」。
    expect(cacheKeyOf(undefined)).not.toBe(cacheKeyOf('first'));
  });

  it('keeps distinct tuples distinct regardless of separator characters', () => {
    expect(cacheKeyOf('a:b', 'c')).not.toBe(cacheKeyOf('a', 'b:c'));
    expect(cacheKeyOf('a|b', 'c')).not.toBe(cacheKeyOf('a', 'b|c'));
    expect(cacheKeyOf('a\u0001b', 'c')).not.toBe(cacheKeyOf('a', 'b\u0001c'));
  });

  it('is stable for the same input', () => {
    expect(cacheKeyOf('all', 'hot', undefined)).toBe(cacheKeyOf('all', 'hot', undefined));
  });
});
