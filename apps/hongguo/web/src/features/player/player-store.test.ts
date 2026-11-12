import { describe, expect, it } from 'vitest';
import { applyVolumePreference, sanitizePlayerPreferences, SPEED_VALUES, usePlayerStore } from './player-store';

/**
 * 播放偏好校验的纯逻辑测试（P1-11）。
 *
 * 不引入 jsdom：`player-store.ts` 的 import 期只在 `typeof window !== 'undefined'`
 * 时才注册 `pagehide`，node 环境下不碰任何全局对象。
 */

describe('applyVolumePreference', () => {
  it('omits the volume override when the platform makes video.volume read-only', () => {
    expect(applyVolumePreference({ volume: 0.4, muted: false }, false)).toEqual({ muted: false });
  });

  it('maps muted preference to the control state', () => {
    expect(applyVolumePreference({ volume: 0.4, muted: true }, true)).toEqual({ volume: 0.4, muted: true });
  });

  it('clamps volume into the media element range', () => {
    expect(applyVolumePreference({ volume: -1, muted: false }, true)).toEqual({ volume: 0, muted: true });
    expect(applyVolumePreference({ volume: 2, muted: false }, true)).toEqual({ volume: 1, muted: false });
  });
});

describe('sanitizePlayerPreferences', () => {
  it('keeps every whitelisted speed', () => {
    for (const speed of SPEED_VALUES) {
      expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed }).speed).toBe(speed);
    }
  });

  it('rejects a non-numeric speed', () => {
    expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 'abc' }).speed).toBe(1);
  });

  it('rejects a speed that is only almost whitelisted', () => {
    // 严格比对，不容忍浮点漂移：1.0001 不是 1，不能直接喂给 playbackRate。
    expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1.0001 }).speed).toBe(1);
    expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1.1 }).speed).toBe(1);
  });

  it('accepts 0.75 exactly', () => {
    expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 0.75 }).speed).toBe(0.75);
  });

  it('clamps out-of-range and non-finite volumes to 1', () => {
    for (const volume of [2, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(sanitizePlayerPreferences({ volume, muted: false, speed: 1 }).volume).toBe(1);
    }
  });

  it('keeps an in-range volume', () => {
    expect(sanitizePlayerPreferences({ volume: 0, muted: false, speed: 1 }).volume).toBe(0);
    expect(sanitizePlayerPreferences({ volume: 0.35, muted: false, speed: 1 }).volume).toBe(0.35);
  });

  it('rejects a non-boolean muted flag', () => {
    expect(sanitizePlayerPreferences({ volume: 1, muted: 'yes', speed: 1 }).muted).toBe(false);
    expect(sanitizePlayerPreferences({ volume: 1, muted: 1, speed: 1 }).muted).toBe(false);
  });

  it('keeps a boolean muted flag', () => {
    expect(sanitizePlayerPreferences({ volume: 1, muted: true, speed: 1 }).muted).toBe(true);
  });

  it('falls back to defaults for non-object input', () => {
    const defaults = { volume: 1, muted: false, speed: 1 };
    expect(sanitizePlayerPreferences(null)).toEqual(defaults);
    expect(sanitizePlayerPreferences(undefined)).toEqual(defaults);
    expect(sanitizePlayerPreferences([1, false, 2])).toEqual(defaults);
    expect(sanitizePlayerPreferences('speed=2')).toEqual(defaults);
    expect(sanitizePlayerPreferences(42)).toEqual(defaults);
  });

  it('keeps the valid fields when only some are broken', () => {
    // 逐字段校验：坏掉的 speed 回默认，合法的 volume / muted 必须保留。
    expect(sanitizePlayerPreferences({ volume: 0.5, muted: true, speed: 'abc' })).toEqual({
      volume: 0.5,
      muted: true,
      speed: 1,
    });
  });

  it('fills in missing fields without dropping the present ones', () => {
    expect(sanitizePlayerPreferences({ volume: 0.2 })).toEqual({ volume: 0.2, muted: false, speed: 1 });
    expect(sanitizePlayerPreferences({ speed: 2 })).toEqual({ volume: 1, muted: false, speed: 2 });
    expect(sanitizePlayerPreferences({})).toEqual({ volume: 1, muted: false, speed: 1 });
  });

  it('does not leak the default object to callers', () => {
    const first = sanitizePlayerPreferences(null);
    first.volume = 0.1;
    expect(sanitizePlayerPreferences(null).volume).toBe(1);
  });
});

