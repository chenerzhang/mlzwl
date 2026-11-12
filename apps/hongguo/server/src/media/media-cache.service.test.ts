import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { downloadFromUrls, downloadWithRetry, MediaCacheService, sanitizeMediaUrl } from './media-cache.service.js';
import { MediaError } from './media.error.js';
import { streamUrls, type ResolvedPlayback } from './playback.service.js';

/**
 * 下载层的正确性证据。
 *
 * 所有网络目标都是 `127.0.0.1` 上的真实本地 HTTP 服务，**不碰真实上游**：
 * 这里要测的正是「上游行为异常时我们怎么反应」，mock 掉 fetch 就测不到
 * 读流、`content-length`、连接中断这些真实行为。
 *
 * 分两层：
 * - `downloadWithRetry` / `downloadFromUrls`：超时、重试、多地址回退。
 * - `MediaCacheService.get`：配置真的被用上（上限、超时来自 `Config`），
 *   以及写响应头之前的失败都表现为 `MediaError`。
 */

/** 上限取配置允许的最小值 1 MB，测试数据量可控。 */
const MAX_BYTES = 1_048_576;

interface TestServer {
  url: (path: string) => string;
  /** 每个路径被请求的次数，用来断言「4xx 不重试」「两个地址都试过」。 */
  hits: Map<string, number>;
  close: () => Promise<void>;
}

const openServers: TestServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const test: TestServer = {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  openServers.push(test);
  return test;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hongguo-media-'));
  tempDirs.push(dir);
  return dir;
}

/** 最小 `Config`：只填 `MediaCacheService` 真正读到的字段，不引入 Nest 测试模块。 */
function testConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    PORT: 9133,
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    MEDIA_KEEP: 4,
    COVER_KEEP_DAYS: 1,
    UPSTREAM_TIMEOUT_MS: 1_000,
    MEDIA_MAX_BYTES: MAX_BYTES,
    CORS_ORIGINS: [],
    LOG_TO_FILE: false,
    ...overrides,
  };
}

function resolved(urls: string[]): ResolvedPlayback {
  const primary = urls[0];
  return {
    playback: { episode_id: 'ep1', protected: true, streams: [], duration_seconds: 90 },
    key: { key: 'd09eb1c35ad295141fccc28c84369aba', version: '1' },
    stream: { definition: '540p', protected: true, ...(primary === undefined ? {} : { url: primary }) },
    urls,
    availableDefinitions: ['540p'],
  };
}

/** 一次网络往返很短的选项；退避压到毫秒级，测试不等真实 1000 / 2500 ms。 */
const FAST_RETRY = { retryDelaysMs: [1, 2] as const };

