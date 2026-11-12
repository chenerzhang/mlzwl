import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module.js';
import { DiagnosticsController } from './common/diagnostics.controller.js';
import { FileLoggerService } from './common/file-logger.service.js';
import { HealthController } from './common/health.controller.js';
import { ConfigModule } from './config/config.module.js';
import { CoverModule } from './cover/cover.module.js';
import { SpriteController } from './cover/sprite.controller.js';
import { DbModule } from './db/db.module.js';
import { HongguoModule } from './hongguo/hongguo.module.js';
import { MediaModule } from './media/media.module.js';

@Module({
  imports: [ConfigModule, DbModule, HongguoModule, CoverModule, CatalogModule, MediaModule],
  controllers: [HealthController, DiagnosticsController, SpriteController],
  // `FileLoggerService` 总是存在，但它只在 `LOG_TO_FILE=true` 时才被装成 Nest 的
  // logger（见 `main.ts`）。让它始终可注入，是为了让 `/api/diagnostics` 在开关
  // 两种状态下响应形状一致。
  providers: [FileLoggerService],
})
export class AppModule {}
