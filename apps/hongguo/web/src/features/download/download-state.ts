export type DownloadStatus = 'idle' | 'downloading' | 'done' | 'failed';

export interface DownloadEntry {
  status: DownloadStatus;
  received: number;
  total: number | null;
  error?: string;
}

/** 新下载任务的初始状态。 */
export function initialEntry(): DownloadEntry {
  return { status: 'idle', received: 0, total: null };
}

/** 已知总长度时计算整数百分比；长度未知时不伪造进度。 */
export function progressPercent(entry: DownloadEntry): number | null {
  if (entry.total === null) {
    return null;
  }
  if (entry.total === 0) {
    return null;
  }
  return Math.min(100, Math.floor((entry.received / entry.total) * 100));
}

/** 解析响应的 Content-Length；无效或负数长度一律视为未知。 */
export function parseContentLength(headerValue: string | null): number | null {
  if (headerValue === null || headerValue.trim() === '') {
    return null;
  }
  const value = Number(headerValue);
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

/** 把任意异常转换为可直接展示的中文消息。 */
export function describeDownloadFailure(cause: unknown): string {
  if (cause instanceof Error && cause.name === 'AbortError') {
    return '已取消';
  }
  if (cause instanceof Error && cause.message.trim() !== '') {
    return cause.message;
  }
  return '下载失败，请稍后重试';
}

/** 保留失败前的字节进度，便于界面解释失败发生在何处。 */
export function nextEntryAfterFailure(entry: DownloadEntry, cause: unknown): DownloadEntry {
  return {
    ...entry,
    status: 'failed',
    error: describeDownloadFailure(cause),
  };
}

/** 按 1024 进制格式化字节数；KB 及以上固定保留一位小数。 */
export function formatBytes(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safeBytes < 1024) {
    return `${Math.floor(safeBytes)} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
