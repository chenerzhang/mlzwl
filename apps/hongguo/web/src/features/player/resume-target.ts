/**
 * 续播目标计算（P1-10）。
 *
 * 照 Kotlin 侧 `Watching.kt` 的 `ResumePlayback.target()`：找不到当前集时回到第一集；
 * `completed` 为真时回到下一集且不超过最后一集；否则回到原位置。
 *
 * 放在 `features/player` 而不是 `features/follow`：它的输入是「分集列表 + 进度」，
 * 与追更记录无关，详情页和播放页都要用。纯函数，不碰 `window`，可直接单测。
 */

export interface ResumeTarget {
  /** 应当播放的集序号（1 起）；0 表示没有可用目标。 */
  episodeNumber: number;
  /** 该集内的起始秒数。 */
  position: number;
}

/**
 * 计算续播目标。
 * - 找不到当前集（`currentEpisodeNumber` 不在 `episodes` 里）→ 回第 1 集、位置 0。
 * - 当前集已完成（`completed` 为真）→ 下一集、位置 0；已是最后一集则留在当前集、位置 0。
 * - 否则 → 当前集、原位置。
 */
export function resumeTarget(input: {
  episodes: readonly { number: number }[];
  currentEpisodeNumber: number | undefined;
  position: number;
  completed: boolean;
}): ResumeTarget {
  const { episodes, currentEpisodeNumber, position, completed } = input;
  const first = episodes[0];
  if (first === undefined) {
    return { episodeNumber: 0, position: 0 };
  }

  const index = currentEpisodeNumber === undefined ? -1 : episodes.findIndex((e) => e.number === currentEpisodeNumber);
  const current = index === -1 ? undefined : episodes[index];
  if (current === undefined) {
    return { episodeNumber: first.number, position: 0 };
  }
  if (!completed) {
    return { episodeNumber: current.number, position: Number.isFinite(position) && position > 0 ? position : 0 };
  }

  // 已看完：下一集；最后一集看完就停在最后一集的开头，不回第一集重播。
  const next = episodes[index + 1] ?? current;
  return { episodeNumber: next.number, position: 0 };
}
