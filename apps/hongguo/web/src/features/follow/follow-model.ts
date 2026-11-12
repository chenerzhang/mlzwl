import type { FollowRecord, FollowState } from '@mlzwl/hongguo-shared';

/**
 * 追更记录的纯逻辑（P1-8 / P1-9）。
 *
 * 这里只放无副作用的函数，不 import store、不碰 `window`，因此可以直接被
 * `tsc --noEmit` 与 vitest 覆盖。store 只负责持久化和动作分发。
 *
 * 语义照 Kotlin 侧 `Watching.kt` 的 `FavoriteUpdate`：`confirmedEpisodes` 是
 * **高水位**，`newEpisodes` 永远是 `max(0, known - confirmed)`，不用两次上游
 * 总数的差值——上游偶发返回更少集数时，差值会算出负数或误报「更新」。
 *
 * 类型从 `@mlzwl/hongguo-shared` 以 `import type` 引入：shared 的 schema 文件
 * 顶部 `import { z }`，任何值导入都会把 zod 打进浏览器包（实测 +89 kB）。
 */

/** 未看的新集数。高水位语义：只增不减，下限 0。 */
export function newEpisodes(record: Pick<FollowRecord, 'knownEpisodes' | 'confirmedEpisodes'>): number {
  return Math.max(0, record.knownEpisodes - record.confirmedEpisodes);
}

/** 是否应当显示「更新 N 集」角标（N > 0 才显示）。 */
export function hasUpdates(record: Pick<FollowRecord, 'knownEpisodes' | 'confirmedEpisodes'>): boolean {
  return newEpisodes(record) > 0;
}

/**
 * 用上游最新集数更新记录。
 * - `knownEpisodes` 取 `Math.max(旧值, 新值)`：上游偶发返回更少集数时不能把高水位降下来。
 * - `checkedAt` 只在集数真的变了（有新信息）时前进；`now < 旧 checkedAt`（时钟回拨）时保持旧值。
 * - `state` 不在这里改。
 */
export function mergeKnownEpisodes(record: FollowRecord, upstreamEpisodes: number, now: number): FollowRecord {
  // 上游给的集数不合法（负数、小数、NaN）时视为「没有新信息」，整条记录原样返回。
  if (!Number.isFinite(upstreamEpisodes) || upstreamEpisodes < 0) {
    return record;
  }
  const knownEpisodes = Math.max(record.knownEpisodes, Math.floor(upstreamEpisodes));
  if (knownEpisodes === record.knownEpisodes) {
    return record;
  }
  // 时钟回拨：`now` 早于上次记录的时间，说明本机时间被改过，这个 `now` 不可信。
  //
  // 这里**只冻结 `checkedAt`**，仍然推进 `knownEpisodes`——与计划 P1-9 的「直接返回
  // 旧值」有字面差异，是有意的：`knownEpisodes` 是纯高水位，不存在「旧值比新值更可信」
  // 的情况；而 `checkedAt` 是唯一依赖时钟的字段，回拨时保留旧值就够了。
  // 计划里那条防的是「时钟回拨导致算出负数更新数」，而高水位 + 下限 0 已经拦住它。
  const checkedAt = now < record.checkedAt ? record.checkedAt : now;
  return { ...record, knownEpisodes, checkedAt };
}

/** 用户确认看到第 N 集。`confirmedEpisodes` 取 `Math.max(旧值, n)`，且不超过 `knownEpisodes`。 */
export function confirmEpisodes(record: FollowRecord, seen: number): FollowRecord {
  if (!Number.isFinite(seen)) {
    return record;
  }
  const confirmedEpisodes = Math.min(record.knownEpisodes, Math.max(record.confirmedEpisodes, Math.floor(seen)));
  if (confirmedEpisodes === record.confirmedEpisodes) {
    return record;
  }
  return { ...record, confirmedEpisodes };
}

/** 追更按钮的三态轮转：未收藏 → planned → watching → watched → 取消。 */
export function nextFollowState(current: FollowState | undefined): FollowState | undefined {
  if (current === undefined) {
    return 'planned';
  }
  if (current === 'planned') {
    return 'watching';
  }
  if (current === 'watching') {
    return 'watched';
  }
  return undefined;
}

/** 三态的中文文案。 */
export const FOLLOW_STATE_LABELS: Record<FollowState, string> = {
  planned: '想看',
  watching: '在看',
  watched: '看完',
};
