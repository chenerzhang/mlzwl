/**
 * 「随机看一部」的纯逻辑（P2-5）。
 *
 * 本模块**不 import 任何 Nest 或上游 SDK 符号**：候选过滤与随机取样都是纯函数，
 * 单测不需要起容器、不需要网络，也不需要构造 SDK 的完整类型。上游的
 * `RankItem` 只在这里用本地最小结构描述，字段名与上游保持一致（snake_case），
 * 这样调用方可以直接把 `ranking.items` 传进来。
 */

/** 榜单一行里随机入口关心的字段。字段名与上游 `RankItem` 一致。 */
export interface RankRow {
  series_id?: string | undefined;
  title?: string | undefined;
  cover_url?: string | undefined;
  episode_count?: number | undefined;
}

/** 过滤后的随机候选。 */
export interface RankCandidate {
  seriesId: string;
  title: string;
  /** 上游封面地址（尚未代理）；缺省时整个键都不存在。 */
  coverUrl?: string;
  episodeCount?: number;
}

/**
 * 从数组里随机取一项。
 *
 * `random` 可注入，测试用固定返回值验证边界。**索引必须 clamp**：注入的
 * `random()` 可能返回 1（`Math.random()` 理论上不会，但注入实现会），
 * `items[Math.floor(1 * n)]` 会越界拿到 `undefined`，`-0.1` 则会算出 `-1`
 * 并拿到 `undefined`——两者都会让「随机」偶发失败。非有限值（`NaN`）同样
 * 回落到第一项，而不是返回 `undefined`。
 */
export function pickRandom<T>(items: readonly T[], random: () => number = Math.random): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const scaled = Math.floor(random() * items.length);
  const index = Number.isFinite(scaled) ? Math.min(Math.max(scaled, 0), items.length - 1) : 0;
  return items[index];
}

/**
 * 把排行榜行过滤成随机候选。
 *
 * 四条规则，与 `offline-catalog` 的严格策略保持一致：
 *
 * 1. **缺 `series_id` 就丢弃**。榜单里的演员行只有 `user_id` 没有 `series_id`，
 *    不过滤会让随机入口跳到 `/series/undefined`。
 * 2. **缺标题或标题全是空白就丢弃**。空白标题渲染出来是一张没有文字的卡。
 * 3. **`episode_count` 存在但不是非负整数就丢弃整条**。上游偶尔给 `-1` 之类的
 *    哨兵值，把它当成集数展示是错的；宁可少一条候选。
 * 4. **按 `series_id` 去重，保留首次出现**。推广行会重复同一部剧。
 *
 * 先校验后去重：这样「第一条同 id 的行不合法、第二条合法」时仍能留下合法那条。
 * 标题按上游原样保留（只用于校验时 `trim()`），不做裁剪改写。
 *
 * **字段类型也要校验**，不能只判 `undefined`：上游是松散 JSON，类型声明写
 * `series_id?: string` 不代表线上真的给字符串。给数字时 `.trim()` 会抛
 * `TypeError`，整个 `/api/random` 变成 500——而这只是一个候选行不合格。
 */
export function toRandomCandidates(rows: readonly RankRow[]): RankCandidate[] {
  const seen = new Set<string>();
  const candidates: RankCandidate[] = [];
  for (const row of rows) {
    const seriesId = row.series_id;
    if (typeof seriesId !== 'string' || seriesId.trim() === '') {
      continue;
    }
    const title = row.title;
    if (typeof title !== 'string' || title.trim() === '') {
      continue;
    }
    const episodeCount = row.episode_count;
    if (episodeCount !== undefined && (!Number.isInteger(episodeCount) || episodeCount < 0)) {
      continue;
    }
    if (seen.has(seriesId)) {
      continue;
    }
    seen.add(seriesId);
    // `cover_url` 不是字符串时整个键丢掉，而不是转成字符串：`proxyUrl` 会把它封成
    // 令牌，数字会被静默封成一个必定 404 的封面地址。
    const coverUrl = typeof row.cover_url === 'string' ? row.cover_url : undefined;
    candidates.push({
      seriesId,
      title,
      // `exactOptionalPropertyTypes` 下不能写 `coverUrl: undefined`：可选字段必须
      // 在缺失时整个键都不出现，否则与 `coverUrl?: string` 不兼容。
      ...(coverUrl === undefined ? {} : { coverUrl }),
      ...(episodeCount === undefined ? {} : { episodeCount }),
    });
  }
  return candidates;
}
