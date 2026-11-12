import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransportRequest, TransportResponse } from 'openhongguo';
import { VideoModelCapture } from './video-model-capture.service.js';

function request(videoId: string): TransportRequest {
  return {
    url: 'https://example.invalid/novel/player/video_model/',
    method: 'POST',
    headers: {},
    body: Buffer.from(JSON.stringify({ video_id: videoId })),
  } as TransportRequest;
}

function response(episodeId: string, spadeA = 'secret'): TransportResponse {
  const model = {
    episode_id: episodeId,
    video_id: `video-${episodeId}`,
    video_list: [{ encrypt_info: { spade_a: spadeA } }],
    big_thumbs: [
      {
        img_num: 1,
        img_x_len: 1,
        img_y_len: 1,
        img_x_size: 10,
        img_y_size: 10,
        interval: 5,
        img_urls: ['https://example.invalid/sprite.heic'],
      },
    ],
  };
  return {
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({ data: { video_model: JSON.stringify(model) } })),
  } as TransportResponse;
}

afterEach(() => {
  vi.useRealTimers();
});

async function capture(service: VideoModelCapture, requestId: string, episodeId = requestId): Promise<void> {
  const wrapped = service.wrap(async () => response(episodeId));
  await wrapped(request(requestId));
}

describe('VideoModelCapture retention', () => {
  it('clears spadeA when the SDK key path succeeds while preserving sprite metadata', async () => {
    const service = new VideoModelCapture();
    await capture(service, 'episode-1');

    service.clearKey('episode-1');

    const value = service.take('episode-1');
    expect(value?.spadeA).toBeUndefined();
    expect(value?.sprite?.urls).toHaveLength(1);
  });

  it('removes entries after the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const service = new VideoModelCapture();
    await capture(service, 'episode-1');

    vi.advanceTimersByTime(5 * 60 * 1_000 + 1);

    expect(service.take('episode-1')).toBeUndefined();
  });

  it('removes every alias when one alias is taken', async () => {
    const service = new VideoModelCapture();
    await capture(service, 'request-id', 'response-id');

    expect(service.take('request-id')).toBeDefined();
    expect(service.take('response-id')).toBeUndefined();
  });

  it('evicts the oldest object when the maximum entry count is exceeded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const service = new VideoModelCapture();
    for (let index = 0; index <= 100; index += 1) {
      await capture(service, `episode-${index}`);
      vi.advanceTimersByTime(1);
    }

    expect(service.take('episode-0')).toBeUndefined();
    expect(service.take('episode-1')).toBeDefined();
    expect(service.take('episode-100')).toBeDefined();
  });
});
