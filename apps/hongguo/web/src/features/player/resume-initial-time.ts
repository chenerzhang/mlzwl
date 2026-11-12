/** 播放页为当前分集冻结的续播位置。 */
export interface FrozenInitialTime {
  episodeId: string;
  initialTime: number | undefined;
}

/**
 * 每集只捕获一次续播位置。
 *
 * history 会随播放进度每秒更新；同一集后续更新不能改变已经交给播放器的起点。
 * 分集变化时则从新分集的记录重新捕获，保证换集仍能正确续播。
 */
export function resolveInitialTime(
  previous: FrozenInitialTime | undefined,
  entry: { episodeId: string; position: number; completed?: boolean } | undefined,
  episodeId: string,
): FrozenInitialTime {
  if (previous?.episodeId === episodeId) {
    return previous;
  }
  const initialTime =
    entry?.episodeId === episodeId && entry.completed !== true && entry.position > 3 ? entry.position : undefined;
  return { episodeId, initialTime };
}
