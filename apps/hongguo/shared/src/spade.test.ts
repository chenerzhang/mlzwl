import { describe, expect, it } from 'vitest';
import { deriveContentKey, SpadeError } from './spade.js';

/**
 * 测试向量取自真实分集：`spade_a` 来自播放模型的 `encrypt_info.spade_a`，
 * `key` / `version` 来自同一次调用里上游 SDK 的 `contentKey`。
 *
 * 因此这组用例同时验证两件事：还原算法正确，且与 SDK 逐字节一致。
 */
const VECTORS: ReadonlyArray<{ spadeA: string; key: string; version: string }> = [
  {
    spadeA: 'lrwYy2GMHfRNvAfxSL4z72GmKN9nlx7dTJUH2VaQBu5JkgGiog==',
    key: '7ab1ea823678c9932b71a29134817e5f',
    version: '1',
  },
  {
    spadeA: 'k7wd9ma5Lfdlvx7DZIsp93u5MvJ8iDHHS4oHxniKMvVOugaNjQ==',
    key: '24d94702deb15d98246c57a644f41fb9',
    version: '1',
  },
  {
    spadeA: 'rLwi8mi7OMZ0gDjQcJw8zEeHDc9DswrNdoQ8+nCDOc5EgAy9vQ==',
    key: 'a8339f40590548b5316e1fc22f3a04c8',
    version: '1',
  },
  {
    spadeA: 'p7wp8GGJKMF5hynPUIUb+Wa+L+5Vlh3bY5Yr7WSjGelmpS66ug==',
    key: 'f61c219091a33dd129ba05e60c66d1e6',
    version: '1',
  },
  {
    spadeA: 'obwv+n+BBsl9gDH4TbEc/Fa2HstlsR77T4EfzVODAfl9jjWKig==',
    key: 'd09eb1c35ad295141fccc28c84369aba',
    version: '1',
  },
  {
    spadeA: 'kbwf9FG5HcBTuijCYLkxxXq9BvV8jSzzfr0z9XiLKsdWgB6vrw==',
    key: '42775b6dda0d9d2be1ba8f97502f93b1',
    version: '1',
  },
];

describe('deriveContentKey', () => {
  it.each(VECTORS)('recovers the SDK key from $spadeA', ({ spadeA, key, version }) => {
    const result = deriveContentKey(spadeA);
    expect(result.key).toBe(key);
    expect(result.version).toBe(version);
  });

  it('returns a 32-character lowercase hex key', () => {
    const { key } = deriveContentKey(VECTORS[0]!.spadeA);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects non-base64 input', () => {
    expect(() => deriveContentKey('not base64!!!')).toThrow(SpadeError);
  });

  it('rejects material too short to hold a marker', () => {
    expect(() => deriveContentKey('AAAA')).toThrow(SpadeError);
  });

  it('rejects a truncated key body', () => {
    // 截断后标记字节仍在，但输出长度越界。
    expect(() => deriveContentKey('rLwi8mi7OMZ0gDjQcJw8zEeH')).toThrow(SpadeError);
  });
});
