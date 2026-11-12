import type { FollowRecord, FollowState } from '@mlzwl/hongguo-shared';
import { hasUpdates } from './follow-model';

interface FavoriteGroupDefinition {
  state: FollowState;
  title: string;
  emptyHint: string;
}

export interface FavoriteGroup extends FavoriteGroupDefinition {
  records: FollowRecord[];
}

/** 固定分组顺序，避免收藏数量变化时页面区块跳位。 */
export const FAVORITE_GROUPS = [
  { state: 'watching', title: '在看', emptyHint: '还没有正在看的短剧' },
  { state: 'planned', title: '想看', emptyHint: '还没有想看的短剧' },
  { state: 'watched', title: '看完', emptyHint: '还没有看完的短剧' },
] as const satisfies readonly FavoriteGroupDefinition[];

/** 按追更状态分组；有更新的记录优先，同一优先级按最近检查时间排列。 */
export function groupFavorites(records: readonly FollowRecord[]): FavoriteGroup[] {
  return FAVORITE_GROUPS.map((group) => ({
    ...group,
    records: records
      .filter((record) => record.state === group.state)
      .sort((left, right) => {
        const updateOrder = Number(hasUpdates(right)) - Number(hasUpdates(left));
        return updateOrder !== 0 ? updateOrder : right.checkedAt - left.checkedAt;
      }),
  }));
}

/** 收藏页的三个 tab 始终完整返回，空组也不会因取消收藏而消失。 */
export function favoritesTabs(records: readonly FollowRecord[]): FavoriteGroup[] {
  return groupFavorites(records);
}

/** 默认打开第一个非空 tab；全部为空时稳定回到首个「在看」。 */
export function resolveInitialTab(groups: readonly FavoriteGroup[]): FollowState {
  return groups.find((group) => group.records.length > 0)?.state ?? FAVORITE_GROUPS[0].state;
}

/** 收藏页顶部只展示能帮助用户判断列表规模的两个数字。 */
export function favoritesSummary(records: readonly FollowRecord[]): { total: number; withUpdates: number } {
  return {
    total: records.length,
    withUpdates: records.filter(hasUpdates).length,
  };
}