describe('downloadWithRetry', () => {
  it('returns the exact bytes of a normal response', async () => {
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.length) });
      res.end(Buffer.from(payload));
    });

    const bytes = await downloadWithRetry(server.url('/ok.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    });
    expect([...bytes]).toEqual([...payload]);
    expect(server.hits.get('/ok.mp4')).toBe(1);
  });

  it('rejects text/html as media_not_video without retrying', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>blocked</body></html>');
    });

    const error = await downloadWithRetry(server.url('/html.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('media_not_video');
    expect(MediaError.statusFor('media_not_video')).toBe(502);
    // 上游错误页重试也不会变成视频。
    expect(server.hits.get('/html.mp4')).toBe(1);
  });

  it('rejects application/json as media_not_video', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"code":1234,"message":"risk control"}');
    });

    const error = await downloadWithRetry(server.url('/json.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    }).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_not_video');
  });

  it('rejects a declared content-length above the limit as media_too_large', async () => {
    const server = await startServer((_req, res) => {
      // 只声明大小、不写正文：被测代码必须在读体之前就放弃。
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MAX_BYTES + 1) });
      res.end();
    });

    const error = await downloadWithRetry(server.url('/big.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    }).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_too_large');
    expect(server.hits.get('/big.mp4')).toBe(1);
  });

  it('aborts the stream when the body exceeds the limit without content-length', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const server = await startServer((_req, res) => {
      // 分块发送、不声明 content-length：只有读流时的累计检查能拦住它。
      res.writeHead(200, { 'content-type': 'video/mp4' });
      let sent = 0;
      const pump = (): void => {
        if (sent > MAX_BYTES * 2) {
          res.end();
          return;
        }
        sent += chunk.length;
        if (res.write(chunk)) {
          setImmediate(pump);
        } else {
          res.once('drain', pump);
        }
      };
      pump();
    });

    const error = await downloadWithRetry(server.url('/stream.mp4'), {
      timeoutMs: 5_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    }).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_too_large');
  });

  it('maps a silent upstream to media_timeout', async () => {
    const server = await startServer(() => {
      // 永不响应：验证 `AbortSignal.timeout` 真的挂上了。
    });

    const error = await downloadWithRetry(server.url('/hang.mp4'), {
      timeoutMs: 100,
      maxBytes: MAX_BYTES,
      retryDelaysMs: [],
    }).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_timeout');
    expect(MediaError.statusFor('media_timeout')).toBe(504);
  });

  it('maps a stall after the response headers to media_timeout', async () => {
    const server = await startServer((_req, res) => {
      // 先写响应头与 1 块字节，然后既不写也不 end：握手阶段已过，超时只能靠读流阶段识别。
      // Node 22 实测这时抛 `TimeoutError`（DOMException），但读流阶段还有其它拆连路径
      // 会抛 `TypeError: terminated`，所以识别靠 `signal.aborted` 而不是错误名。
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.write(Buffer.from([0x00, 0x00, 0x00, 0x18]));
    });

    const error = await downloadWithRetry(server.url('/stall.mp4'), {
      timeoutMs: 100,
      maxBytes: MAX_BYTES,
      retryDelaysMs: [],
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('media_timeout');
  });

  it('does not leak a signed URL through an invalid-URL fetch failure', async () => {
    // Node 对非法 URL 抛 `TypeError: Failed to parse URL from <原始 URL>`，原始
    // URL 里带签名 query。message 会作为响应体回到浏览器，所以只能保留 error.name。
    const error = await downloadWithRetry('ht tp://cdn.example.com/v1/a.mp4?signature=SECRET-A', {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      retryDelaysMs: [],
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('media_upstream_5xx');
    const message = (error as MediaError).message;
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('signature');
    expect(message).not.toContain('cdn.example.com');
  });

  it('does not retry a 404', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('gone');
    });

    const error = await downloadWithRetry(server.url('/404.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    }).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_upstream_4xx');
    expect(server.hits.get('/404.mp4')).toBe(1);
  });

  it('retries a 5xx', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('busy');
    });

    const error = await downloadWithRetry(server.url('/503.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    }).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_upstream_5xx');
    // 首次 + 2 次重试。
    expect(server.hits.get('/503.mp4')).toBe(3);
  });

  it('retries a 429 but not a 403', async () => {
    let attempt = 0;
    const server = await startServer((_req, res) => {
      attempt += 1;
      // 第一次限流，第二次给字节：证明 429 真的走了重试。
      if (attempt === 1) {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('slow down');
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.from([7, 7, 7]));
    });

    const bytes = await downloadWithRetry(server.url('/429.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    });
    expect([...bytes]).toEqual([7, 7, 7]);
    expect(server.hits.get('/429.mp4')).toBe(2);

    const forbidden = await startServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('nope');
    });
    const error = await downloadWithRetry(forbidden.url('/403.mp4'), {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    }).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_upstream_4xx');
    expect(forbidden.hits.get('/403.mp4')).toBe(1);
  });
});

describe('downloadFromUrls', () => {
  it('falls back to the backup URL when the primary returns 500', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const server = await startServer((req, res) => {
      if (req.url === '/primary.mp4') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(payload.length) });
      res.end(Buffer.from(payload));
    });

    const result = await downloadFromUrls([server.url('/primary.mp4'), server.url('/backup.mp4')], {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    });

    expect([...result.bytes]).toEqual([...payload]);
    expect(result.index).toBe(1);
    // 主地址（含重试）与备用地址都被真的请求过。
    expect(server.hits.get('/primary.mp4')).toBe(3);
    expect(server.hits.get('/backup.mp4')).toBe(1);
  });

  it('tries the backup URL only once when the primary returns 404', async () => {
    const payload = new Uint8Array([9, 9, 9]);
    const server = await startServer((req, res) => {
      if (req.url === '/primary.mp4') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('gone');
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.from(payload));
    });

    const result = await downloadFromUrls([server.url('/primary.mp4'), server.url('/backup.mp4')], {
      timeoutMs: 1_000,
      maxBytes: MAX_BYTES,
      ...FAST_RETRY,
    });
    expect(result.index).toBe(1);
    expect(server.hits.get('/primary.mp4')).toBe(1);
  });

  it('aggregates per-URL reasons without leaking query strings', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    });

    const error = await downloadFromUrls(
      [`${server.url('/a.mp4')}?signature=SECRET-A`, `${server.url('/b.mp4')}?signature=SECRET-B`],
      { timeoutMs: 1_000, maxBytes: MAX_BYTES, retryDelaysMs: [] },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    const message = (error as MediaError).message;
    expect(message).toContain('127.0.0.1');
    expect(message).toContain('/a.mp4');
    expect(message).toContain('/b.mp4');
    // 签名参数在 query 里，绝不能进日志或错误体。
    expect(message).not.toContain('SECRET');
  });

  it('keeps the signed URL out of the aggregate message when the URL itself is invalid', async () => {
    // `aggregateFailure` 会拼上每个地址的 `error.message`，而非法 URL 的 fetch
    // 错误 message 里就是整条原始地址。这条用例盯的就是这条路径。
    const error = await downloadFromUrls(
      ['ht tp://cdn.example.com/a.mp4?signature=SECRET-A', 'ht tp://cdn.example.com/b.mp4?signature=SECRET-B'],
      { timeoutMs: 1_000, maxBytes: MAX_BYTES, retryDelaysMs: [] },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MediaError);
    const message = (error as MediaError).message;
    expect(message).toContain('(invalid url)');
    expect(message).not.toContain('SECRET');
  });
});

