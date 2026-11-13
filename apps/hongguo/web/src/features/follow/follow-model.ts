import type { FollowRecord } from '@mlzwl/hongguo-shared';

/**
 * 收藏与追更的纯逻辑（P1-8 / P1-9）。
 *
 * 这里只放无副作用的函数，不 import store、不碰 `window`，因此可以直接被
 * `tsc --noEmit` 与 vitest 覆盖。store 只负责持久化和动作分发。
 *
 * **收藏与追更是两个独立的布尔标记，不是一个按钮轮转出来的多态。**
 * 收藏回答「我记住了这部剧」，追更回答「它更新时提醒我」。一个按钮只做一件事，
 * 取消收藏不需要先绕一圈「想看 → 在看 → 看完」。
 *
 * 语义照 Kotlin 侧 `Watching.kt` 的 `FavoriteUpdate`：`confirmedEpisodes` 是
 * **高水位**，`newEpisodes` 永远是 `max(0, known - confirmed)`，不用两次上游
 * 总数的差值——上游偶发返回更少集数时，差值会算出负数或误报「更新」。
 *
 * 类型从 `@mlzwl/hongguo-shared` 以 `import type` 引入：shared 的 schema 文件
 * 顶部 `import { z }`，任何值导入都会把 zod 打进浏览器包（实测 +89 kB）。
 */

/** 一条记录上可以被独立切换的两个标记。 */
export interface FollowFlags {
  favorite: boolean;
  following: boolean;
}

/** 记录不存在时，两个标记都视为关闭。 */
const NO_FLAGS: FollowFlags = { favorite: false, following: false };

/** 取出记录上的两个标记；记录不存在时返回全关。 */
export function followFlags(record: Pick<FollowRecord, 'favorite' | 'following'> | undefined): FollowFlags {
  return record === undefined ? NO_FLAGS : { favorite: record.favorite, following: record.following };
}

