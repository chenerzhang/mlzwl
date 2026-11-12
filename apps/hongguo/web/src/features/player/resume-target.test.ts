import { describe, expect, it } from 'vitest';
import { resumeTarget } from './resume-target';

/**
 * 续播目标测试（P1-10）。
 *
 * 用例照 Kotlin 侧 `Watching.kt` 的 `ResumePlayback.target()` 写：找不到当前集回
 * 第一集；已完成回下一集；最后一集已完成留在原地位置 0；未完成回原位置。
 */

const episodes = [{ number: 1 }, { number: 2 }, { number: 3 }];

describe('resumeTarget', () => {
  it('falls back to the first episode when the current one is unknown', () => {
    expect(resumeTarget({ episodes, currentEpisodeNumber: undefined, position: 42, completed: false })).toEqual({
      episodeNumber: 1,
      position: 0,
    });
    expect(resumeTarget({ episodes, currentEpisodeNumber: 99, position: 42, completed: false })).toEqual({
      episodeNumber: 1,
      position: 0,
    });
  });

  it('returns no target when the episode list is empty', () => {
    expect(resumeTarget({ episodes: [], currentEpisodeNumber: 1, position: 42, completed: false })).toEqual({
      episodeNumber: 0,
      position: 0,
    });
  });

  it('keeps the position when the episode is unfinished', () => {
    expect(resumeTarget({ episodes, currentEpisodeNumber: 2, position: 42, completed: false })).toEqual({
      episodeNumber: 2,
      position: 42,
    });
  });

  it('moves to the next episode from zero when the current one is completed', () => {
    expect(resumeTarget({ episodes, currentEpisodeNumber: 1, position: 100, completed: true })).toEqual({
      episodeNumber: 2,
      position: 0,
    });
  });

  it('stays on the last episode at zero when it is completed', () => {
    expect(resumeTarget({ episodes, currentEpisodeNumber: 3, position: 100, completed: true })).toEqual({
      episodeNumber: 3,
      position: 0,
    });
  });

  it('clamps a non-finite or negative position to zero', () => {
    expect(resumeTarget({ episodes, currentEpisodeNumber: 2, position: Number.NaN, completed: false })).toEqual({
      episodeNumber: 2,
      position: 0,
    });
    expect(resumeTarget({ episodes, currentEpisodeNumber: 2, position: -5, completed: false })).toEqual({
      episodeNumber: 2,
      position: 0,
    });
  });
});
