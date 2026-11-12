// 子路径导入的理由见 `definition-selection.ts`：走 barrel 会把 zod 打进首屏。
import { COVER_PATH_PREFIX, MAX_COVER_TOKEN_LENGTH, isCoverProxyUrl } from '@mlzwl/hongguo-shared/definitions';

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
  /**
   * 快照格式版本。不匹配时整体丢弃。
   *
   * 2：`coverUrl` 只接受本服务的 `/api/cover/<令牌>` 代理地址。版本 1 的存档可能
   * 带旧格式 `/api/cover?u=<上游签名 URL>`，必须整体作废而不是继续渲染——否则
   * 上游签名会从 `localStorage` 重新流回 DOM 与网络面板。
   */
  version: 2;
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
   * 封面地址，必须是本服务的 `/api/cover/<令牌>` 代理地址。
   *
   * 不接受上游直链，也不接受旧格式 `/api/cover?u=`：两者都会把上游签名带进
   * 页面。校验规则见 shared 的 `isCoverProxyUrl`。
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
/**
 * `coverUrl` 长度上限。
 *
 * 直接取 shared 的 `MAX_COVER_TOKEN_LENGTH` 加上路径前缀长度：这个值同时是
 * 服务端 Fastify `maxParamLength` 的上限。**不要在这里另写字面量**——曾经
 * 前端允许 4096、服务端只收 2048，超过的令牌浏览器稳定 414。
 *
 * **不允许截断**：截断后的令牌解不开，请求必然 400，得到一张永远坏掉的封面。
 * 超长时整个 `coverUrl` 丢掉，让卡片退化成纯文字，而不是留一个坏地址。
 */
export const MAX_COVER_URL_LENGTH = COVER_PATH_PREFIX.length + MAX_COVER_TOKEN_LENGTH;

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
    /*
      写路径必须和读路径（`parseItem`）用同一套校验：只收代理地址。
      只查长度是不够的——旧格式 `/api/cover?u=<上游签名 URL>` 长度也合法，
      写进 version 2 之后要到下次读取才整份作废，期间签名一直留在 localStorage。
      超长同样丢掉整个地址，绝不截断：截断后的令牌无法解密，只会留下坏封面。
    */
    if (item.coverUrl !== undefined && item.coverUrl.length <= MAX_COVER_URL_LENGTH && isCoverProxyUrl(item.coverUrl)) {
      summary.coverUrl = item.coverUrl;
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
  // 版本必须严格等于 2：旧存档（含带签名的 `coverUrl`）整体失效，而不是被半读半猜。
  if (record['version'] !== 2) {
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
  return { version: 2, savedAt, items };
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
    // 只接受代理地址：上游直链和旧 `?u=` 格式都会把签名带进页面。
    if (!isCoverProxyUrl(coverUrl)) {
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
