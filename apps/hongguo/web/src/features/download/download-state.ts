export type DownloadStatus = 'idle' | 'downloading' | 'done' | 'failed';

export interface DownloadEntry {
  status: DownloadStatus;
  received: number;
  total: number | null;
  error?: string;
}

/**
 * 一集的下载记录，**按档位分桶**。
 *
 * 同一集的不同档是两份文件（`123-1080p.mp4` / `123-360p.mp4`），状态也必须
 * 分开记。若只按集号存一份，先下完 1080p 再下完 360p，1080p 的记录会被覆盖，
 * 切回 1080p 时界面又允许重下同一份文件。
 *
 * 键是档位标签；服务端默认档（请求里不带 `definition`）用 `DEFAULT_DEFINITION_KEY`。
 */
export type EpisodeDownloads = Readonly<Record<string, DownloadEntry>>;

/** 整个下载状态：集号 → 档位 → 记录。 */
export type DownloadEntries = Readonly<Record<string, EpisodeDownloads>>;

/**
 * 「没有显式指定档位」时用的桶键。
 *
 * 不能用 `undefined` 做对象键（会被转成字符串 `"undefined"`，与其他值混淆），
 * 所以用一个不可能与真实档位标签冲突的前缀：档位标签只允许 `\d{3,4}p`。
 */
export const DEFAULT_DEFINITION_KEY = 'auto';

/** 新下载任务的初始状态。 */
export function initialEntry(): DownloadEntry {
  return { status: 'idle', received: 0, total: null };
}

/** 把档位折算成桶键。 */
export function definitionKey(definition: string | undefined): string {
  return definition ?? DEFAULT_DEFINITION_KEY;
}

/** 取某一集某一档的记录；没有记录时返回初始状态。 */
export function entryFor(entries: DownloadEntries, episodeId: string, definition: string | undefined): DownloadEntry {
  return entries[episodeId]?.[definitionKey(definition)] ?? initialEntry();
}

/**
 * 写入某一集某一档的记录，保持其他档位不变。
 *
 * 这是「按档位记账」的唯一写入口：所有状态更新都走它，避免某个分支顺手
 * 把整集覆盖掉。
 */
export function withEntry(
  entries: DownloadEntries,
  episodeId: string,
  definition: string | undefined,
  entry: DownloadEntry,
): DownloadEntries {
  return {
    ...entries,
    [episodeId]: { ...entries[episodeId], [definitionKey(definition)]: entry },
  };
}

/** 该集是否有任一档正在下载。并发限制按集算，UI 也要按集显示进度。 */
export function activeEntry(entries: DownloadEntries, episodeId: string): DownloadEntry | undefined {
  const buckets = entries[episodeId];
  if (buckets === undefined) {
    return undefined;
  }
  return Object.values(buckets).find((entry) => entry.status === 'downloading');
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
