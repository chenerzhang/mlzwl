import { describe, expect, it } from 'vitest';
import { HOME_PATH, playerBackTarget } from './back-target';

describe('playerBackTarget', () => {
  it('returns the series detail page when the series id is known', () => {
    expect(playerBackTarget('7678638019280112702')).toBe('/series/7678638019280112702');
  });

  it('falls back to home when the series id is missing', () => {
    expect(playerBackTarget('')).toBe('/');
    expect(playerBackTarget(null)).toBe('/');
    expect(playerBackTarget(undefined)).toBe('/');
  });

  it('escapes ids that contain path or query characters', () => {
    // 上游 id 目前都是纯数字，但直接拼进路径是注入点：`a/b` 会多一层路由，
    // `a?b` 会把后半段变成查询串。
    expect(playerBackTarget('a/b')).toBe('/series/a%2Fb');
    expect(playerBackTarget('a?b')).toBe('/series/a%3Fb');
  });
});

describe('HOME_PATH', () => {
  it('is the absolute site root', () => {
    expect(HOME_PATH).toBe('/');
  });
});
