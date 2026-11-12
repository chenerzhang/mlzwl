import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { CoverController } from './cover.controller.js';
import { COVER_TOKEN_CODEC, CoverProxyService } from './cover-proxy.service.js';
import { CoverTokenCodec } from './cover-token.js';
import { SpriteCacheService } from './sprite-cache.service.js';

@Module({
  controllers: [CoverController],
  providers: [
    {
      // 密钥在启动时加载一次。生成失败直接让启动失败：拿不到稳定密钥时
      // 生成的令牌重启就解不开，宁可起不来也不要产生一批「明天就失效」的地址。
      provide: COVER_TOKEN_CODEC,
      inject: [CONFIG],
      useFactory: async (config: Config): Promise<CoverTokenCodec> =>
        CoverTokenCodec.loadOrCreate(join(config.DATA_DIR, 'cover-token.key')),
    },
    CoverProxyService,
    SpriteCacheService,
  ],
  exports: [CoverProxyService, SpriteCacheService],
})
export class CoverModule {}
