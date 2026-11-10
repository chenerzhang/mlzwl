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
   */
  async sheet(episodeId: string, index: number): Promise<Buffer> {
    const info = await this.info(episodeId);
    if (index >= info.sheetUrls.length) {
      throw new NotFoundException(`sheet ${index} out of range`);
    }

    const cached = await this.cache.peekSheet(info.videoId, index);
    if (cached !== null) {
      return cached;
    }

    // 缓存未命中：重新解析拿到带签名的原始 URL。URL 会过期，所以不能长期保存。
    const client = await this.hongguo.getClient();
    await client.resolvePlayback(episodeId);
    const captured = this.capture.take(episodeId);
    const url = captured?.sprite?.urls[index];
    if (url === undefined) {
      throw new NotFoundException(`sheet ${index} has no upstream URL`);
    }

    return this.cache.getSheet(info.videoId, index, url);
  }
}
