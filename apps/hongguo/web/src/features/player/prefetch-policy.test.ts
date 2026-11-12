import { describe, expect, it } from 'vitest';
import { shouldPrefetch } from './prefetch-policy';

/**
 * 预热策略的纯逻辑测试。
 *
 * 不引入 jsdom：被测模块 import 期不访问 `window`，所有输入都是参数。
 * 用例照 Kotlin 侧 `PrefetchPolicy.nearEnd()` 的语义写：判断的是**墙钟时间**，
 * 剩余片长要除以倍速。
 */

describe('shouldPrefetch', () => {
  it('rejects unknown or empty duration', () => {
    expect(shouldPrefetch({ position: 0, duration: 0, speed: 1 })).toBe(false);
    expect(shouldPrefetch({ position: 0, duration: Number.NaN, speed: 1 })).toBe(false);
    expect(shouldPrefetch({ position: 0, duration: Number.POSITIVE_INFINITY, speed: 1 })).toBe(false);
  });

  it('treats a non-positive or non-finite speed as 1', () => {
    const base = { position: 70, duration: 100 };
    expect(shouldPrefetch({ ...base, speed: 0 })).toBe(true);
    expect(shouldPrefetch({ ...base, speed: Number.NaN })).toBe(true);
    expect(shouldPrefetch({ ...base, speed: 1 })).toBe(true);
  });

  it('triggers at 30 seconds remaining and not at 31 at 1x', () => {
    expect(shouldPrefetch({ position: 70, duration: 100, speed: 1 })).toBe(true);
    expect(shouldPrefetch({ position: 69, duration: 100, speed: 1 })).toBe(false);
  });

  it('divides remaining time by speed', () => {
    // 2 倍速下剩余 61 秒 = 墙钟 30.5 秒，已超出 30 秒窗口；1 倍速下更早触发。
    expect(shouldPrefetch({ position: 39, duration: 100, speed: 2 })).toBe(false);
    expect(shouldPrefetch({ position: 39, duration: 100, speed: 1 })).toBe(false);
    // 2 倍速下剩余 60 秒 = 墙钟 30 秒，正好卡在窗口边界上。
    expect(shouldPrefetch({ position: 40, duration: 100, speed: 2 })).toBe(true);
    // 2 倍速下剩余 59 秒 = 墙钟 29.5 秒，已在窗口内。
    expect(shouldPrefetch({ position: 41, duration: 100, speed: 2 })).toBe(true);
  });

  it('uses wall-clock time, so 2x triggers earlier than 1x', () => {
    // 剩余 59 秒：1 倍速时墙钟 59 秒，窗口外；2 倍速时墙钟 29.5 秒，窗口内。
    expect(shouldPrefetch({ position: 41, duration: 100, speed: 1 })).toBe(false);
    expect(shouldPrefetch({ position: 41, duration: 100, speed: 2 })).toBe(true);
  });

  it('rejects a negative or non-finite position', () => {
    expect(shouldPrefetch({ position: -1, duration: 100, speed: 1 })).toBe(false);
    expect(shouldPrefetch({ position: Number.NaN, duration: 100, speed: 1 })).toBe(false);
  });

  it('treats remaining equal to the window as inside it', () => {
    expect(shouldPrefetch({ position: 70, duration: 100, speed: 1, windowSeconds: 30 })).toBe(true);
    expect(shouldPrefetch({ position: 70, duration: 100, speed: 1, windowSeconds: 29 })).toBe(false);
  });
});
