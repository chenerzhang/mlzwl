import {
  parseSnapshot,
  serializeSnapshot,
  toSnapshotItems,
  type CatalogSnapshot,
  type OfflineSeriesSummary,
} from './offline-catalog';

/**
 * 离线目录的 `localStorage` 存取（P1-7）。
 *
 * 三个函数都是「尽力而为」：离线缓存是纯优化，任何一步失败（隐私模式抛
 * `SecurityError`、超出配额、存档被手改坏）都静默退化到「没有缓存」，
 * 绝不让首页因为缓存出错而白屏。
 */

/** localStorage 键。带 `v1` 版本段，和存档里的 `version` 字段互为双保险。 */
export const CATALOG_STORAGE_KEY = 'dsh-hongguo.catalog.v1';

/**
 * 取 `localStorage`，拿不到就返回 null。
 *
 * Safari 隐私模式下**访问 `window.localStorage` 本身**就会抛 `SecurityError`，
 * 所以 try/catch 必须包住取值，而不是只包住读写。
 */
function readLocalStorage(): Storage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 读缓存。命中返回快照，否则 null。 */
export function readCatalogSnapshot(now: number = Date.now()): CatalogSnapshot | null {
  const storage = readLocalStorage();
  if (storage === null) {
    return null;
  }
  try {
    return parseSnapshot(storage.getItem(CATALOG_STORAGE_KEY), now);
  } catch {
    // 读取本身也可能抛（隐私模式、被浏览器策略禁用）。
    return null;
  }
}

/**
 * 写缓存。超限或写失败时静默丢弃（离线缓存是纯优化）。
 *
 * **不走 `write-queue`**：写队列是为高频增量写（观看记录、搜索历史）准备的，
 * 靠 2 秒合并窗口省下重复序列化。这里每次都是整体覆盖、一次访问最多写一次，
 * 再排队只会让「刚看到的数据」晚 2 秒才落盘——而这 2 秒恰好是用户断网切走的
 * 窗口。低频整体覆盖写直接同步写更简单也更可靠。
 */
export function writeCatalogSnapshot(items: readonly OfflineSeriesSummary[], now: number = Date.now()): void {
  const storage = readLocalStorage();
  if (storage === null) {
    return;
  }
  const snapshotItems = toSnapshotItems(items);
  if (snapshotItems.length === 0) {
    // 没有可展示的条目，写了也只会让下次启动显示空列表。
    return;
  }
  const raw = serializeSnapshot({ version: 1, savedAt: now, items: snapshotItems });
  if (raw === null) {
    return;
  }
  try {
    storage.setItem(CATALOG_STORAGE_KEY, raw);
  } catch {
    // 配额满（QuotaExceededError）时丢弃这次写：旧快照还能用，删掉反而更差。
  }
}

/** 清空缓存。 */
export function clearCatalogSnapshot(): void {
  const storage = readLocalStorage();
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(CATALOG_STORAGE_KEY);
  } catch {
    // 同 read：访问被禁用时无事可做。
  }
}
