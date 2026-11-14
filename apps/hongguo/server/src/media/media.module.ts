import { Module } from '@nestjs/common';
import { CoverModule } from '../cover/cover.module.js';
import { HongguoService } from '../hongguo/hongguo.service.js';
import { MediaCacheService } from './media-cache.service.js';
import { MediaController } from './media.controller.js';
import { rewriteVideoModelRequest } from './playback-transport.js';
import { MediaRange } from './range.js';
import { PlaybackService } from './playback.service.js';
import { SpriteService } from './sprite.service.js';
import { VideoModelCapture } from './video-model-capture.service.js';

@Module({
  imports: [CoverModule],
  controllers: [MediaController],
  providers: [VideoModelCapture, PlaybackService, MediaCacheService, MediaRange, SpriteService],
  exports: [PlaybackService, MediaCacheService, SpriteService],
})
export class MediaModule {
  /**
   * 挂两个 transport 装饰器。
   *
   * 在模块构造函数里注册：模块构造函数早于任何生命周期钩子，而 `HongguoService`
   * 的 client 预热在 `onApplicationBootstrap`，所以这里一定赶在 client 创建前。
   *
   * 顺序有讲究。`HongguoService` 按注册顺序**由内向外**包裹，所以先注册的离
   * 网络更近，后注册的包在最外层。调用链是：
   *
   *     VideoModelCapture.wrap → rewriteVideoModelRequest → nodeTransport
   *
   * 这样排正好：捕获器看到的是**原始**请求（URL 里是 `video_model`，命中它的
   * 过滤条件）和**已提升**的响应（`data.video_model`，命中 `readVideoModel`）。
   * 反过来排的话，捕获器看到的是改写后的 URL 和按 id 分组的响应，两处都对不上。
   */
  constructor(
    private readonly hongguo: HongguoService,
    private readonly spade: VideoModelCapture,
  ) {
    this.hongguo.addTransportDecorator((inner) => rewriteVideoModelRequest(inner));
    this.hongguo.addTransportDecorator((inner) => this.spade.wrap(inner));
  }
}
