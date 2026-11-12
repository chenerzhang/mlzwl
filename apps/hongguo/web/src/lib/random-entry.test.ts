import { describe, expect, it } from 'vitest';
import { randomFailureMessage } from './random-entry';

/**
 * 错误文案的边界证据（P2-5）。
 *
 * 只测纯函数，不引入 jsdom，也不构造 `ApiError`——`ApiError extends Error`，
 * 用普通 `Error` 就能覆盖同一条分支。
 */

describe('randomFailureMessage', () => {
  it('uses the error message', () => {
    expect(randomFailureMessage(new Error('排行榜暂时没有可用的剧集'))).toBe('排行榜暂时没有可用的剧集');
    expect(randomFailureMessage(new Error('HTTP 500'))).toBe('HTTP 500');
  });

  it('falls back when the message is empty or whitespace', () => {
    expect(randomFailureMessage(new Error(''))).toBe('请稍后重试');
    expect(randomFailureMessage(new Error('   '))).toBe('请稍后重试');
  });

  it('falls back for values that are not Error instances', () => {
    expect(randomFailureMessage('boom')).toBe('请稍后重试');
    expect(randomFailureMessage(undefined)).toBe('请稍后重试');
    expect(randomFailureMessage(null)).toBe('请稍后重试');
    expect(randomFailureMessage({ message: '看起来像错误' })).toBe('请稍后重试');
  });
});
