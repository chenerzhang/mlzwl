import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COVER_PATH_PREFIX, MAX_COVER_TOKEN_LENGTH } from '@mlzwl/hongguo-shared/definitions';
import type { Config } from '../config/config.js';
import {
  COVER_MAX_BYTES,
  COVER_MAX_FILES,
  COVER_MAX_SOURCE_BYTES,
  CoverProxyService,
  CoverUrlRejectedError,
  isPrivateHost,
} from './cover-proxy.service.js';
import { CoverController } from './cover.controller.js';
import { CoverTokenCodec } from './cover-token.js';
import { SpriteController } from './sprite.controller.js';
import type { SpriteService } from '../media/sprite.service.js';

/**
 * 封面缓存的修剪证据。
 *
 * 不碰真实上游：`fetch` 被替换成返回固定 JPEG 字节的桩，白名单校验照常执行，
 * 所以走的是真实代码路径（命中缓存 / 写入后修剪）。
 *
 * 缓存键是 URL 的 SHA-256，测试直接按同一规则造文件名，才能分别构造「命中」与
 * 「写入」两种入口。
 */

/** 白名单域名，避免被 `isAllowed` 拒掉。 */
const CDN = 'https://p3-reading-sign.fqnovelpic.com';

/** 最小 JPEG 头，内容不重要——这里测的是缓存行为，不是解码。 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hongguo-cover-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(dataDir: string, overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    PORT: 9133,
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    MEDIA_KEEP: 4,
    COVER_KEEP_DAYS: 30,
    UPSTREAM_TIMEOUT_MS: 1_000,
    MEDIA_MAX_BYTES: 1_048_576,
    CORS_ORIGINS: [],
    LOG_TO_FILE: false,
    ...overrides,
  };
}

/** 测试用的固定密钥编解码器：不落盘，避免测试互相污染 `DATA_DIR`。 */
const testCodec = CoverTokenCodec.fromKey(Buffer.alloc(32, 7));

/** 构造带令牌编解码器的服务。 */
function makeService(config: Config): CoverProxyService {
  return new CoverProxyService(config, testCodec);
}

/** 与 `fetchJpeg` 的键规则一致：不带 `w` 时就是 URL 的 sha256。 */
function cacheFile(dir: string, url: string, width?: number): string {
  const key = `${createHash('sha256').update(url).digest('hex')}${width === undefined ? '' : `-w${width}`}`;
  return join(dir, 'covers', `${key}.jpg`);
}

/** 让 `fetch` 返回 JPEG，并记录调用次数。 */
interface ReplyStub {
  status: number | undefined;
  body: unknown;
  code: (value: number) => ReplyStub;
  header: (key: string, value: string) => ReplyStub;
  send: (value?: unknown) => Promise<void>;
}

function replyStub(): ReplyStub {
  const stub: ReplyStub = {
    status: undefined,
    body: undefined,
    code(value) {
      stub.status = value;
      return stub;
    },
    header() {
      return stub;
    },
    send(value) {
      stub.body = value;
      return Promise.resolve();
    },
  };
  return stub;
}

const SENSITIVE_MESSAGE = 'upstream https://cdn.invalid/image?sign=abc123 x-argus: abc123 spade_a=SECRET';

function expectRedacted(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('abc123');
  expect(serialized).not.toContain('SECRET');
  expect(serialized).not.toContain('spade_a=');
}

function stubFetch(): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    calls += 1;
    return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  });
  return { calls: () => calls };
}

/** 把文件 mtime 改成 `daysAgo` 天前。 */
async function setAge(file: string, daysAgo: number): Promise<void> {
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await utimes(file, when, when);
}

describe('cover and sprite controller error responses', () => {
  it('redacts unavailable cover errors while preserving status and code', async () => {
    const covers = {
      resolveToken: vi.fn(() => `${CDN}/image`),
      fetchJpeg: vi.fn(() => Promise.reject(new Error(SENSITIVE_MESSAGE))),
    } as unknown as CoverProxyService;
    const reply = replyStub();

    await new CoverController(covers).cover('token', reply as never);

    expect(reply.status).toBe(502);
    expect(reply.body).toMatchObject({ error: 'cover_unavailable' });
    expectRedacted(reply.body);
  });

  it('redacts rejected cover URLs while preserving status and code', async () => {
    const covers = {
      resolveToken: vi.fn(() => `${CDN}/image`),
      fetchJpeg: vi.fn(() => Promise.reject(new CoverUrlRejectedError(SENSITIVE_MESSAGE))),
    } as unknown as CoverProxyService;
    const reply = replyStub();

    await new CoverController(covers).cover('token', reply as never);

    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ error: 'cover_url_rejected' });
    expectRedacted(reply.body);
  });

  it('redacts unavailable sprite errors while preserving status and code', async () => {
    const sprites = {
      sheet: vi.fn(() => Promise.reject(new Error(SENSITIVE_MESSAGE))),
    } as unknown as SpriteService;
    const reply = replyStub();

    await new SpriteController(sprites).sheet('episode-1', '0', {}, reply as never);

    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject({ error: 'sprite_unavailable', sheet: 0 });
    expectRedacted(reply.body);
  });
});

