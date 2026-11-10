import { Module } from '@nestjs/common';
import { CoverModule } from '../cover/cover.module.js';
import { HongguoService } from '../hongguo/hongguo.service.js';
import { MediaCacheService } from './media-cache.service.js';
import { MediaController } from './media.controller.js';
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
   * 把 spade 捕获器挂到 SDK 的 transport 上。
   *
   * 在模块构造函数里注册：模块构造函数早于任何生命周期钩子，而 `HongguoService`
   * 的 client 预热在 `onApplicationBootstrap`，所以这里一定赶在 client 创建前。
   */
  constructor(
    private readonly hongguo: HongguoService,
    private readonly spade: VideoModelCapture,
  ) {
    this.hongguo.addTransportDecorator((inner) => this.spade.wrap(inner));
  }
}
