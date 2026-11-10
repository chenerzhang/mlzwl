import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { ConfigModule } from './config/config.module.js';
import { CoverModule } from './cover/cover.module.js';
import { SpriteController } from './cover/sprite.controller.js';
import { DbModule } from './db/db.module.js';
import { HongguoModule } from './hongguo/hongguo.module.js';
import { MediaModule } from './media/media.module.js';

@Module({
  imports: [ConfigModule, DbModule, HongguoModule, CoverModule, CatalogModule, MediaModule],
  controllers: [SpriteController],
})
export class AppModule {}
