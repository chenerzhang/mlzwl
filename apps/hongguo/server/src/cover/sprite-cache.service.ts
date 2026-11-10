import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SpriteMeta } from '@mlzwl/hongguo-shared';
import heicConvert from 'heic-convert';
import { CONFIG, type Config } from '../config/config.js';

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
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`sprite fetch failed: HTTP ${response.status}`);
    }
    const source = Buffer.from(await response.arrayBuffer());
    const jpeg = Buffer.from(await heicConvert({ buffer: source, format: 'JPEG', quality: 0.8 }));
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, jpeg);
    this.logger.log(`sprite ready bytes=${source.length}->${jpeg.length}`);
    return jpeg;
  }

  /** 清理某部剧之外的旧雪碧图，避免磁盘无限增长。 */
  async evict(keepVideoIds: ReadonlySet<string>): Promise<void> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const stale = entries.filter((name) => {
      const videoId = name.replace(/-\d+\.jpg$/, '');
      return !keepVideoIds.has(videoId);
    });
    if (stale.length === 0) {
      return;
    }
    await Promise.all(stale.map((name) => rm(join(this.dir, name), { force: true })));
    this.logger.log(`evicted ${stale.length} sprite files`);
  }

  async size(): Promise<number> {
    const info = await stat(this.dir).catch(() => null);
    return info?.size ?? 0;
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