describe('CoverProxyService cache hit', () => {
  it('returns the cached bytes without touching the network', async () => {
    const dir = await tempDir();
    const url = `${CDN}/a.jpg`;
    await mkdir(join(dir, 'covers'), { recursive: true });
    const file = cacheFile(dir, url);
    await writeFile(file, JPEG);
    const fetchStub = stubFetch();

    const { buffer } = await makeService(testConfig(dir)).fetchJpeg(url);

    expect(buffer.equals(JPEG)).toBe(true);
    expect(fetchStub.calls()).toBe(0);
  });

  it('touches mtime on a cache hit so the entry is not evicted', async () => {
    const dir = await tempDir();
    const url = `${CDN}/b.jpg`;
    await mkdir(join(dir, 'covers'), { recursive: true });
    const file = cacheFile(dir, url);
    await writeFile(file, JPEG);
    await setAge(file, 20);
    stubFetch();

    await makeService(testConfig(dir)).fetchJpeg(url);

    const info = await stat(file);
    expect(Date.now() - info.mtimeMs).toBeLessThan(60_000);
  });
});

describe('CoverProxyService eviction', () => {
  it('removes entries older than COVER_KEEP_DAYS after a write', async () => {
    const dir = await tempDir();
    const covers = join(dir, 'covers');
    await mkdir(covers, { recursive: true });
    const stale = join(covers, 'stale.jpg');
    const fresh = join(covers, 'fresh.jpg');
    await writeFile(stale, JPEG);
    await writeFile(fresh, JPEG);
    await setAge(stale, 40);
    await setAge(fresh, 5);
    stubFetch();

    const written = `${CDN}/new.jpg`;
    await makeService(testConfig(dir, { COVER_KEEP_DAYS: 30 })).fetchJpeg(written);

    const names = await readdir(covers);
    expect(names).not.toContain('stale.jpg');
    expect(names).toContain('fresh.jpg');
    expect(names).toContain(cacheFile(dir, written).split('/').pop());
  });

  it('keeps at most COVER_MAX_FILES entries, dropping the oldest', async () => {
    const dir = await tempDir();
    const covers = join(dir, 'covers');
    await mkdir(covers, { recursive: true });
    // 造满上限，mtime 按文件名序号递增，最旧的叫 oldest.jpg。
    for (let index = 0; index < COVER_MAX_FILES; index += 1) {
      const file = join(covers, index === 0 ? 'oldest.jpg' : `f${index}.jpg`);
      await writeFile(file, JPEG);
      await setAge(file, 10 - index / 100);
    }
    stubFetch();

    await makeService(testConfig(dir)).fetchJpeg(`${CDN}/overflow.jpg`);

    const names = await readdir(covers);
    expect(names).toHaveLength(COVER_MAX_FILES);
    expect(names).not.toContain('oldest.jpg');
    expect(names).toContain(cacheFile(dir, `${CDN}/overflow.jpg`).split('/').pop());
  });

  it('keeps total bytes under COVER_MAX_BYTES, dropping the oldest', async () => {
    const dir = await tempDir();
    const covers = join(dir, 'covers');
    await mkdir(covers, { recursive: true });
    // 三个 10 MB 的稀疏文件：总量 30 MB，超过 24 MB 上限但文件数远未到 100。
    const tenMb = 10 * 1024 * 1024;
    for (const [index, name] of ['big-oldest.jpg', 'big-middle.jpg', 'big-newest.jpg'].entries()) {
      const file = join(covers, name);
      await truncate(file, tenMb).catch(async () => {
        await writeFile(file, Buffer.alloc(tenMb));
      });
      await setAge(file, 3 - index);
    }
    stubFetch();

    await makeService(testConfig(dir)).fetchJpeg(`${CDN}/byte-cap.jpg`);

    const names = await readdir(covers);
    const sizes = await Promise.all(names.map((name) => stat(join(covers, name))));
    const total = sizes.reduce((sum, info) => sum + info.size, 0);
    expect(total).toBeLessThanOrEqual(COVER_MAX_BYTES);
    expect(names).not.toContain('big-oldest.jpg');
    expect(names).toContain('big-newest.jpg');
  });

  it('still returns the bytes when eviction itself fails', async () => {
    const dir = await tempDir();
    stubFetch();
    const service = makeService(testConfig(dir));
    // 制造一个真实的不可删文件在测试环境不可靠（root 能删任何东西），所以直接让
    // `evict` reject：测的是 `produce()` 对清理失败的处理，不是 `evict` 自身的健壮性。
    const evict = vi.spyOn(service as unknown as { evict(dir: string): Promise<void> }, 'evict');
    evict.mockRejectedValueOnce(new Error('rm failed'));

    const { buffer } = await service.fetchJpeg(`${CDN}/evict-fails.jpg`);

    // 封面已写入，清理失败不得把请求变成错误。
    expect(buffer.equals(JPEG)).toBe(true);
    expect(evict).toHaveBeenCalledTimes(1);
  });
});

