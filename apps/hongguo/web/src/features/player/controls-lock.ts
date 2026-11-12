/**
 * 控件隐藏锁的来源集合。
 *
 * **为什么不是一个布尔值**：控件「不自动隐藏」有多个互相独立的来源——鼠标停在
 * 底栏、拖动进度条、长按加速、倍速菜单展开、音量滑块展开。用单个布尔值时，任一
 * 来源释放都会把整把锁打开：鼠标停在底栏不动，打开再关掉倍速菜单，关闭分支把
 * 布尔值设成 `false`，3.2 秒后控件就在鼠标还悬停其上时消失了。
 *
 * 用集合记「谁还在锁」之后，只有所有来源都释放才算解锁。这是纯逻辑，不碰 DOM，
 * 因此可以在 node 环境直接测（本包约定 web 只测纯逻辑）。
 */

/** 锁的来源。每个来源在同一时刻只算一次。 */
export type LockSource = 'hover' | 'scrub' | 'long-press' | 'speed-menu' | 'volume';

/** 加一个锁源，返回新的集合（不修改入参）。重复添加是幂等的。 */
export function withLock(locks: ReadonlySet<LockSource>, source: LockSource): Set<LockSource> {
  const next = new Set(locks);
  next.add(source);
  return next;
}

/** 释放一个锁源，返回新的集合（不修改入参）。释放不存在的来源是幂等的。 */
export function withoutLock(locks: ReadonlySet<LockSource>, source: LockSource): Set<LockSource> {
  const next = new Set(locks);
  next.delete(source);
  return next;
}

/** 只要还有任意一个来源在锁，控件就不能自动隐藏。 */
export function isLocked(locks: ReadonlySet<LockSource>): boolean {
  return locks.size > 0;
}
