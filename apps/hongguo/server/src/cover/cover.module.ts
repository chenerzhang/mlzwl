import { Module } from '@nestjs/common';
import { CoverController } from './cover.controller.js';
import { CoverProxyService } from './cover-proxy.service.js';
import { SpriteCacheService } from './sprite-cache.service.js';

@Module({
  controllers: [CoverController],
  providers: [CoverProxyService, SpriteCacheService],
  exports: [CoverProxyService, SpriteCacheService],
})
export class CoverModule {}