/**
 * P1-22 的四条外链安全规则。
 *
 * 白名单之外的风险不在「域名对不对」，而在「域名对但请求方式被劫持」：带凭据的 URL、
 * 重定向到内网、无超时、无大小上限。四条各测一条，因为任何一条漏掉都是独立的攻击面。
 */
describe('CoverProxyService external URL safety', () => {
  it('rejects URLs carrying credentials', () => {
    const service = makeService(testConfig('/tmp/unused'));
    expect(service.isAllowed(`https://user:pass@p3-reading-sign.fqnovelpic.com/a.jpg`)).toBe(false);
    expect(service.isAllowed(`https://user@p3-reading-sign.fqnovelpic.com/a.jpg`)).toBe(false);
    expect(service.isAllowed(`${CDN}/a.jpg`)).toBe(true);
  });

  it('rejects loopback, private, link-local and reserved hosts', () => {
    // 这些主机名本来也过不了后缀白名单，所以这里**直接测 `isPrivateHost`**。
    // 用 `isAllowed` 测的话，把私网检查整段删掉测试也照样通过（白名单先挡住了），
    // 变异检验已确认过这一点。白名单是可配置的，不能把安全完全押在它上面。
    for (const host of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.1',
      '192.0.0.255',
      '198.18.0.1',
      '198.19.255.255',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      'localhost',
      'app.localhost',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of [
      '[::1]',
      '[::]',
      '[fd00::1]',
      '[fe80::1]',
      '[fc00::1]',
      '[fec0::1]',
      '[feff::1]',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[64:ff9b::7f00:1]',
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }

    // 公网地址与白名单域名不能误伤。
    for (const host of ['8.8.8.8', '1.1.1.1', 'p3-reading-sign.fqnovelpic.com', '[2001:4860:4860::8888]']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it('does not follow redirects', async () => {
    const dir = await tempDir();
    let seenRedirect: string | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seenRedirect = init.redirect;
      return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const service = makeService(testConfig(dir));

    await service.fetchJpeg(`${CDN}/no-redirect.jpg`);

    // `follow` 等于让上游指定最终地址，可以绕过白名单。
    expect(seenRedirect).toBe('error');
  });

  it('rejects a response whose declared length exceeds the limit', async () => {
    const dir = await tempDir();
    vi.stubGlobal('fetch', async () => {
      return new Response(JPEG, {
        status: 200,
        headers: { 'content-length': String(COVER_MAX_SOURCE_BYTES + 1), 'content-type': 'image/jpeg' },
      });
    });
    const service = makeService(testConfig(dir));

    await expect(service.fetchJpeg(`${CDN}/too-large.jpg`)).rejects.toThrow(/too large/);
  });

  it('aborts while streaming once the body exceeds the limit', async () => {
    const dir = await tempDir();
    // 不声明 `content-length`，只能靠逐块累计发现超限。
    const oversized = new Uint8Array(COVER_MAX_SOURCE_BYTES + 1024);
    vi.stubGlobal('fetch', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 分块推，确保不是一次读完才发现。
          for (let offset = 0; offset < oversized.length; offset += 64 * 1024) {
            controller.enqueue(oversized.subarray(offset, offset + 64 * 1024));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const service = makeService(testConfig(dir));

    await expect(service.fetchJpeg(`${CDN}/streamed-large.jpg`)).rejects.toThrow(/too large/);
  });

  it('rejects an empty body instead of caching a zero-byte jpeg', async () => {
    const dir = await tempDir();
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const service = makeService(testConfig(dir));

    await expect(service.fetchJpeg(`${CDN}/empty.jpg`)).rejects.toThrow(/empty body/);
    // 关键：不能留下一个 0 字节的缓存文件，否则它会一直返回到过期。
    const names = await readdir(join(dir, 'covers')).catch(() => [] as string[]);
    expect(names).toEqual([]);
  });

  it('gives up after the upstream timeout', async () => {
    const dir = await tempDir();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      // 模拟一个永不返回的上游：只对 signal 做反应。
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const service = makeService(testConfig(dir, { UPSTREAM_TIMEOUT_MS: 1_000 }));

    await expect(service.fetchJpeg(`${CDN}/never.jpg`)).rejects.toThrow();
  }, 10_000);
});

/**
 * 令牌化契约。
 *
 * 本模块存在的唯一理由：上游是签名 URL，`x-signature` 就在查询串里，
 * 把上游 URL 放进浏览器可见的任何位置都等于把签名交给客户端。
 * 这些断言必须在服务层守住，而不是只靠 controller。
 */
describe('cover token contract', () => {
  it('proxyUrl returns an opaque path that leaks neither host nor signature', () => {
    const service = makeService(testConfig('/tmp/unused'));
    const upstream = `${CDN}/novel-pic/a.heic?lk3s=64477e16&x-expires=1799667985&x-signature=SECRET%3D`;
    const url = service.proxyUrl(upstream);
    // 正常长度的上游地址必须能封成令牌；返回 `undefined` 说明长度校验把合法输入也拒了。
    expect(url).toBeDefined();
    if (url === undefined) {
      throw new Error('proxyUrl returned undefined for a normal upstream URL');
    }

    expect(url.startsWith('/api/cover/')).toBe(true);
    // 旧实现把 URL 编码后直接放进查询串，这两个断言会直接失败。
    expect(url).not.toContain('?u=');
    expect(url).not.toContain('fqnovelpic');
    expect(url).not.toContain('x-signature');
    expect(url).not.toContain('SECRET');
    // 令牌是 base64url，本身不需要再编码就能进路径段。
    const token = url.slice('/api/cover/'.length);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('resolveToken restores the exact upstream URL', () => {
    const service = makeService(testConfig('/tmp/unused'));
    const upstream = `${CDN}/x.heic?x-signature=abc`;
    const url = service.proxyUrl(upstream);
    expect(url).toBeDefined();
    const token = (url ?? '').slice('/api/cover/'.length);

    expect(service.resolveToken(token)).toBe(upstream);
  });

  it('resolveToken returns null for tampered or garbage tokens', () => {
    const service = makeService(testConfig('/tmp/unused'));
    const token = (service.proxyUrl(`${CDN}/y.heic`) ?? '').slice('/api/cover/'.length);
    const raw = Buffer.from(token, 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;

    expect(service.resolveToken(raw.toString('base64url'))).toBeNull();
    expect(service.resolveToken('')).toBeNull();
    expect(service.resolveToken('not-a-token')).toBeNull();
  });

  it('a token from another key cannot be opened', () => {
    const service = makeService(testConfig('/tmp/unused'));
    const foreign = CoverTokenCodec.fromKey(Buffer.alloc(32, 200));
    const token = foreign.seal(`${CDN}/z.heic`);

    expect(service.resolveToken(token)).toBeNull();
  });
});

describe('cover token length boundary', () => {
  it('omits the cover URL when the upstream URL would produce an oversized token', () => {
    const service = makeService(testConfig('/tmp/unused'));
    // 足够长、且仍是合法 URL 的上游地址：令牌会超过 `MAX_COVER_TOKEN_LENGTH`。
    const huge = `${CDN}/${'a'.repeat(MAX_COVER_TOKEN_LENGTH)}`;

    // 必须返回 `undefined`，而不是一个 Fastify 会在进入控制器前就 414 拒掉的地址。
    expect(service.proxyUrl(huge)).toBeUndefined();
  });

  it('still returns a URL for the longest upstream URL the offline snapshot allows', () => {
    const service = makeService(testConfig('/tmp/unused'));
    // 离线快照按 `MAX_COVER_URL_LENGTH` 判断封面地址长度；这里验证生成端不会
    // 在这条边界之内提前放弃，否则「快照允许保存」与「接口能生成」会不一致。
    const longest = `${CDN}/${'a'.repeat(3072)}`;
    const url = service.proxyUrl(longest);

    expect(url).toBeDefined();
    // 生成端与消费端同源：代理地址长度不得超过「前缀 + 令牌上限」。
    expect((url ?? '').length).toBeLessThanOrEqual(COVER_PATH_PREFIX.length + MAX_COVER_TOKEN_LENGTH);
  });
});

describe('cover controller token handling', () => {
  it('returns 400 cover_token_invalid for an invalid token and never calls fetchJpeg', async () => {
    const fetchJpeg = vi.fn();
    const covers = {
      resolveToken: vi.fn(() => null),
      fetchJpeg,
    } as unknown as CoverProxyService;
    const reply = replyStub();

    await new CoverController(covers).cover('garbage', reply as never);

    expect(reply.status).toBe(400);
    expect(reply.body).toMatchObject({ error: 'cover_token_invalid' });
    // 令牌无效时绝不能发起上游请求。
    expect(fetchJpeg).not.toHaveBeenCalled();
  });
});
