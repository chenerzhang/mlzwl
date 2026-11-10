/** 秒 → "1:23" 或 "1:02:03"。 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 计数 → "1.2万" / "3.4亿"。小于一万时返回原始数字。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return '0';
  }
  if (value >= 100_000_000) {
    return `${(value / 100_000_000).toFixed(1)}亿`;
  }
  if (value >= 10_000) {
    return `${(value / 10_000).toFixed(1)}万`;
  }
  return String(Math.floor(value));
}

/**
 * 选集格子里的评论数是否要显示。
 *
 * 格子宽约 60px，右上角还要避开集号。零或未定义时不显示，其余都显示——
 * 具体能否放下由容器的 `overflow-hidden` + `truncate` 保证，不靠砍数据。
 */
export function shouldShowCount(value: number | undefined): value is number {
  return value !== undefined && value > 0;
}
