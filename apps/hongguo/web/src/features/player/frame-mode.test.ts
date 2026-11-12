import { describe, expect, it } from 'vitest';
import { isExpired, objectFitFor, remainingMs, sleepDeadlineMinutes } from './frame-mode';

/** 画幅映射与睡眠定时器的纯逻辑测试。`now` 全部由参数注入，模块不读全局时钟。 */

describe('objectFitFor', () => {
  it('maps every mode to the same-named object-fit value', () => {
    expect(objectFitFor('contain')).toBe('contain');
    expect(objectFitFor('cover')).toBe('cover');
    expect(objectFitFor('fill')).toBe('fill');
  });
});

describe('sleepDeadlineMinutes', () => {
  it('adds whole minutes to the monotonic clock', () => {
    expect(sleepDeadlineMinutes(1, 1_000)).toBe(61_000);
    expect(sleepDeadlineMinutes(30, 0)).toBe(1_800_000);
  });

  it('supports fractional minutes', () => {
    expect(sleepDeadlineMinutes(0.5, 0)).toBe(30_000);
  });

  it('does not move the deadline for zero minutes', () => {
    expect(sleepDeadlineMinutes(0, 4_200)).toBe(4_200);
  });
});

describe('remainingMs', () => {
  it('counts down', () => {
    expect(remainingMs(61_000, 1_000)).toBe(60_000);
  });

  it('returns 0 at the deadline', () => {
    expect(remainingMs(61_000, 61_000)).toBe(0);
  });

  it('clamps negative values to 0', () => {
    expect(remainingMs(1_000, 5_000)).toBe(0);
  });
});

describe('isExpired', () => {
  it('is false before the deadline', () => {
    expect(isExpired(61_000, 60_999)).toBe(false);
  });

  it('is true exactly at the deadline', () => {
    expect(isExpired(61_000, 61_000)).toBe(true);
  });

  it('is true after the deadline', () => {
    expect(isExpired(61_000, 99_000)).toBe(true);
  });
});
