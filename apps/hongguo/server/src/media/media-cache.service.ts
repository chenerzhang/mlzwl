import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { decryptCenc } from './cenc.js';
import { CONFIG, type Config } from '../config/config.js';
import type { ResolvedPlayback } from './playback.service.js';

export interface CachedMedia {
  file: string;
  /** 解密后字节数（与加密文件相同，但显式记录便于校验）。 */
  size: number;
}

/**
 * 解密后视频的磁盘缓存。
 *
 * 流程：下载加密 MP4 → 原地解密 → 写盘 → Range 流式返回。没有转码、没有重封装。
 *
 * 关键点：
 * - 按 `episodeId` 缓存。同一集换清晰度会重新下载，但密钥不变。
 * - 同一集的并发请求共享一个 Promise，避免重复下载 15 MB。
 * - LRU 按 mtime 清理，保留 `MEDIA_KEEP` 个（沿用上游 40）。
 */
@Injectable()
export class MediaCacheService {
  private readonly logger = new Logger(MediaCacheService.name);
  private readonly inflight = new Map<string, Promise<CachedMedia>>();

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  private get dir(): string {
    return join(this.config.DATA_DIR, 'media');
  }

  /** 缓存文件名包含清晰度：同一集切档后两份文件并存，避免来回重下。 */
  private fileName(episodeId: string, definition: string): string {
    return `${sanitize(episodeId)}-${sanitize(definition)}.mp4`;
  }

  async get(episodeId: string, resolved: ResolvedPlayback): Promise<CachedMedia> {
    const definition = resolved.stream.definition ?? 'default';
    const file = join(this.dir, this.fileName(episodeId, definition));

    const existing = await stat(file).catch(() => null);
    if (existing !== null && existing.size > 0) {
      // 触碰 mtime，让 LRU 认为它刚用过。
      const now = new Date();
      await import('node:fs/promises').then((fs) => fs.utimes(file, now, now)).catch(() => undefined);
      return { file, size: existing.size };
    }

    const key = `${episodeId}-${definition}`;
    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const task = this.produce(episodeId, resolved, file);
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 已缓存则返回路径，不触发下载。用于 controller 快速判断。 */
  async peek(episodeId: string, definition: string): Promise<CachedMedia | null> {
    const file = join(this.dir, this.fileName(episodeId, definition));
    const info = await stat(file).catch(() => null);
    if (info === null || info.size === 0) {
      return null;
    }
    return { file, size: info.size };
  }

  createStream(file: string, start?: number, end?: number): ReturnType<typeof createReadStream> {
    return createReadStream(file, start === undefined ? {} : end === undefined ? { start } : { start, end });
  }

  async readAll(file: string): Promise<Buffer> {
    return readFile(file);
  }

  private async produce(episodeId: string, resolved: ResolvedPlayback, file: string): Promise<CachedMedia> {
    const url = resolved.stream.url;
    if (url === undefined) {
      throw new Error(`episode ${episodeId} has no stream URL`);
    }

    const started = Date.now();
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`media download failed: HTTP ${response.status}`);
    }
    const encrypted = new Uint8Array(await response.arrayBuffer());
    const downloadedAt = Date.now();

    const { buffer, tracks } = decryptCenc(encrypted, resolved.key.key);
    const decryptedAt = Date.now();

    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buffer);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, file);

    this.logger.log(
      `media ready episode=${episodeId} def=${resolved.stream.definition ?? '?'} ` +
        `bytes=${buffer.length} download=${downloadedAt - started}ms decrypt=${decryptedAt - downloadedAt}ms ` +
        `tracks=${tracks.map((t) => `${t.clearType}:${t.sampleCount}`).join(',')}`,
    );

    await this.evict();
    return { file, size: buffer.length };
  }

  /** 按 mtime 清理，保留最新 `MEDIA_KEEP` 个文件。 */
  private async evict(): Promise<void> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const files = entries.filter((name) => name.endsWith('.mp4'));
    if (files.length <= this.config.MEDIA_KEEP) {
      return;
    }

    const stats = await Promise.all(
      files.map(async (name) => {
        const info = await stat(join(this.dir, name)).catch(() => null);
        return { name, mtime: info?.mtimeMs ?? 0 };
      }),
    );
    stats.sort((a, b) => a.mtime - b.mtime);
    const excess = stats.slice(0, stats.length - this.config.MEDIA_KEEP);
    await Promise.all(excess.map((entry) => rm(join(this.dir, entry.name), { force: true })));
    this.logger.log(`evicted ${excess.length} media files (keep ${this.config.MEDIA_KEEP})`);
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
