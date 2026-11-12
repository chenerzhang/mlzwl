import { describe, expect, it } from 'vitest';
import { pickPrefetchTarget, prefetchMedia } from './prefetch-next';

/**
 * 下一集预热请求器的测试。
 *
 * 不引入 jsdom：`fetch` 由参数注入，被测模块 import 期不访问 `window`。
 * 预热是纯优化，所以每个失败路径都断言「返回 false 且不抛」。
 */

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** 记录调用并返回指定响应的假 fetch。`body` 用于验证响应体被取消。 */
function createFetch(respond: (call: Call) => Promise<Response> | Response): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('prefetchMedia', () => {
  it('returns true on a 206 partial response', async () => {
    const { impl, calls } = createFetch(() => new Response(null, { status: 206 }));
    const controller = new AbortController();
    await expect(prefetchMedia({ url: '/api/media/e2', signal: controller.signal, fetchImpl: impl })).resolves.toBe(
      true,
    );
    expect(calls).toHaveLength(1);
  });

  it('returns false on a 500 without throwing', async () => {
    const { impl } = createFetch(() => new Response(null, { status: 500 }));
    const controller = new AbortController();
    await expect(prefetchMedia({ url: '/api/media/e2', signal: controller.signal, fetchImpl: impl })).resolves.toBe(
      false,
    );
  });

  it('returns false when fetch rejects, including abort', async () => {
    const { impl } = createFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const controller = new AbortController();
    await expect(prefetchMedia({ url: '/api/media/e2', signal: controller.signal, fetchImpl: impl })).resolves.toBe(
      false,
    );
  });

  it('returns false when fetch throws synchronously', async () => {
    const impl = (() => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await expect(prefetchMedia({ url: '/api/media/e2', signal: controller.signal, fetchImpl: impl })).resolves.toBe(
      false,
    );
  });

  it('requests the first two bytes with a range header', async () => {
    const { impl, calls } = createFetch(() => new Response(null, { status: 206 }));
    const controller = new AbortController();
    await prefetchMedia({ url: '/api/media/e2', signal: controller.signal, fetchImpl: impl });
    expect(calls[0]?.url).toBe('/api/media/e2');
    expect(calls[0]?.init?.headers).toEqual({ range: 'bytes=0-1' });
  });

  it('passes the signal through', async () => {
    const { impl, calls } = createFetch(() => new Response(null, { status: 206 }));
    const controller = new AbortController();
    await prefetchMedia({ url: '/api/media/e2', signal: controller.signal, fetchImpl: impl });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it('cancels the response body instead of reading it', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new Uint8Array([0, 0]));
        // 不 close：响应体保持可读，`cancel()` 才会真正被调用。
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const { impl } = createFetch(() => new Response(stream, { status: 206 }));
    const controller = new AbortController();
    await expect(prefetchMedia({ url: '/api/media/e2', signal: controller.signal, fetchImpl: impl })).resolves.toBe(
      true,
    );
    expect(cancelled).toBe(true);
  });
});

describe('pickPrefetchTarget', () => {
  const base = { episodeId: 'e2', definition: '720p', streamUrl: '/api/media/e2?definition=720p' };
  const target1080 = { episodeId: 'e2', streamUrl: '/api/media/e2?definition=1080p' };

  it('never falls back to the default definition while the chosen one is still loading', () => {
    // 记住 1080p、下一集默认 720p：目标档还没到时必须不预热。
    // 若这里退回 base，服务端会先完整下载 720p，切集后再下载 1080p。
    expect(pickPrefetchTarget(base, '1080p', undefined)).toBeUndefined();
  });

  it('prefetches the chosen definition once it is available', () => {
    expect(pickPrefetchTarget(base, '1080p', target1080)).toBe(target1080);
  });

  it('prefetches the default definition when it already matches the choice', () => {
    expect(pickPrefetchTarget(base, '720p', undefined)).toBe(base);
    // 没有记住的档位时沿用默认档。
    expect(pickPrefetchTarget(base, undefined, undefined)).toBe(base);
  });

  it('does nothing before the default playback response arrives', () => {
    expect(pickPrefetchTarget(undefined, '1080p', target1080)).toBeUndefined();
  });
});
