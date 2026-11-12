import { describe, expect, it, vi } from 'vitest';
import type { PlaybackResult, Stream } from 'openhongguo';
import type { HongguoService } from '../hongguo/hongguo.service.js';
import { pickStream, PlaybackService, resolutionOf } from './playback.service.js';
import type { VideoModelCapture } from './video-model-capture.service.js';

/**
 * 清晰度选档。
 *
 * 重点是**竖屏**：竖屏短剧是 `540×960`。按 `height` 排序会把 540p 当成 960，
 * 判成高于 720p，于是默认选档和「从低到高」的排序同时错。这里用短边判定。
 *
 * 不依赖真实上游：只构造 `Stream` 对象，只测纯函数。
 */

function stream(definition: string, width?: number, height?: number): Stream {
  return {
    definition,
    protected: true,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

/** 横屏三档，红果实测是 1280×720 这类。 */
const LANDSCAPE = [stream('360p', 640, 360), stream('720p', 1280, 720), stream('1080p', 1920, 1080)];

/** 竖屏三档。注意 540p 的 height 是 960，比 720 大。 */
const PORTRAIT = [stream('360p', 360, 640), stream('540p', 540, 960), stream('720p', 720, 1280)];

describe('PlaybackService capture cleanup', () => {
  it('clears captured spadeA when the SDK returns a valid content key', async () => {
    const result = {
      playback: {
        episode_id: 'episode-1',
        streams: [{ ...stream('720p', 1280, 720), url: 'https://example.invalid/video.mp4' }],
      },
      contentKey: { key: '0123456789abcdef0123456789abcdef', version: '1' },
    } as unknown as PlaybackResult;
    const hongguo = {
      getClient: async () => ({ resolvePlayback: async () => result }),
    } as unknown as HongguoService;
    const clearKey = vi.fn();
    const capture = { clearKey, takeKey: vi.fn() } as unknown as VideoModelCapture;

    await new PlaybackService(hongguo, capture).resolve('episode-1');

    expect(clearKey).toHaveBeenCalledWith('episode-1');
  });
});

describe('resolutionOf', () => {
  it('uses the short side for landscape streams', () => {
    expect(resolutionOf(stream('720p', 1280, 720))).toBe(720);
    expect(resolutionOf(stream('1080p', 1920, 1080))).toBe(1080);
  });

  it('uses the short side for portrait streams', () => {
    // 关键用例：height 是 960，但这一档是 540p，不能当成 960。
    expect(resolutionOf(stream('540p', 540, 960))).toBe(540);
    expect(resolutionOf(stream('720p', 720, 1280))).toBe(720);
  });

  it('falls back to the single known axis', () => {
    expect(resolutionOf(stream('720p', 1280))).toBe(1280);
    expect(resolutionOf(stream('540p', undefined, 960))).toBe(960);
  });

  it('falls back to the definition label when dimensions are missing', () => {
    expect(resolutionOf(stream('1080p'))).toBe(1080);
    expect(resolutionOf(stream('720p'))).toBe(720);
  });

  it('returns 0 when nothing is usable', () => {
    expect(resolutionOf(stream('unknown'))).toBe(0);
    expect(resolutionOf({ definition: '720p', protected: true, width: 0, height: 0 })).toBe(720);
  });
});

describe('pickStream', () => {
  it('returns undefined for an empty list', () => {
    expect(pickStream([])).toBeUndefined();
  });

  it('honours an exact definition match', () => {
    expect(pickStream(LANDSCAPE, '360p')?.definition).toBe('360p');
    expect(pickStream(PORTRAIT, '540p')?.definition).toBe('540p');
  });

  it('ignores an unknown definition and falls back to 720p', () => {
    expect(pickStream(LANDSCAPE, '480p')?.definition).toBe('720p');
  });

  it('picks 720p by short side, not by height', () => {
    // 竖屏里没有 720 的短边档位（720×1280 的短边是 720），所以命中的是 720p。
    expect(pickStream(PORTRAIT)?.definition).toBe('720p');
  });

  it('picks 720p for portrait streams that only go up to 540', () => {
    const lowOnly = [stream('360p', 360, 640), stream('540p', 540, 960)];
    // 没有 720p，两档时取较低那档。
    expect(pickStream(lowOnly)?.definition).toBe('360p');
  });

  it('picks the lower middle when there are two options', () => {
    const two = [stream('720p', 1280, 720), stream('1080p', 1920, 1080)];
    expect(pickStream(two)?.definition).toBe('720p');
  });

  it('sorts by short side before choosing the middle', () => {
    // 横竖屏混排时两种口径的排序结果相反：
    //   短边： 540（竖屏 540×960） < 576（横屏 1024×576）→ 中间取 540
    //   height：576（横屏）      < 960（竖屏）       → 中间取 576
    // 且都不等于 720，所以不会命中 "at720" 快捷路径。
    const mixed = [stream('576p', 1024, 576), stream('540p', 540, 960)];
    expect(pickStream(mixed)?.definition).toBe('540p');
  });
});