/** 非负整数归一化。非有限数、负数一律落到 0，小数向下取整。 */
export function normalizeCount(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** 新建或更新一条记录所需的输入。 */
export interface TrackingInput {
  seriesId: string;
  seriesTitle: string;
  coverUrl?: string;
  /** 上游报告的集数。上游可能临时少报，因此只当「证据」之一，不当真相。 */
  knownEpisodes: number;
  /** 已经看到第几集，来自观看历史。`0` 表示没看过。 */
  seenEpisodes: number;
}

/**
 * 从已有记录与本次输入算出一条新记录。纯函数，`now` 由调用方注入。
 *
 * `flag` 决定这一次动作**打开**哪个标记，另一个标记沿用已有记录的值（新建时是
 * `false`）。因此「先收藏再追更」与「先追更再收藏」得到等价结果。
 *
 * ## 两个数字的语义
 *
 * - `knownEpisodes`：上游报告过的最大集数，也是「观看历史」能提供的一个下界。
 *   取 `max(旧值, 本次上游值, 观看历史集号)`。
 *   把观看历史也当证据是必需的：上游可能临时少报（实测过），如果只看本次上游值，
 *   会把「已看到第 100 集」的真实高水位截断成 78。上游恢复到 104 集后就会误报
 *   「更新 26 集」，而真实数字是 4。
 * - `confirmedEpisodes`：已确认看到过的集数，只增不减，且不超过 `knownEpisodes`。
 *
 * ## 为什么开启追更时要把基线推到当前已知集数
 *
 * 「追更」的自然语义是「**从我开始追更以后**有更新时告诉我」。如果开追更时把
 * `confirmedEpisodes` 留在 0，一部 78 集的剧会立即显示「更新 78 集」——用户没有
 * 错过这 78 集，只是刚刚才决定追它。因此 `flag === 'following'` 且原本未追更时，
 * 基线直接推到当前已知集数。
 *
 * 收藏不做这个处理：收藏不产生角标（`hasUpdates` 要求 `following === true`），
 * 提前推高水位只会让用户以后真追更时看不到已错过的集数。
 */
export function buildTrackingRecord(
  existing: FollowRecord | undefined,
  input: TrackingInput,
  flag: 'favorite' | 'following',
  now: number,
): FollowRecord {
  const upstreamEpisodes = normalizeCount(input.knownEpisodes);
  const seenEpisodes = normalizeCount(input.seenEpisodes);
  // 观看历史也是「已知集数」的下界：看得到第 100 集，说明至少存在 100 集。
  const knownEpisodes = Math.max(existing?.knownEpisodes ?? 0, upstreamEpisodes, seenEpisodes);

  const wasFollowing = existing?.following === true;
  const previousConfirmed = existing?.confirmedEpisodes ?? 0;
  // 开启追更（原本未追更）时把基线推到当前已知集数：只对「以后的新集」发通知。
  const startBaseline = flag === 'following' && !wasFollowing ? knownEpisodes : 0;
  const confirmedEpisodes = Math.min(knownEpisodes, Math.max(previousConfirmed, seenEpisodes, startBaseline));

  const flags =
    flag === 'favorite' ? { ...followFlags(existing), favorite: true } : { ...followFlags(existing), following: true };
  const coverUrl = input.coverUrl ?? existing?.coverUrl;

  return {
    seriesId: input.seriesId,
    seriesTitle: input.seriesTitle,
    ...(coverUrl === undefined ? {} : { coverUrl }),
    ...flags,
    knownEpisodes,
    confirmedEpisodes,
    checkedAt: now,
  };
}

/**
 * 写入一条更新后的记录；两个标记都关了就把整条删掉。
 *
 * 「都关了」等于用户既不收藏也不追更，留一条空记录只会让收藏页出现空卡片。
 */
export function applyRecord(records: Record<string, FollowRecord>, record: FollowRecord): Record<string, FollowRecord> {
  if (isBlankRecord(followFlags(record))) {
    const next = { ...records };
    delete next[record.seriesId];
    return next;
  }
  return { ...records, [record.seriesId]: record };
}

/** 未看的新集数。高水位语义：只增不减，下限 0。 */
export function newEpisodes(record: Pick<FollowRecord, 'knownEpisodes' | 'confirmedEpisodes'>): number {
  return Math.max(0, record.knownEpisodes - record.confirmedEpisodes);
}

/**
 * 是否应当显示「更新 N 集」角标。
 *
 * 必须同时满足：**在追更**且**有新集**。只收藏不追更的剧不打扰用户——
 * 「我记住了这部剧」和「它更新时告诉我」是两件事，前者不该产生角标。
 */
export function hasUpdates(record: Pick<FollowRecord, 'following' | 'knownEpisodes' | 'confirmedEpisodes'>): boolean {
  return record.following && newEpisodes(record) > 0;
}

/**
 * 关掉收藏，追更原样保留。
 *
 * 用「清位」而不是「翻转」：这两个动作的语义都是「关掉一个开关」，
 * 翻转会让正确性依赖调用方的前置守卫（守卫一旦被删，`stopFollowing`
 * 就会变成「打开追更」）。清位不依赖任何守卫。
 */
export function clearFavoriteFlag(flags: FollowFlags): FollowFlags {
  return { favorite: false, following: flags.following };
}

/** 关掉追更，收藏原样保留。 */
export function clearFollowingFlag(flags: FollowFlags): FollowFlags {
  return { favorite: flags.favorite, following: false };
}

/** 两个标记都为假时，这条记录没有存在意义，应当从存档里删掉。 */
export function isBlankRecord(flags: FollowFlags): boolean {
  return !flags.favorite && !flags.following;
}

/**
 * 用上游最新集数更新记录。
 * - `knownEpisodes` 取 `Math.max(旧值, 新值)`：上游偶发返回更少集数时不能把高水位降下来。
 * - `checkedAt` 只在集数真的变了（有新信息）时前进；`now < 旧 checkedAt`（时钟回拨）时保持旧值。
 * - 两个标记不在这里改。
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
