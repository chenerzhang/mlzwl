/**
 * 「热度榜」上游行的纯逻辑转换。
 *
 * 本模块不 import Nest、SDK 或 mapper：松散 JSON 的过滤可以独立验证，封面代理则
 * 留在 service 的 mapper 边界统一完成，避免纯逻辑测试依赖服务容器。
 */

/** 榜单一行里接口真正关心的最小字段，字段名与上游保持一致。 */
export interface RankRow {
  position?: number | undefined;
  rank?: number | undefined;
  series_id?: string | undefined;
  title?: string | undefined;
  cover_url?: string | undefined;
  episode_count?: number | undefined;
  score?: string | undefined;
  promoted?: boolean | undefined;
}

/** 已经过严格过滤、但封面仍是上游地址的榜单行。 */
export interface RankingRow {
  position: number;
  seriesId: string;
  title: string;
  coverUrl?: string;
  episodeCount?: number;
  score?: string;
  promoted?: boolean;
}

/**
 * 把松散的上游榜单行转换成稳定的内部结构。
 *
 * 规则刻意严格，因为单条脏数据不该让整个榜单变成 500：
 *
 * 1. **只用 `position`，绝不用 `rank`**。实测热播榜的 `rank` 为
 *    `1,2,3,4,5,5,6,7,8,10,9,10`，推广行会照抄下一行名次；`position` 才是
 *    连续正确的 `1..12`、下一页 `13..22`。缺失或不是正整数的行必须丢弃。
 * 2. **缺有效 `series_id` 的行丢弃**。演员行没有剧集 ID，不能生成详情页链接。
 * 3. **缺有效标题的行丢弃**。空白标题无法形成可理解的榜单项。
 * 4. **非法集数丢弃整行**。字符串、负数和小数都不是可信的集数，不能静默修正。
 * 5. **可选字段只接受原类型**。封面、分数和推广标记如果类型错误就省略该键；强制
 *    转换会制造坏封面 URL 或错误展示文案。
 * 6. **按 `series_id` 去重并保留首次出现**。推广可能让同一部剧重复，首次出现才
 *    代表上游给出的最高顺位。
 * 7. **不按 `position` 重排**。上游数组本身就是榜单展示顺序，重排会擅自改写语义。
 *
 * 标题与 ID 仅用 `trim()` 判断有效性，返回时原样保留，避免服务端擅自改写展示文本。
 */
export function toRankingEntries(rows: readonly RankRow[]): RankingRow[] {
  const seen = new Set<string>();
  const entries: RankingRow[] = [];
  for (const row of rows) {
    const position = row.position;
    if (typeof position !== 'number' || !Number.isInteger(position) || position <= 0) {
      continue;
    }
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

    const coverUrl = typeof row.cover_url === 'string' ? row.cover_url : undefined;
    const score = typeof row.score === 'string' ? row.score : undefined;
    const promoted = typeof row.promoted === 'boolean' ? row.promoted : undefined;
    entries.push({
      position,
      seriesId,
      title,
      // `exactOptionalPropertyTypes` 要求缺失时整个键不存在，这也让响应更准确。
      ...(coverUrl === undefined ? {} : { coverUrl }),
      ...(episodeCount === undefined ? {} : { episodeCount }),
      ...(score === undefined ? {} : { score }),
      ...(promoted === undefined ? {} : { promoted }),
    });
  }
  return entries;
}

/**
 * 只在上游明确还有下一页且给出非空游标时返回游标。
 *
 * `has_more` 是分页真值来源；空游标即使配着 `true` 也无法续取，返回 `null` 可避免
 * 客户端反复请求第一页。
 */
export function pickNextCursor(hasMore: boolean, cursor: string | undefined): string | null {
  if (!hasMore || typeof cursor !== 'string' || cursor === '') {
    return null;
  }
  return cursor;
}
