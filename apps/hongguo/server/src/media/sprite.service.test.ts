import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { SPRITE_MAX_SOURCE_BYTES, SpriteCacheService } from '../cover/sprite-cache.service.js';
import type { HongguoService } from '../hongguo/hongguo.service.js';
import { SpriteService } from './sprite.service.js';
import type { VideoModelCapture } from './video-model-capture.service.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hongguo-sprite-'));
  tempDirs.push(dir);
  return dir;
}

function testConfig(dataDir: string, timeout = 1_000): Config {
  return {
    NODE_ENV: 'test',
    PORT: 9133,
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    MEDIA_KEEP: 4,
    COVER_KEEP_DAYS: 30,
    UPSTREAM_TIMEOUT_MS: timeout,
    MEDIA_MAX_BYTES: 1_048_576,
    CORS_ORIGINS: [],
    LOG_TO_FILE: false,
  };
}

describe('SpriteService cache lookup', () => {
  it('does not resolve playback again when a known sheet is cached', async () => {
    let resolves = 0;
    const client = {
      resolvePlayback: async () => {
        resolves += 1;
      },
    };
    const hongguo = { getClient: async () => client } as unknown as HongguoService;
    const captured = {
      sprite: { imgNum: 1, gridX: 1, gridY: 1, cellWidth: 10, cellHeight: 10, interval: 5, urls: ['upstream'] },
      videoId: 'video-1',
    };
    const capture = { take: () => captured } as unknown as VideoModelCapture;
    const bytes = Buffer.from('cached');
    const cache = {
      peekSheet: vi.fn(async () => bytes),
      recentVideoIds: vi.fn(async () => new Set<string>()),
      evict: vi.fn(async () => undefined),
    } as unknown as SpriteCacheService;
    const service = new SpriteService(hongguo, capture, cache);

    await service.info('episode-1');
    expect(resolves).toBe(1);

    expect(await service.sheet('episode-1', 0)).toBe(bytes);
    expect(resolves).toBe(1);
    expect(cache.peekSheet).toHaveBeenCalledWith('video-1', 0);
  });
});

describe('SpriteCacheService upstream limits', () => {
  it('rejects a response whose declared length exceeds the source limit', async () => {
    const dir = await tempDir();
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(Buffer.from('x'), {
          status: 200,
          headers: { 'content-length': String(SPRITE_MAX_SOURCE_BYTES + 1) },
        }),
    );

    await expect(
      new SpriteCacheService(testConfig(dir)).getSheet('video-1', 0, 'https://example.invalid/a'),
    ).rejects.toThrow(/too large/);
  });

  it('aborts an upstream request after the configured timeout', async () => {
    const dir = await tempDir();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    await expect(
      new SpriteCacheService(testConfig(dir, 10)).getSheet('video-1', 0, 'https://example.invalid/a'),
    ).rejects.toThrow(/aborted/);
  });

  it('returns a disk hit without fetching upstream', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'sprites'), { recursive: true });
    await writeFile(join(dir, 'sprites', 'video-1-0.jpg'), Buffer.from('cached'));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const bytes = await new SpriteCacheService(testConfig(dir)).getSheet('video-1', 0, 'https://example.invalid/a');

    expect(bytes.toString()).toBe('cached');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
