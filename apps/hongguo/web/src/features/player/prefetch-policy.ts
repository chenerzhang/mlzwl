/** 默认预热窗口（秒）。 */
const DEFAULT_WINDOW_SECONDS = 30;

/**
 * 剩余播放时间是否已进入预热窗口。
 *
 * 照 Kotlin 侧 `PrefetchPolicy.nearEnd()` 的语义：按**墙钟时间**判断，所以要除以
 * 当前倍速。2 倍速下剩余 60 秒只剩 30 秒真实等待，此时就该开始预热下一集。
 * 时长未知（直播、元数据还没加载）或参数不可信时一律返回 `false`，宁可晚预热
 * 也不要在开场就抢带宽。
 */
export function shouldPrefetch(input: {
  /** 当前播放位置（秒）。 */
  position: number;
  /** 总时长（秒）；未知时传 0 或 NaN。 */
  duration: number;
  /** 当前倍速。 */
  speed: number;
  /** 预热窗口（秒），默认 30。 */
  windowSeconds?: number;
}): boolean {
  const { position, duration, speed, windowSeconds = DEFAULT_WINDOW_SECONDS } = input;
  if (!Number.isFinite(duration) || duration <= 0) {
    return false;
  }
  if (!Number.isFinite(position) || position < 0) {
    return false;
  }
  // 倍速不可信时按 1 处理：读存档失败或浏览器给了 NaN 都不该让预热彻底失效。
  const effectiveSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return (duration - position) / effectiveSpeed <= windowSeconds;
}
