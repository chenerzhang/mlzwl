import { describe, expect, it } from 'vitest';
import {
  describePlaybackError,
  isMediaErrorCode,
  isStalled,
  probePlaybackError,
  PROBE_FAILED,
  STALL_TIMEOUT_MS,
  toErrorState,
} from './playback-error';

/**
 * 播放错误分类与停滞判定的纯逻辑测试。
 *
 * 不引入 jsdom：被测模块 import 期不访问 `window` / `document`，`isStalled` 把
 * `hidden` / `now` 作为参数传入，而不是在内部读全局。
 */

describe('isMediaErrorCode', () => {
  it('accepts every code the server can return', () => {
    expect(isMediaErrorCode('media_timeout')).toBe(true);
    expect(isMediaErrorCode('decrypt_failed')).toBe(true);
    expect(isMediaErrorCode('not_encrypted')).toBe(true);
  });

  it('rejects unknown strings and undefined', () => {
    expect(isMediaErrorCode('media_unknown')).toBe(false);
    expect(isMediaErrorCode('')).toBe(false);
    expect(isMediaErrorCode(undefined)).toBe(false);
  });
});

describe('describePlaybackError', () => {
  it('maps a timeout to a retryable hint', () => {
    expect(describePlaybackError('media_timeout')).toEqual({ message: '上游响应超时', action: 'retry' });
  });

  it('maps an HTML risk-control page to a retryable hint', () => {
    const hint = describePlaybackError('media_not_video');
    expect(hint.message).toContain('风控');
    expect(hint.action).toBe('retry');
  });

  it('maps an oversized file to a terminal hint', () => {
    expect(describePlaybackError('media_too_large')).toEqual({ message: '视频体积超出上限', action: 'none' });
  });

  it('distinguishes 4xx from 5xx', () => {
    expect(describePlaybackError('media_upstream_4xx').message).toBe('上游拒绝了请求');
    expect(describePlaybackError('media_upstream_5xx').message).toBe('上游服务异常');
    expect(describePlaybackError('media_upstream_5xx').action).toBe('retry');
  });

  it('asks for another definition when decryption fails', () => {
    const hint = describePlaybackError('decrypt_failed');
    expect(hint.action).toBe('switch-definition');
    expect(hint.message).toContain('换一档清晰度');
  });

  it('treats a missing stream and an unsupported format as terminal', () => {
    expect(describePlaybackError('no_stream')).toEqual({ message: '该集没有可播放的地址', action: 'none' });
    expect(describePlaybackError('not_encrypted')).toEqual({
      message: '该集的加密格式不受支持',
      action: 'none',
    });
  });

  it('offers a retry when the key is temporarily unavailable', () => {
    expect(describePlaybackError('key_unavailable')).toEqual({ message: '暂时拿不到播放密钥', action: 'retry' });
  });

  it('reports a missing episode on 404 without a code', () => {
    expect(describePlaybackError(undefined, 404)).toEqual({ message: '该集不存在', action: 'none' });
  });

  it('falls back to the codec hint for unknown codes', () => {
    const hint = describePlaybackError('something_else', 500);
    expect(hint.message).toContain('HEVC');
    expect(hint.action).toBe('none');
  });

  it('prefers the code over the status', () => {
    // 服务端把 no_stream 映射成 404，但文案必须按 code 走，不能退化成「该集不存在」。
    expect(describePlaybackError('no_stream', 404).message).toBe('该集没有可播放的地址');
  });

  it('reports a probe failure as a retryable transport problem, not a codec problem', () => {
    const hint = describePlaybackError(PROBE_FAILED);
    expect(hint).toEqual({ message: '网络或服务异常，请稍后重试', action: 'retry' });
    // P0-5 的回归防线：传输层故障绝不能报成「HEVC 不兼容」。
    expect(hint.message).not.toContain('HEVC');
  });

  it('does not treat the probe sentinel as a server code', () => {
    // `probe_failed` 只活在浏览器这一层，不能混进服务端的 code 集合。
    expect(isMediaErrorCode(PROBE_FAILED)).toBe(false);
  });
});

