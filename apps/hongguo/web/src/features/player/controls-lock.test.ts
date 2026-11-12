import { describe, expect, it } from 'vitest';
import { isLocked, withLock, withoutLock, type LockSource } from './controls-lock';

/**
 * 锁集合的纯逻辑测试。
 *
 * 重点验证「重叠锁」：这是单个布尔值做不到的事，也是本次要修的 bug。
 * 期望值全部手写常量，不用实现自身逻辑反推。
 */

describe('controls-lock', () => {
  it('is unlocked when empty', () => {
    expect(isLocked(new Set())).toBe(false);
  });

  it('locks after adding one source', () => {
    expect(isLocked(withLock(new Set(), 'hover'))).toBe(true);
  });

  it('stays locked while any source remains', () => {
    // 鼠标停在底栏（hover）时打开倍速菜单（speed-menu），再关掉菜单：
    // hover 还握着锁，控件不能隐藏。这是单个布尔值会漏掉的场景。
    let locks: Set<LockSource> = new Set();
    locks = withLock(locks, 'hover');
    locks = withLock(locks, 'speed-menu');
    expect(isLocked(locks)).toBe(true);
    locks = withoutLock(locks, 'speed-menu');
    expect(isLocked(locks)).toBe(true);
    expect([...locks]).toEqual(['hover']);
  });

  it('unlocks only after the last source is released', () => {
    let locks: Set<LockSource> = new Set();
    locks = withLock(locks, 'scrub');
    locks = withLock(locks, 'long-press');
    locks = withoutLock(locks, 'scrub');
    locks = withoutLock(locks, 'long-press');
    expect(isLocked(locks)).toBe(false);
  });

  it('is idempotent when the same source is added twice', () => {
    let locks: Set<LockSource> = new Set();
    locks = withLock(locks, 'volume');
    locks = withLock(locks, 'volume');
    expect(locks.size).toBe(1);
    locks = withoutLock(locks, 'volume');
    expect(isLocked(locks)).toBe(false);
  });

  it('is idempotent when releasing a source that was never added', () => {
    // 音量滑块没展开过也会收到一次「关闭」回调，此时不能因此解掉 hover 的锁。
    let locks: Set<LockSource> = new Set();
    locks = withLock(locks, 'hover');
    locks = withoutLock(locks, 'volume');
    expect(isLocked(locks)).toBe(true);
  });

  it('does not mutate the input set', () => {
    const original: Set<LockSource> = new Set(['hover']);
    withLock(original, 'scrub');
    withoutLock(original, 'hover');
    expect([...original]).toEqual(['hover']);
  });

  it('tracks all five sources independently', () => {
    const all: LockSource[] = ['hover', 'scrub', 'long-press', 'speed-menu', 'volume'];
    let locks: Set<LockSource> = new Set();
    for (const source of all) {
      locks = withLock(locks, source);
    }
    expect(locks.size).toBe(5);
    for (const source of all) {
      locks = withoutLock(locks, source);
    }
    expect(isLocked(locks)).toBe(false);
  });
});
