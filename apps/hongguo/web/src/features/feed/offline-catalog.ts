/**
 * 离线目录缓存（P1-7）。
 *
 * 规则照上游 `CatalogSnapshot.kt`：7 天过期、最多 30 条、序列化后 ≤ 200 KB、
 * `description` 截断到 1500 字符、解码时逐字段校验，**任何一条不合法就整体丢弃**。
 *
 * 两条硬约束：
 * 1. 只缓存白名单字段。签名播放地址（`streamUrl`）、`spade_a` 之类的追踪字段
 *    以及它们携带的 query 参数一律不落盘——落盘等于把有时效的签名长期留在
 *    `localStorage` 里，既泄露参数也必然过期。
 * 2. 本模块是纯函数，import 期不碰任何浏览器全局对象，所以能在 node 下直接测。
 */

/** 缓存的目录快照。 */
export interface CatalogSnapshot {
  /** 快照格式版本。不匹配时整体丢弃。 */
  version: 1;
  /** 写入时间（毫秒）。 */
  savedAt: number;
  /** 剧集列表。最多 `MAX_ITEMS` 条。 */
  items: readonly OfflineSeriesSummary[];
}

/** 精简后的剧集摘要：只留离线展示必需字段。 */
export interface OfflineSeriesSummary {
  id: string;
  title: string;
  /**
   * 封面地址。保留原样（通常是本服务的 `/api/cover?u=...` 代理地址），
   * 不做 URL 格式校验：开发期可能是相对路径。
   */
  coverUrl?: string | undefined;
  description?: string | undefined;
  episodeCount?: number | undefined;
}

/** 序列化后的上限。 */
export const MAX_SERIALIZED_BYTES = 200 * 1024;
/** 条数上限。 */
export const MAX_ITEMS = 30;
/** 过期时间：7 天。 */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** `description` 截断长度。 */
export const MAX_DESCRIPTION_LENGTH = 1500;
/** `coverUrl` 截断长度。封面代理地址带上游 URL，留足余量但不允许无限长。 */
export const MAX_COVER_URL_LENGTH = 2048;

/** 上游剧集 id 是纯数字，最长 30 位。 */
const SERIES_ID_PATTERN = /^[0-9]{1,30}$/;

/**
 * 把上游摘要精简成可离线保存的形式。超过 `MAX_ITEMS` 时截断。
 *
 * 显式逐字段挑选，**不用 `{ ...item }`**：上游对象以后多出任何字段（播放地址、
 * 追踪参数）都不会被顺手带进 `localStorage`。
 *
 * 写入时按与 `parseItem` **同一套规则**过滤。两边不对称会让整份快照被读路径丢弃：
 * 只要上游出现一条非数字 id，写进去之后下次读取会整体返回 `null`，
 * 于是缓存永远不命中，而且没人看得出来为什么。
 */
export function toSnapshotItems(items: readonly OfflineSeriesSummary[]): OfflineSeriesSummary[] {
  const result: OfflineSeriesSummary[] = [];
  for (const item of items) {
    if (result.length >= MAX_ITEMS) {
      break;
    }
    if (!SERIES_ID_PATTERN.test(item.id) || item.title.trim() === '') {
      continue;
    }
    const summary: OfflineSeriesSummary = { id: item.id, title: item.title };
    if (item.coverUrl !== undefined) {
      summary.coverUrl = item.coverUrl.slice(0, MAX_COVER_URL_LENGTH);
    }
    if (item.description !== undefined) {
      summary.description = item.description.slice(0, MAX_DESCRIPTION_LENGTH);
    }
    if (item.episodeCount !== undefined) {
      if (!Number.isInteger(item.episodeCount) || item.episodeCount < 0) {
        continue;
      }
      summary.episodeCount = item.episodeCount;
    }
    result.push(summary);
  }
  return result;
}

/**
 * 校验并解析快照。任何一条不合法就返回 null（整体丢弃，不做部分信任）。
 *
 * `now` 由调用方传入而不是内部取 `Date.now()`：过期判断是这里唯一和时钟有关的
 * 分支，注入时间才能测「7 天前」和「时钟回拨」。
 */
export function parseSnapshot(raw: string | null, now: number): CatalogSnapshot | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 手改坏了的存档、被别的版本写过的存档，都当作没有缓存。
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  // 版本必须严格等于 1：将来改格式时旧存档整体失效，而不是被半读半猜。
  if (record['version'] !== 1) {
    return null;
  }
  const savedAt = record['savedAt'];
  if (typeof savedAt !== 'number' || !Number.isSafeInteger(savedAt) || savedAt < 0) {
    return null;
  }
  // `savedAt > now` 说明系统时钟被回拨过，此时「多久以前」不可信，直接丢弃。
  if (savedAt > now) {
    return null;
  }
  if (now - savedAt > MAX_AGE_MS) {
    return null;
  }
  const rawItems = record['items'];
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return null;
  }
  const items: OfflineSeriesSummary[] = [];
  for (const rawItem of rawItems) {
    const item = parseItem(rawItem);
    if (item === null) {
      return null;
    }
    items.push(item);
  }
  return { version: 1, savedAt, items };
}

/** 校验单条摘要。任何字段不合法都返回 null。 */
function parseItem(value: unknown): OfflineSeriesSummary | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = record['id'];
  if (typeof id !== 'string' || !SERIES_ID_PATTERN.test(id)) {
    return null;
  }
  const title = record['title'];
  // 纯空白标题渲染出来就是一张没有文字的卡，和空串一样按不合法处理。
  if (typeof title !== 'string' || title.trim() === '') {
    return null;
  }
  const item: OfflineSeriesSummary = { id, title };
  const coverUrl = record['coverUrl'];
  if (coverUrl !== undefined) {
    if (typeof coverUrl !== 'string' || coverUrl.length > MAX_COVER_URL_LENGTH) {
      return null;
    }
    item.coverUrl = coverUrl;
  }
  const description = record['description'];
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH) {
      return null;
    }
    item.description = description;
  }
  const episodeCount = record['episodeCount'];
  if (episodeCount !== undefined) {
    if (typeof episodeCount !== 'number' || !Number.isInteger(episodeCount) || episodeCount < 0) {
      return null;
    }
    item.episodeCount = episodeCount;
  }
  return item;
}

/**
 * 序列化快照。超过 `MAX_SERIALIZED_BYTES` 时返回 null。
 *
 * 按 UTF-8 字节数判断而不是 `string.length`：中文标题一个字占 3 字节，
 * 用字符数会低估两三倍，写进 `localStorage` 才在别的设备上撞配额。
 */
export function serializeSnapshot(snapshot: CatalogSnapshot): string | null {
  let raw: string;
  try {
    raw = JSON.stringify(snapshot);
  } catch {
    // 快照里出现循环引用等异常值时不抛给调用方，静默当作写不进去。
    return null;
  }
  if (new TextEncoder().encode(raw).length > MAX_SERIALIZED_BYTES) {
    return null;
  }
  return raw;
}
