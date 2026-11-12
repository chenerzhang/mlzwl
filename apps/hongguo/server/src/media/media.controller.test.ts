import { describe, expect, it, vi } from 'vitest';
import type { Stream } from 'openhongguo';
import type { MediaCacheService } from './media-cache.service.js';
import { MediaController } from './media.controller.js';
import { MediaError } from './media.error.js';
import { PlaybackUnavailableError, type PlaybackService, type ResolvedPlayback } from './playback.service.js';
import { MediaRange } from './range.js';

/**
 * `streamUrl` 必须携带实际选中的清晰度。
 *
 * 这段用例只替换服务端内部的协作者（`PlaybackService` / `MediaCacheService`），
 * 不发任何网络请求，也不碰真实上游。
 *
 * 要锁定的行为：`?definition=540p` 进来后，返回的 `streamUrl` 与随后媒体端点的
 * `resolve()` 调用都必须带同一个档位。否则会出现「播放信息说 540p、实际播默认档」。
 */

const RESOLVED: ResolvedPlayback = {
  playback: { episode_id: 'ep1', protected: true, streams: [], duration_seconds: 90 },
  key: { key: 'd09eb1c35ad295141fccc28c84369aba', version: '1' },
  stream: { definition: '540p', protected: true, width: 540, height: 960, url: 'https://cdn.invalid/ep1.mp4' },
  urls: ['https://cdn.invalid/ep1.mp4'],
  availableDefinitions: ['360p', '540p', '720p'],
};

/** 只实现 controller 真正调用到的 Fastify reply 方法。 */
interface ReplyStub {
  status: number | undefined;
  /** 已设置的响应头，供断言用。名字不能叫 `headers`：那是 Fastify 的方法。 */
  sentHeaders: Record<string, string>;
  /** `header()` 被调用的次数。写头之后再抛错等于已经向浏览器承诺了 200。 */
  headerCalls: number;
  body: unknown;
  header: (key: string, value: string) => ReplyStub;
  headers: (value: Record<string, string>) => ReplyStub;
  code: (value: number) => ReplyStub;
  send: (value?: unknown) => Promise<void>;
}

function replyStub(): ReplyStub {
  const stub: ReplyStub = {
    status: undefined,
    sentHeaders: {},
    headerCalls: 0,
    body: undefined,
    header(key, value) {
      stub.headerCalls += 1;
      stub.sentHeaders[key] = value;
      return stub;
    },
    headers(value) {
      Object.assign(stub.sentHeaders, value);
      return stub;
    },
    code(value) {
      stub.status = value;
      return stub;
    },
    send(value) {
      stub.body = value;
      return Promise.resolve();
    },
  };
  return stub;
}

function fakePlayback(): { service: PlaybackService; resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(() => Promise.resolve(RESOLVED));
  return { service: { resolve } as unknown as PlaybackService, resolve };
}

function fakeCache(): { service: MediaCacheService; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(() => Promise.resolve({ file: '/dev/null', size: 1024 }));
  const service = {
    get,
    peek: vi.fn(() => Promise.resolve(null)),
    createStream: vi.fn(() => 'stream'),
  } as unknown as MediaCacheService;
  return { service, get };
}

const RANGES = { parse: vi.fn(() => null) } as unknown as MediaRange;
const REQUEST = { headers: {} } as never;

describe('MediaController streamUrl', () => {
  it('binds the selected definition into streamUrl', async () => {
    const playback = fakePlayback();
    const controller = new MediaController(playback.service, fakeCache().service, RANGES);

    const result = await controller.resolve('ep1', {});
    expect(result.definition).toBe('540p');
    expect(result.streamUrl).toBe('/api/media/ep1?definition=540p');
    expect(result.availableDefinitions).toEqual(['360p', '540p', '720p']);
  });

  it('forwards the requested definition to resolve()', async () => {
    const playback = fakePlayback();
    const controller = new MediaController(playback.service, fakeCache().service, RANGES);

    await controller.resolve('ep1', { definition: '720p' });
    expect(playback.resolve).toHaveBeenCalledWith('ep1', '720p');
  });

  it('omits the query when the label is not a valid definition', async () => {
    const playback = fakePlayback();
    playback.resolve.mockResolvedValue({
      ...RESOLVED,
      stream: { protected: true, url: 'https://cdn.invalid/ep1.mp4' } as Stream,
    });
    const controller = new MediaController(playback.service, fakeCache().service, RANGES);

    const result = await controller.resolve('ep1', {});
    // 上游没给 definition 时映射为 'unknown'；拼进查询串会被 schema 拒绝成 400。
    expect(result.definition).toBe('unknown');
    expect(result.streamUrl).toBe('/api/media/ep1');
  });

  it('passes the definition through the media endpoint', async () => {
    const playback = fakePlayback();
    const cache = fakeCache();
    const controller = new MediaController(playback.service, cache.service, RANGES);

    const reply = replyStub();
    await controller.stream('ep1', { definition: '540p' }, REQUEST, reply as never);

    expect(playback.resolve).toHaveBeenCalledWith('ep1', '540p');
    expect(cache.get).toHaveBeenCalledWith('ep1', RESOLVED);
    expect(reply.sentHeaders['content-type']).toBe('video/mp4');
  });

  it('passes the definition through the HEAD endpoint', async () => {
    const playback = fakePlayback();
    const controller = new MediaController(playback.service, fakeCache().service, RANGES);

    await controller.head('ep1', { definition: '540p' }, replyStub() as never);
    expect(playback.resolve).toHaveBeenCalledWith('ep1', '540p');
  });
});