describe('sanitizeMediaUrl', () => {
  it('keeps host and path, drops the query string', () => {
    expect(sanitizeMediaUrl('https://cdn.example.com/v1/abc.mp4?sign=SECRET&exp=1')).toBe('cdn.example.com/v1/abc.mp4');
  });

  it('masks a long path segment instead of truncating it', () => {
    const long = `https://cdn.example.com/${'x'.repeat(80)}`;
    // 超长 path 段整个替换成 `***`：签名可能放在 path 里，截断前缀仍会泄一部分。
    expect(sanitizeMediaUrl(long)).toBe('cdn.example.com/***');
  });

  it('masks a token segment but keeps the file name', () => {
    // 有些 CDN 把 token 放在 path 段：`/v1/<token>/a.mp4`。
    expect(sanitizeMediaUrl('https://cdn.example.com/v1/abcdefghijklmnop/a.mp4')).toBe('cdn.example.com/v1/***/a.mp4');
  });

  it('does not throw on a malformed URL', () => {
    expect(sanitizeMediaUrl('not a url')).toBe('(invalid url)');
  });
});

describe('streamUrls', () => {
  it('puts the backup URL after the primary', () => {
    expect(streamUrls({ protected: true, url: 'https://a/1.mp4', backup_url: 'https://b/1.mp4' })).toEqual([
      'https://a/1.mp4',
      'https://b/1.mp4',
    ]);
  });

  it('drops empty and duplicated candidates', () => {
    expect(streamUrls({ protected: true, url: 'https://a/1.mp4', backup_url: 'https://a/1.mp4' })).toEqual([
      'https://a/1.mp4',
    ]);
    expect(streamUrls({ protected: true, url: 'https://a/1.mp4', backup_url: '' })).toEqual(['https://a/1.mp4']);
    expect(streamUrls({ protected: true })).toEqual([]);
  });
});

describe('MediaCacheService', () => {
  it('uses the configured size limit before reading the body', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(MAX_BYTES + 1) });
      res.end();
    });
    const service = new MediaCacheService(testConfig(await tempDir()));

    const error = await service.get('ep1', resolved([server.url('/big.mp4')])).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('media_too_large');
  });

  it('reports an upstream HTML page as media_not_video', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>risk control</html>');
    });
    const service = new MediaCacheService(testConfig(await tempDir()));

    const error = await service.get('ep1', resolved([server.url('/html.mp4')])).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('media_not_video');
  });

  it('reports bytes that are not a valid MP4 as decrypt_failed', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.alloc(64, 0x2a));
    });
    const service = new MediaCacheService(testConfig(await tempDir()));

    const error = await service.get('ep1', resolved([server.url('/junk.mp4')])).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(MediaError);
    expect((error as MediaError).code).toBe('decrypt_failed');
    expect(MediaError.statusFor('decrypt_failed')).toBe(500);
  });

  it('tries the backup URL when the primary is unavailable', async () => {
    const server = await startServer((req, res) => {
      if (req.url === '/primary.mp4') {
        // 404 不重试，所以这条用例只花一次往返。
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('gone');
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.alloc(64, 0x2a));
    });
    const service = new MediaCacheService(testConfig(await tempDir()));

    // 备用地址的字节是垃圾，所以最终报 decrypt_failed；关键断言是**两个地址都被请求过**，
    // 即 `produce()` 真的按 `urls` 顺序回退。
    const error = await service
      .get('ep1', resolved([server.url('/primary.mp4'), server.url('/backup.mp4')]))
      .catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('decrypt_failed');
    expect(server.hits.get('/primary.mp4')).toBe(1);
    expect(server.hits.get('/backup.mp4')).toBe(1);
  });

  it('applies UPSTREAM_TIMEOUT_MS to the download', async () => {
    let attempt = 0;
    const server = await startServer((_req, res) => {
      attempt += 1;
      const reply = (): void => {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(Buffer.alloc(64, 0x2a));
      };
      // 第一次慢于超时窗口：若 `AbortSignal.timeout` 没挂上，第一次就会成功，
      // 下面 `hits === 2` 的断言会失败。
      if (attempt === 1) {
        setTimeout(reply, 1_500);
        return;
      }
      reply();
    });
    // 1000 是 schema 允许的最小值，测试不必真等 30 秒。
    const service = new MediaCacheService(testConfig(await tempDir(), { UPSTREAM_TIMEOUT_MS: 1_000 }));

    const error = await service.get('ep1', resolved([server.url('/slow.mp4')])).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('decrypt_failed');
    expect(server.hits.get('/slow.mp4')).toBe(2);
  });

  it('rejects with no_stream when there is no candidate URL', async () => {
    const service = new MediaCacheService(testConfig(await tempDir()));

    const error = await service.get('ep1', resolved([])).catch((reason: unknown) => reason);
    expect((error as MediaError).code).toBe('no_stream');
    expect(MediaError.statusFor('no_stream')).toBe(404);
  });
});
