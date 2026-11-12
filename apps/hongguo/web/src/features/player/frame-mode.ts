/** 画幅模式三档。 */
export type FrameMode = 'contain' | 'cover' | 'fill';

/**
 * 画幅模式对应的 CSS `object-fit` 值。
 *
 * - `contain`：完整画面，多出来的地方留黑。竖屏视频在横屏容器里的默认值，
 *   宁可两侧留黑也不裁掉人物。
 * - `cover`：铺满容器，超出部分裁掉。短剧里常见「人物在中间、上下是装饰」的
 *   构图，裁掉比留黑好看。
 * - `fill`：拉伸铺满，画面会变形。只在用户明确选择时使用。
 */
export function objectFitFor(mode: FrameMode): 'contain' | 'cover' | 'fill' {
  switch (mode) {
    case 'contain':
      return 'contain';
    case 'cover':
      return 'cover';
    case 'fill':
      return 'fill';
  }
}

/**
 * 睡眠定时器的 deadline（毫秒，单调时钟）。
 *
 * 用 `performance.now()` 而不是 `Date.now()`：系统时钟被 NTP 或用户手改时，
 * `Date.now()` 会跳变，定时器可能提前或永远不到点。
 */
export function sleepDeadlineMinutes(minutes: number, now: number): number {
  return now + minutes * 60_000;
}

/** 剩余毫秒。已过点返回 0，不返回负数。 */
export function remainingMs(deadline: number, now: number): number {
  return Math.max(deadline - now, 0);
}

/** 是否已到点。 */
export function isExpired(deadline: number, now: number): boolean {
  return now >= deadline;
}
