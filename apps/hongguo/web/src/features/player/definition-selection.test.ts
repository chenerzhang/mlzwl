import { describe, expect, it } from 'vitest';
import {
  chooseDefinition,
  isSwitchStateForEpisode,
  normalizeDefinitions,
  readDefinitions,
  resumeTimeAfterSwitch,
  shouldRequestBeforePlayback,
  shouldShowDefinitionPicker,
} from './definition-selection.js';

describe('normalizeDefinitions', () => {
  it('keeps server order because it is low-to-high', () => {
    // 顺序就是服务端给的低→高；重排会让「默认档」不再是列表里的某一项。
    expect(normalizeDefinitions(['360p', '540p', '720p', '1080p'])).toEqual(['360p', '540p', '720p', '1080p']);
  });

  it('drops non-strings, blank labels and control characters', () => {
    expect(normalizeDefinitions(['720p', 42, null, undefined, '', '   ', '72\u00000p', {}, ['1080p']])).toEqual([
      '720p',
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDefinitions([' 720p ', '\t1080p\n'])).toEqual(['720p', '1080p']);
  });

  it('deduplicates while preserving the first occurrence order', () => {
    expect(normalizeDefinitions(['720p', '1080p', '720p'])).toEqual(['720p', '1080p']);
  });

  it('drops the unknown placeholder because the server rejects it as a query value', () => {
    // `unknown` 是服务端在「上游没给档位标签」时填的占位值。它只能作为当前状态
    // 展示，不能成为可点选项：`PlaybackQuerySchema` 只接受 `\d{3,4}p`，
    // 选它会稳定 400。这里断言它被过滤掉。
    expect(normalizeDefinitions(['unknown'])).toEqual([]);
    // 与真实档位混在一起时，只保留能请求的那一档。
    expect(normalizeDefinitions(['unknown', '720p', '1080p'])).toEqual(['720p', '1080p']);
  });

  it('drops labels the server would reject even though they look like qualities', () => {
    // `2k` / `4k` 是注释里提过的「未来可能出现的标签」。在服务端契约扩展之前，
    // 它们同样是不可请求的，不能出现在菜单里。
    expect(normalizeDefinitions(['2k', '4k', '1080p'])).toEqual(['1080p']);
  });

  it('returns an empty array for undefined input', () => {
    expect(normalizeDefinitions(undefined)).toEqual([]);
  });

  it('rejects labels longer than 32 characters', () => {
    // 超长标签本来也不满足 `\d{3,4}p`，这里验证长度护栏本身仍然生效。
    expect(normalizeDefinitions(['a'.repeat(33)])).toEqual([]);
    expect(normalizeDefinitions(['1'.repeat(32)])).toEqual([]);
  });
});

describe('shouldShowDefinitionPicker', () => {
  it('shows only when there is more than one choice', () => {
    expect(shouldShowDefinitionPicker([])).toBe(false);
    expect(shouldShowDefinitionPicker(['720p'])).toBe(false);
    expect(shouldShowDefinitionPicker(['720p', '1080p'])).toBe(true);
  });
});

describe('chooseDefinition', () => {
  const available = ['360p', '540p', '720p', '1080p'];

  it('uses the remembered definition when it exists', () => {
    expect(chooseDefinition('1080p', available, '540p')).toEqual({ requested: '1080p', fellBack: false });
  });

  it('falls back to the server current definition when the remembered one is gone', () => {
    // 换了一部剧，旧档位不存在。直接发给服务端会 400，或静默返回别的档。
    expect(chooseDefinition('4k', available, '540p')).toEqual({ requested: '540p', fellBack: true });
  });

  it('falls back to auto when neither the remembered nor the current one exists', () => {
    expect(chooseDefinition('4k', ['720p'], '4k')).toEqual({ requested: undefined, fellBack: true });
  });

  it('does not report a fallback when nothing was remembered', () => {
    expect(chooseDefinition(undefined, available, '720p')).toEqual({ requested: '720p', fellBack: false });
  });

  it('defers to the server when the available list is empty', () => {
    expect(chooseDefinition(undefined, [], undefined)).toEqual({ requested: undefined, fellBack: false });
    expect(chooseDefinition('720p', [], undefined)).toEqual({ requested: undefined, fellBack: true });
  });
});

describe('resumeTimeAfterSwitch', () => {
  it('keeps the position when switching mid-episode', () => {
    expect(resumeTimeAfterSwitch(42.5, 600)).toBe(42.5);
  });

  it('returns undefined at the very start', () => {
    expect(resumeTimeAfterSwitch(0, 600)).toBeUndefined();
    expect(resumeTimeAfterSwitch(-1, 600)).toBeUndefined();
  });

  it('restarts from the beginning when the episode already ended', () => {
    // 换档后停在片尾什么也看不到。
    expect(resumeTimeAfterSwitch(600, 600)).toBeUndefined();
    expect(resumeTimeAfterSwitch(601, 600)).toBeUndefined();
  });

  it('returns undefined for non-finite input instead of NaN', () => {
    expect(resumeTimeAfterSwitch(Number.NaN, 600)).toBeUndefined();
    expect(resumeTimeAfterSwitch(42, Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('readDefinitions', () => {
  it('reports the current definition when it is available', () => {
    expect(readDefinitions({ definition: '720p', availableDefinitions: ['540p', '720p'] })).toEqual({
      current: '720p',
      available: ['540p', '720p'],
    });
  });

  it('hides a current definition that is not in the available list', () => {
    // 否则 UI 会显示一个选不中的档位。
    expect(readDefinitions({ definition: '4k', availableDefinitions: ['540p', '720p'] })).toEqual({
      current: undefined,
      available: ['540p', '720p'],
    });
  });

  it('normalizes the available list', () => {
    // 42 是模拟服务端脏数据，类型上不可能，运行时必须被丢掉。
    const dirty = ['720p', '720p', 42] as unknown as string[];
    expect(readDefinitions({ definition: ' 720p ', availableDefinitions: dirty })).toEqual({
      current: '720p',
      available: ['720p'],
    });
  });

  it('handles an empty available list', () => {
    expect(readDefinitions({ definition: '720p', availableDefinitions: [] })).toEqual({
      current: undefined,
      available: [],
    });
  });
});

describe('isSwitchStateForEpisode', () => {
  it('applies a switch state that belongs to the current episode', () => {
    expect(isSwitchStateForEpisode({ episodeId: 'ep-1', time: 50 }, 'ep-1')).toBe(true);
  });

  it('ignores a switch state left over from another episode', () => {
    // 换集那一帧旧 state 还在，必须判为无效，否则会用上一集的进度。
    expect(isSwitchStateForEpisode({ episodeId: 'ep-1', time: 50 }, 'ep-2')).toBe(false);
  });

  it('treats a null state as no switch in progress', () => {
    expect(isSwitchStateForEpisode(null, 'ep-1')).toBe(false);
    expect(isSwitchStateForEpisode(undefined, 'ep-1')).toBe(false);
  });

  it('never matches when the current episode is unknown', () => {
    expect(isSwitchStateForEpisode({ episodeId: 'ep-1', time: 50 }, undefined)).toBe(false);
    expect(isSwitchStateForEpisode({ episodeId: '', time: 50 }, '')).toBe(false);
  });

  it('does not revive a stale value after the user returns to the same episode', () => {
    // 场景：A 集在 50 秒切档 → 继续看到 120 秒 → 去 B 集 → 回到 A 集。
    // 路由在换集时清空状态，所以回来时读到的是 `null`；即使旧对象还在，
    // 也必须靠「清空」这一层拦住，这里断言清空后的行为。
    const cleared = null;
    expect(isSwitchStateForEpisode(cleared, 'ep-A')).toBe(false);
  });
});

describe('shouldRequestBeforePlayback', () => {
  it('defers when the current definition is unknown but the preference is usable', () => {
    // `current` 缺失时也必须拦：这是「默认档响应刚回来、还不知道服务端给了哪一档」
    // 的场景，放行就等于先把默认档整集拉下来。加 `current !== undefined` 前置条件
    // 会让首轮拦截整体失效。
    expect(shouldRequestBeforePlayback('1080p', ['720p', '1080p'], undefined, false)).toBe(true);
  });

  const available = ['360p', '720p', '1080p'];

  it('defers playback when the remembered definition differs from the server default', () => {
    // 记住 1080p、服务端默认 720p：必须先补一次请求，否则会先整集下载 720p。
    expect(shouldRequestBeforePlayback('1080p', available, '720p', false)).toBe(true);
  });

  it('mounts immediately when the remembered definition is already the current one', () => {
    expect(shouldRequestBeforePlayback('720p', available, '720p', false)).toBe(false);
  });

  it('mounts immediately when a definition was already requested', () => {
    // 用户手动切过档，`playback` 已经是目标档，不能再拦一次。
    expect(shouldRequestBeforePlayback('1080p', available, '720p', true)).toBe(false);
  });

  it('mounts immediately when there is no usable preference', () => {
    expect(shouldRequestBeforePlayback(undefined, available, '720p', false)).toBe(false);
    // 记住的档不在本集可用列表里：`chooseDefinition` 会退回当前档，不需要二次请求。
    expect(shouldRequestBeforePlayback('4k', available, '720p', false)).toBe(false);
    // 可用列表为空时交给服务端自动挑，不猜。
    expect(shouldRequestBeforePlayback('1080p', [], undefined, false)).toBe(false);
  });
});
