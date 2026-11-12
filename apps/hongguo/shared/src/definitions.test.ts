import { describe, expect, it } from 'vitest';
import { COVER_PATH_PREFIX, MAX_COVER_TOKEN_LENGTH, isCoverProxyUrl } from './definitions.js';

describe('isCoverProxyUrl', () => {
  it('accepts the current opaque token form', () => {
    expect(isCoverProxyUrl(`${COVER_PATH_PREFIX}AbC-9_x`)).toBe(true);
  });

  it('rejects the legacy query form that leaked upstream signatures', () => {
    // 旧实现的地址长这样：签名就在 `u=` 里，必须整体丢弃而不是继续使用。
    expect(isCoverProxyUrl(`${COVER_PATH_PREFIX}?u=https%3A%2F%2Fx%3Fx-signature%3D1`)).toBe(false);
    expect(isCoverProxyUrl('/api/cover?u=abc')).toBe(false);
  });

  it('rejects an empty token and any other origin', () => {
    expect(isCoverProxyUrl(COVER_PATH_PREFIX)).toBe(false);
    expect(isCoverProxyUrl('https://cdn.example.com/a.jpg')).toBe(false);
    expect(isCoverProxyUrl('/api/media/1')).toBe(false);
  });

  it('rejects a token longer than the single length limit', () => {
    const tooLong = 'a'.repeat(MAX_COVER_TOKEN_LENGTH + 1);
    expect(isCoverProxyUrl(`${COVER_PATH_PREFIX}${tooLong}`)).toBe(false);
  });
});