describe('probePlaybackError', () => {
  it('returns the server code when the body carries one', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ code: 'media_timeout', message: '上游响应超时' }), {
        status: 504,
        headers: { 'content-type': 'application/json' },
      });
    expect(await probePlaybackError('/api/media/ep1', fetchImpl as typeof fetch)).toBe('media_timeout');
  });

  it('returns undefined for a successful probe', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(null, { status: 206 });
    expect(await probePlaybackError('/api/media/ep1', fetchImpl as typeof fetch)).toBeUndefined();
  });

  it('returns the sentinel when fetch itself rejects', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    };
    expect(await probePlaybackError('/api/media/ep1', fetchImpl as typeof fetch)).toBe(PROBE_FAILED);
  });

  it('returns the sentinel for a 500 with a non-JSON body', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('<html>gateway timeout</html>', { status: 500, headers: { 'content-type': 'text/html' } });
    expect(await probePlaybackError('/api/media/ep1', fetchImpl as typeof fetch)).toBe(PROBE_FAILED);
  });

  it('returns the sentinel for a 502 JSON body without a code', async () => {
    // Fastify 默认错误体长这样，没有 `code` 字段。
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ statusCode: 502, error: 'Bad Gateway' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    expect(await probePlaybackError('/api/media/ep1', fetchImpl as typeof fetch)).toBe(PROBE_FAILED);
  });

  it('keeps undefined for a 404 with a non-JSON body', async () => {
    // 4xx 不像传输层故障，保持原行为（交给 status 判断，而不是报服务异常）。
    const fetchImpl = async (): Promise<Response> =>
      new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    expect(await probePlaybackError('/api/media/ep1', fetchImpl as typeof fetch)).toBeUndefined();
  });
});

describe('isStalled', () => {
  const base = { playing: true, hidden: false, currentTime: 10, lastProgressAt: 0 };

  it('reports a stall once the window elapses', () => {
    expect(isStalled({ ...base, now: STALL_TIMEOUT_MS })).toBe(true);
    expect(isStalled({ ...base, now: STALL_TIMEOUT_MS - 1 })).toBe(false);
  });

  it('never reports a stall while paused', () => {
    expect(isStalled({ ...base, playing: false, now: STALL_TIMEOUT_MS * 2 })).toBe(false);
  });

  it('never reports a stall in a hidden tab', () => {
    // 后台标签页会被浏览器暂停解码，进度不走是正常的。
    expect(isStalled({ ...base, hidden: true, now: STALL_TIMEOUT_MS * 2 })).toBe(false);
  });

  it('honours a custom timeout', () => {
    expect(isStalled({ ...base, now: 500, timeoutMs: 500 })).toBe(true);
    expect(isStalled({ ...base, now: 499, timeoutMs: 500 })).toBe(false);
  });
});

describe('toErrorState', () => {
  it('keeps the switch-definition action when more than one definition exists', () => {
    const state = toErrorState({ message: '解密失败', action: 'switch-definition' }, true);
    expect(state).toEqual({ message: '解密失败', action: 'switch-definition' });
  });

  it('downgrades switch-definition to none when there is only one definition', () => {
    // 单档时点开一个只有一项的菜单等于骗用户点一次，必须退化成纯文案。
    const state = toErrorState({ message: '解密失败', action: 'switch-definition' }, false);
    expect(state).toEqual({ message: '解密失败', action: 'none' });
  });

  it('leaves retry untouched regardless of the definition count', () => {
    expect(toErrorState({ message: '超时', action: 'retry' }, false).action).toBe('retry');
    expect(toErrorState({ message: '超时', action: 'retry' }, true).action).toBe('retry');
  });

  it('maps a definition_unavailable error to the switch action', () => {
    // 该集没有所选档位时，换一档就能继续看，所以必须给可执行动作。
    const hint = describePlaybackError('definition_unavailable', 400);
    expect(toErrorState(hint, true).action).toBe('switch-definition');
  });
});
