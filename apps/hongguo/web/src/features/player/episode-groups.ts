/** 一组相邻的集。`start` / `end` 是 1 起的序号，与 `items` 的首尾对应。 */
export interface EpisodeGroup<T> {
  start: number;
  end: number;
  items: readonly T[];
}

/** 超过这个集数才分组。低于它一次性渲染更简单，用户也不用多点一次展开。 */
const DEFAULT_THRESHOLD = 40;
const DEFAULT_GROUP_SIZE = 20;

/**
 * 按每 `groupSize` 集分组；总数不超过 `threshold` 时返回单组。
 *
 * `start` / `end` 用 1 起的**序号**而不是 `episode.number`：集号可能因为上游缺失
 * 而不连续（缺集时 `number` 会跳），按序号分组才能保证每组渲染出固定数量的按钮。
 * 需要显示真实集号的地方直接用 `items` 的首尾。
 */
export function groupEpisodes<T>(
  items: readonly T[],
  options?: { groupSize?: number; threshold?: number },
): EpisodeGroup<T>[] {
  const groupSize = Math.max(1, Math.floor(options?.groupSize ?? DEFAULT_GROUP_SIZE));
  const threshold = Math.max(1, Math.floor(options?.threshold ?? DEFAULT_THRESHOLD));
  if (items.length <= threshold) {
    return items.length === 0 ? [] : [{ start: 1, end: items.length, items }];
  }
  const groups: EpisodeGroup<T>[] = [];
  for (let offset = 0; offset < items.length; offset += groupSize) {
    const slice = items.slice(offset, offset + groupSize);
    groups.push({ start: offset + 1, end: offset + slice.length, items: slice });
  }
  return groups;
}

/**
 * 校验「跳转到第 N 集」的输入。返回错误文案，合法时返回 `null`。
 *
 * 非法输入**不自动纠正**：把 105 clamp 成 104 会让用户以为跳到了自己输入的那一集，
 * 而实际位置并不是他要找的。明确提示范围，让用户自己改。
 */
export function validateEpisodeJump(input: string, total: number): string | null {
  const trimmed = input.trim();
  if (trimmed === '') {
    return '请输入集数';
  }
  if (!/^-?\d+$/.test(trimmed)) {
    return `请输入 1 到 ${total} 之间的整数`;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > total) {
    return `请输入 1 到 ${total} 之间的整数`;
  }
  return null;
}

/** 找出包含第 `episode`（1 起序号）集的分组下标；找不到返回 -1。 */
export function groupIndexOf(groups: readonly EpisodeGroup<unknown>[], episode: number): number {
  return groups.findIndex((group) => episode >= group.start && episode <= group.end);
}
