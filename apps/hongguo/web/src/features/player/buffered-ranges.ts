/** 一段连续可播的时间区间（秒）。 */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * 把 `video.buffered` 转成数组并合并相邻/重叠区间。
 *
 * 浏览器的 `TimeRanges` 已经是升序且通常不重叠，但拖动进度条后会出现「中间没缓冲、
 * 两端有」的两段；某些浏览器的实现还会给出首尾相接的两段。合并相邻（`start` 正好
 * 等于上一段 `end`）是为了不让进度条上出现 1px 的假缝隙。
 *
 * 空区间（`end <= start`）与非有限值直接丢掉：`TimeRanges` 在元数据就绪前是空的，
 * 中途切换清晰度也可能读到 `NaN`，画到进度条上会变成整条高亮。
 */
export function toRanges(source: { length: number; start(i: number): number; end(i: number): number }): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const start = source.start(index);
    const end = source.end(index);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      continue;
    }
    const previous = ranges[ranges.length - 1];
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * 从 `position` 起连续可播的长度（秒）。
 *
 * 用户拖到未缓冲处时进度条仍会显示「已缓冲」，这是本函数的用处：调用方可以据此
 * 提示「当前位置还没下载好」。`position` 不在任何区间内时返回 0。
 */
export function continuousBuffer(ranges: readonly TimeRange[], position: number): number {
  for (const range of ranges) {
    if (position >= range.start && position <= range.end) {
      return range.end - position;
    }
  }
  return 0;
}

/** 某时刻是否已缓冲。边界按闭区间算：正好落在 `end` 上仍算可播到那一帧。 */
export function isBuffered(ranges: readonly TimeRange[], time: number): boolean {
  return ranges.some((range) => time >= range.start && time <= range.end);
}
