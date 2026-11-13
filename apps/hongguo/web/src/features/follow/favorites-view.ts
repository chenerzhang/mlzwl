import type { FollowRecord } from '@mlzwl/hongguo-shared';
import { hasUpdates } from './follow-model';

/** 收藏页的一条记录，带上派生出来的展示字段。 */
export interface FavoriteEntry {
  record: FollowRecord;
  /** 是否有未看的新集。只有追更中的剧才可能为真。 */
  hasUpdates: boolean;
}

/**
 * 收藏页只展示 `favorite === true` 的记录。
 *
 * 追更但没收藏的剧不进收藏页——那是「更新提醒」的范畴，不是「我的收藏」。
 * 两者混在一页会让「收藏」这个词失去边界：用户取消了收藏却发现剧还在列表里。
 *
 * 排序：有更新的在前，然后按最近一次 `checkedAt` 倒序。
 * 有更新的排前面是因为那是用户唯一需要「处理」的信息。
 */
export function favoriteEntries(records: readonly FollowRecord[]): FavoriteEntry[] {
  return records
    .filter((record) => record.favorite)
    .map((record) => ({ record, hasUpdates: hasUpdates(record) }))
    .sort((left, right) => {
      const updateOrder = Number(right.hasUpdates) - Number(left.hasUpdates);
      return updateOrder !== 0 ? updateOrder : right.record.checkedAt - left.record.checkedAt;
    });
}

/** 收藏页顶部的两个数字：总数与其中有多少部在追更且有更新。 */
export function favoritesSummary(records: readonly FollowRecord[]): { total: number; withUpdates: number } {
  const entries = favoriteEntries(records);
  return {
    total: entries.length,
    withUpdates: entries.filter((entry) => entry.hasUpdates).length,
  };
}
