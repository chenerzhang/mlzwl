import { Injectable, NotFoundException } from '@nestjs/common';
import type { SpriteMeta } from '@mlzwl/hongguo-shared';
import { HongguoService } from '../hongguo/hongguo.service.js';
import { SpriteCacheService } from '../cover/sprite-cache.service.js';
import { VideoModelCapture } from './video-model-capture.service.js';

export interface SpriteInfo {
  meta: SpriteMeta;
  /** 每张图的地址，已改写成本服务的代理路径。 */
  sheetUrls: string[];
  videoId: string;
}

/**
 * 雪碧图缓存的保留天数。
 *
 * 用 mtime 近似「最近播放过」：命中缓存不会触碰 mtime（`peekSheet` 只读），
 * 但一次播放会请求该集的全部雪碧图，所以 30 天足以覆盖「还在看的剧」。
 */
const SPRITE_KEEP_DAYS = 30;

/**
 * 雪碧图服务。
 *
 * 上游把进度条缩略图打包成 HEIC 大图，SDK 不暴露这个字段，所以这里再调一次
 * `resolvePlayback`，从捕获的原始 `video_model` 里取 `big_thumbs`。
 *
 * 为什么单独一个 service：雪碧图是可选装饰，失败不该影响播放。放在
 * `PlaybackService` 里会让播放路径承担不必要的失败风险。
 */
@Injectable()
export class SpriteService {
  private readonly knownSheets = new Map<string, { videoId: string; sheetCount: number }>();

  constructor(
    private readonly hongguo: HongguoService,
    private readonly capture: VideoModelCapture,
    private readonly cache: SpriteCacheService,
  ) {}

  async info(episodeId: string): Promise<SpriteInfo> {
    const client = await this.hongguo.getClient();
    await client.resolvePlayback(episodeId);

    const captured = this.capture.take(episodeId);
    if (captured?.sprite === undefined) {
      throw new NotFoundException(`episode ${episodeId} has no sprite sheet`);
    }

    const sprite = captured.sprite;
    const videoId = captured.videoId ?? episodeId;
    this.knownSheets.set(episodeId, { videoId, sheetCount: sprite.urls.length });

    return {
      meta: {
        gridX: sprite.gridX,
        gridY: sprite.gridY,
        cellWidth: sprite.cellWidth,
        cellHeight: sprite.cellHeight,
        frameCount: sprite.imgNum,
        interval: sprite.interval,
      },
      sheetUrls: sprite.urls.map((_, index) => `/api/sprite/${encodeURIComponent(episodeId)}/${index}`),
      videoId,
    };
  }

  /**
   * 取第 `index` 张雪碧图的 JPEG。
   *
   * 先查缓存（命中就不必再解析播放）；未命中时解析一次，取原始 HEIC 地址下载转码。
   * 成功拿到字节后顺手修剪一次缓存，失败路径不修剪。
   */
  async sheet(episodeId: string, index: number): Promise<Buffer> {
    const known = this.knownSheets.get(episodeId);
    if (known !== undefined) {
      if (index >= known.sheetCount) {
        throw new NotFoundException(`sheet ${index} out of range`);
      }
      const cached = await this.cache.peekSheet(known.videoId, index);
      if (cached !== null) {
        this.evictInBackground(known.videoId);
        return cached;
      }
    }

    // 元数据未知或磁盘未命中时只解析一次；同次捕获的 URL 直接交给生产路径。
    const client = await this.hongguo.getClient();
    await client.resolvePlayback(episodeId);
    const captured = this.capture.take(episodeId);
    const sprite = captured?.sprite;
    const url = sprite?.urls[index];
    if (captured === undefined || sprite === undefined || url === undefined) {
      throw new NotFoundException(`sheet ${index} has no upstream URL`);
    }
    const videoId = captured.videoId ?? episodeId;
    this.knownSheets.set(episodeId, { videoId, sheetCount: sprite.urls.length });
    const buffer = await this.cache.getSheet(videoId, index, url);
    this.evictInBackground(videoId);
    return buffer;
  }

  /**
   * 成功返回后修剪雪碧图缓存。
   *
   * 采用「写入后立即修剪」而不是定时任务：请求路径本来就已经在跑，多一次
   * `readdir` 比多一个需要生命周期管理的定时器便宜。
   *
   * 保留集合取「最近 30 天被触碰过的 video id」并上当前这一集；雪碧图是可选装饰，
   * 所以清理必须**不阻塞响应、不抛错**：`void` + `catch` 吞掉全部失败。
   */
  private evictInBackground(videoId: string): void {
    void this.cache
      .recentVideoIds(SPRITE_KEEP_DAYS)
      .then((recent) => {
        // 退化：目录为空或没有 30 天内的文件时，至少保住当前这一集。
        const keep = recent.size === 0 ? new Set<string>([videoId]) : new Set<string>([...recent, videoId]);
        return this.cache.evict(keep);
      })
      .catch(() => undefined);
  }
}