describe('MediaController Range responses', () => {
  it('returns 206 with the requested content range for a valid Range header', async () => {
    const controller = new MediaController(fakePlayback().service, fakeCache().service, new MediaRange());
    const reply = replyStub();
    const request = { headers: { range: 'bytes=100-199' } } as never;

    await controller.stream('ep1', {}, request, reply as never);

    expect(reply.status).toBe(206);
    expect(reply.sentHeaders['content-range']).toBe('bytes 100-199/1024');
    expect(reply.sentHeaders['content-length']).toBe('100');
  });

  it('returns 416 with the complete size for a malformed Range header', async () => {
    const controller = new MediaController(fakePlayback().service, fakeCache().service, new MediaRange());
    const reply = replyStub();
    const request = { headers: { range: 'bytes=1-20foo' } } as never;

    await controller.stream('ep1', {}, request, reply as never);

    expect(reply.status).toBe(416);
    expect(reply.sentHeaders['content-range']).toBe('bytes */1024');
  });
});

describe('MediaController failure before writing headers', () => {
  /**
   * P0-6：下载/解密失败必须表现为**没有开始发送字节**。
   *
   * 一旦先写 200 头再流式发送，失败就只能在流中途断掉，浏览器看到的是一个
   * 开头正常的响应；Range 续传下更会拼出损坏的 MP4。所以这里断言两件事：
   * `stream()` 直接 reject，且没有任何 `reply.header` 调用。
   */
  it('rejects without writing headers when cache.get fails', async () => {
    const playback = fakePlayback();
    const cache = fakeCache();
    cache.get.mockRejectedValue(new MediaError('media_timeout', 'upstream did not respond'));
    const controller = new MediaController(playback.service, cache.service, RANGES);

    const reply = replyStub();
    await expect(controller.stream('ep1', {}, REQUEST, reply as never)).rejects.toThrow(MediaError);

    // 关键断言：一个响应头都没写，更没有 send。浏览器拿到的是错误状态码。
    expect(reply.headerCalls).toBe(0);
    expect(reply.status).toBeUndefined();
    expect(reply.sentHeaders).toEqual({});
    expect(reply.body).toBeUndefined();
  });

  it('rejects without writing headers when resolve fails with no_stream', async () => {
    const playback = fakePlayback();
    playback.resolve.mockRejectedValue(new PlaybackUnavailableError('episode has no stream URL', 'no_stream'));
    const controller = new MediaController(playback.service, fakeCache().service, RANGES);

    const reply = replyStub();
    await expect(controller.stream('ep1', {}, REQUEST, reply as never)).rejects.toMatchObject({
      code: 'no_stream',
    });
    expect(reply.headerCalls).toBe(0);
    expect(reply.sentHeaders).toEqual({});
  });

  it('keeps the playback endpoint JSON-serialisable error body', async () => {
    const playback = fakePlayback();
    playback.resolve.mockRejectedValue(new PlaybackUnavailableError('no content key', 'key_unavailable'));
    const controller = new MediaController(playback.service, fakeCache().service, RANGES);

    const error = await controller.resolve('ep1', {}).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('key_unavailable');
    // Nest 把构造参数里的对象原样作为响应体，前端据此 `JSON.parse` 取 code。
    expect((error as MediaError).getResponse()).toEqual({
      code: 'key_unavailable',
      message: 'no content key',
    });
    expect((error as MediaError).getStatus()).toBe(502);
  });
});
