import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SpriteMeta } from '@mlzwl/hongguo-shared';
import heicConvert from 'heic-convert';
import { CONFIG, type Config } from '../config/config.js';

/**
 * 清理时对最近写入文件的保护窗口。
 *
 * 同一集的多张雪碧图是并发写的，一次清理可能落在另一张图「刚写完还没被读到」
 * 的窗口里。窗口取 60 秒：远大于一次 HEIC 转码的耗时，又不至于让清理失效。
 */
const EVICT_PROTECT_MS = 60_000;

/** 单张雪碧图源文件的下载硬上限。 */
export const SPRITE_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * 本服务生成的雪碧图文件名：`<sanitized videoId>-<index>.jpg`。
 *
 * 第一个捕获组就是 `sanitize` 之后的 video id。`evict` 与 `recentVideoIds`
 * 都只认这个形状，不把目录里的其他东西当成缓存文件。
 */
const SHEET_FILE_PATTERN = /^(.+)-\d+\.jpg$/;

/** 上游 `big_thumbs[0]` 的原始结构。 */
export interface UpstreamSprite {
  imgNum: number;
  gridX: number;
  gridY: number;
  cellWidth: number;
  cellHeight: number;
  interval: number;
  urls: string[];
}

export interface SpriteResult extends SpriteMeta {
  sheetCount: number;
}

/**
 * 雪碧图缓存。
 *
 * 上游把进度条缩略图打包成 HEIC 大图：每张 `gridX × gridY` 格，每格
 * `cellWidth × cellHeight` 像素。帧数超过网格容量就分多张。
 *
 * 实测数据（同一集）：
 *   img_num=97  → 1 张（容量 100）
 *   img_num=147 → 2 张
 *   img_num=355 → 4 张
 *   img_num=545 → 6 张
 * 即每张固定 `gridX * gridY` 格，最后一张也补满，**不能靠图片高度推断有效帧数**。
 */
@Injectable()
export class SpriteCacheService {
  private readonly logger = new Logger(SpriteCacheService.name);
  private readonly inflight = new Map<string, Promise<Buffer>>();

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  private get dir(): string {
    return join(this.config.DATA_DIR, 'sprites');
  }

  /** 缓存键用 video id：上游 URL 带签名会变，video id 不变。 */
  private fileName(videoId: string, sheetIndex: number): string {
    return `${sanitize(videoId)}-${sheetIndex}.jpg`;
  }

  /** 缓存键的哈希形式，用于内部 map 去重。 */
  private cacheKey(videoId: string, sheetIndex: number): string {
    return createHash('sha256').update(`${videoId}:${sheetIndex}`).digest('hex');
  }

  /**
   * 取一张雪碧图，转成 JPEG。
   *
   * @param videoId 上游 video id，作为缓存键。
   * @param sheetIndex 第几张，从 0 开始。
   * @param url 上游 HEIC 地址（带签名，会过期）。
   */
  async getSheet(videoId: string, sheetIndex: number, url: string): Promise<Buffer> {
    const file = join(this.dir, this.fileName(videoId, sheetIndex));
    const cached = await readFile(file).catch(() => null);
    if (cached !== null) {
      return cached;
    }

    const key = this.cacheKey(videoId, sheetIndex);
    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const task = this.produce(url, file);
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 已有缓存则返回路径，不触发下载。 */
  async peekSheet(videoId: string, sheetIndex: number): Promise<Buffer | null> {
    return readFile(join(this.dir, this.fileName(videoId, sheetIndex))).catch(() => null);
  }

  private async produce(url: string, file: string): Promise<Buffer> {
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`sprite fetch failed: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > SPRITE_MAX_SOURCE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`sprite too large: ${declared} bytes`);
    }
    const source = await readBodyWithLimit(response, SPRITE_MAX_SOURCE_BYTES);
    if (source.length === 0) {
      throw new Error('sprite fetch returned an empty body');
    }
    const jpeg = Buffer.from(await heicConvert({ buffer: source, format: 'JPEG', quality: 0.8 }));
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, jpeg);
    this.logger.log(`sprite ready bytes=${source.length}->${jpeg.length}`);
    return jpeg;
  }

  /**
   * 清理不在保留集合里的雪碧图，避免磁盘无限增长。
   *
   * `keepVideoIds` 收的是**原始** video id：文件名里的 id 已经过 `sanitize`，
   * 所以这里先按同样规则归一化再比较，否则含非法字符的 id 永远匹配不上，
   * 会被自己生成的清理删掉。
   *
   * 刚写入的文件不删：清理由请求路径触发，同一集的 6 张图是并发写的，删掉
   * mtime 还在保护窗口内的文件会让并发的 `getSheet` 读失败。
   */
  async evict(keepVideoIds: ReadonlySet<string>): Promise<void> {
    const keep = new Set(Array.from(keepVideoIds, (videoId) => sanitize(videoId)));
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const now = Date.now();
    const stale: string[] = [];
    for (const name of entries) {
      // 只认本服务自己生成的形状，不碰目录里可能存在的其他文件。
      const videoId = SHEET_FILE_PATTERN.exec(name)?.[1];
      if (videoId === undefined || keep.has(videoId)) {
        continue;
      }
      const info = await stat(join(this.dir, name)).catch(() => null);
      if (info === null || now - info.mtimeMs < EVICT_PROTECT_MS) {
        continue;
      }
      stale.push(name);
    }
    if (stale.length === 0) {
      return;
    }
    await Promise.all(stale.map((name) => rm(join(this.dir, name), { force: true })));
    this.logger.log(`evicted ${stale.length} sprite files`);
  }

  /**
   * 最近 `withinDays` 天内被触碰过的 video id（用 mtime 近似「最近播放过」）。
   *
   * 返回的是 `sanitize` 之后的形式，与文件名前缀一致，可以直接喂给 `evict`。
   * 目录不存在时返回空集合。
   */
  async recentVideoIds(withinDays: number): Promise<Set<string>> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
    const videoIds = new Set<string>();
    for (const name of entries) {
      const videoId = SHEET_FILE_PATTERN.exec(name)?.[1];
      if (videoId === undefined) {
        continue;
      }
      const info = await stat(join(this.dir, name)).catch(() => null);
      if (info === null || info.mtimeMs < cutoff) {
        continue;
      }
      videoIds.add(videoId);
    }
    return videoIds;
  }
}

/**
 * 文件名里允许出现的字符集合。
 *
 * 映射到 `_` 而不是删掉：删掉会让不同 id 撞成同一个文件名。`_` 与 `-` 本身
 * 放行，所以 `sanitize` 幂等，可以安全地对已经归一化过的值再跑一次。
 */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function readBodyWithLimit(response: Response, limit: number): Promise<Buffer> {
  const body = response.body;
  if (body === null) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`sprite too large: over ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
