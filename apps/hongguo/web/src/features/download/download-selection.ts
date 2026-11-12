import type { DownloadEntry } from './download-state';

/** 全选框的三态。`partial` 对应 HTML 的 `indeterminate`。 */
export type SelectionState = 'none' | 'partial' | 'all';

/**
 * 勾选或取消勾选一集。
 *
 * 返回新集合而不原地修改：调用方是 React 状态，原地改不会触发重渲染。
 * `Set` 保留插入顺序，所以批量提交的顺序与用户点选顺序一致。
 */
export function toggleEpisode(selected: ReadonlySet<string>, episodeId: string): Set<string> {
  const next = new Set(selected);
  if (next.has(episodeId)) {
    next.delete(episodeId);
  } else {
    next.add(episodeId);
  }
  return next;
}

/** 当前选中状态。可选集为空时按「未选」处理，避免空列表显示成已全选。 */
export function selectionState(selected: ReadonlySet<string>, episodeIds: readonly string[]): SelectionState {
  if (episodeIds.length === 0) {
    return 'none';
  }
  let hits = 0;
  for (const episodeId of episodeIds) {
    if (selected.has(episodeId)) {
      hits += 1;
    }
  }
  if (hits === 0) {
    return 'none';
  }
  return hits === episodeIds.length ? 'all' : 'partial';
}

/**
 * 全选 / 取消全选。
 *
 * 已经全选时清空，其它情况（含部分选中）一律补成全选：部分选中时再点全选框，
 * 用户的意图是「都要」，不是「都去掉」。
 */
export function toggleAllEpisodes(selected: ReadonlySet<string>, episodeIds: readonly string[]): Set<string> {
  if (selectionState(selected, episodeIds) === 'all') {
    return new Set();
  }
  return new Set(episodeIds);
}

/**
 * 批量提交时真正需要下载的集。
 *
 * `availableIds` 是当前可下载集的**白名单**，必须传：剧集数据刷新后某集可能从可播
 * 变为 `playable === false`，但 `selected` 里还残留着它的 id。只看 `selected` 会把
 * 已经不可下载的集提交出去，队列必然失败。
 *
 * 同时跳过已下载、正在下载、排队中的集：重复提交会写出同名文件的第二份，还会
 * 占用并发槽位拖慢其它集。失败的集保留在结果里，批量提交本身就是它的重试入口。
 */
export function selectBatchTargets(
  selected: ReadonlySet<string>,
  availableIds: readonly string[],
  entries: Record<string, DownloadEntry>,
  queued: ReadonlySet<string>,
): string[] {
  const available = new Set(availableIds);
  const targets: string[] = [];
  for (const episodeId of selected) {
    if (!available.has(episodeId)) {
      continue;
    }
    if (queued.has(episodeId)) {
      continue;
    }
    const status = entries[episodeId]?.status;
    if (status === 'done' || status === 'downloading') {
      continue;
    }
    targets.push(episodeId);
  }
  return targets;
}
