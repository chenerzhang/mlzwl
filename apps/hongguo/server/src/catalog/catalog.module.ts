import { Module } from '@nestjs/common';
import { CoverModule } from '../cover/cover.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogMapper } from './catalog.mapper.js';
import { CatalogService } from './catalog.service.js';

@Module({
  imports: [CoverModule],
  controllers: [CatalogController],
  providers: [CatalogService, CatalogMapper],
  exports: [CatalogService, CatalogMapper],
})
export class CatalogModule {}