describe('usePlayerStore', () => {
  it('starts from the defaults', () => {
    expect(usePlayerStore.getState().volume).toBe(1);
    expect(usePlayerStore.getState().muted).toBe(false);
    expect(usePlayerStore.getState().speed).toBe(1);
  });

  it('ignores an invalid volume or speed instead of writing it', () => {
    const before = usePlayerStore.getState();

    before.setVolume(2);
    before.setVolume(Number.NaN);
    before.setSpeed(1.0001);
    before.setSpeed(3);

    expect(usePlayerStore.getState().volume).toBe(before.volume);
    expect(usePlayerStore.getState().speed).toBe(before.speed);
  });

  it('writes valid values', () => {
    usePlayerStore.getState().setVolume(0.4);
    usePlayerStore.getState().setSpeed(1.5);
    usePlayerStore.getState().setMuted(true);

    expect(usePlayerStore.getState().volume).toBe(0.4);
    expect(usePlayerStore.getState().speed).toBe(1.5);
    expect(usePlayerStore.getState().muted).toBe(true);
  });
});

/**
 * 清晰度偏好的落盘与清洗。
 *
 * 档位来自上游，随时可能变；存档里出现脏值时必须回落到「自动」，
 * 不能把一个不存在的档位发给服务端（那会 400 或静默返回别的档）。
 */
describe('definition preference', () => {
  it('keeps a valid definition across sanitize', () => {
    expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1, definition: '1080p' }).definition).toBe(
      '1080p',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1, definition: ' 720p ' }).definition).toBe(
      '720p',
    );
  });

  it('drops non-strings, blanks, control characters and over-long labels', () => {
    for (const definition of [42, null, '', '   ', 'a\u0000b', 'a'.repeat(33), {}, ['1080p']]) {
      expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1, definition }).definition).toBeUndefined();
    }
  });

  it('omits the key entirely when absent so the object stays minimal', () => {
    // `exactOptionalPropertyTypes` 下 `definition: undefined` 不是合法形态，
    // 必须是「键不存在」。
    expect('definition' in sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1 })).toBe(false);
  });

  it('setDefinition stores a valid label and can clear it back to auto', () => {
    usePlayerStore.getState().setDefinition('540p');
    expect(usePlayerStore.getState().definition).toBe('540p');

    // 传 undefined 表示「回到自动」，必须能真的删掉键。
    usePlayerStore.getState().setDefinition(undefined);
    expect('definition' in usePlayerStore.getState()).toBe(false);
  });

  it('setDefinition rejects an invalid label but still clears', () => {
    usePlayerStore.getState().setDefinition('720p');
    usePlayerStore.getState().setDefinition('');
    expect('definition' in usePlayerStore.getState()).toBe(false);
  });
});

/**
 * 下载档位偏好与播放档位偏好必须彼此独立。
 *
 * 用户常见诉求是「在线看低档省流量、下载留最高档」，两者共用一个字段会让这个
 * 组合无法表达。
 */
describe('download definition preference', () => {
  it('persists separately from the playback definition', () => {
    usePlayerStore.getState().setDefinition('480p');
    usePlayerStore.getState().setDownloadDefinition('1080p');

    expect(usePlayerStore.getState().definition).toBe('480p');
    expect(usePlayerStore.getState().downloadDefinition).toBe('1080p');
  });

  it('sanitizes the download label the same way as the playback one', () => {
    expect(sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1, downloadDefinition: ' 720p ' })).toEqual({
      volume: 1,
      muted: false,
      speed: 1,
      downloadDefinition: '720p',
    });
    expect(
      'downloadDefinition' in
        sanitizePlayerPreferences({ volume: 1, muted: false, speed: 1, downloadDefinition: 'a\u0000b' }),
    ).toBe(false);
  });

  it('can clear the download choice back to "highest available"', () => {
    usePlayerStore.getState().setDownloadDefinition('720p');
    expect(usePlayerStore.getState().downloadDefinition).toBe('720p');

    usePlayerStore.getState().setDownloadDefinition(undefined);
    expect('downloadDefinition' in usePlayerStore.getState()).toBe(false);
  });
});
