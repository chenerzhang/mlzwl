import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  CursorQuerySchema,
  SearchQuerySchema,
  type CursorQuery,
  type EpisodePage,
  type SearchQuery,
  type SeriesDetail,
  type SeriesPage,
} from '@mlzwl/hongguo-shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CatalogService } from './catalog.service.js';

@Controller('api')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('feed')
  feed(@Query(new ZodValidationPipe(CursorQuerySchema)) query: CursorQuery): Promise<SeriesPage> {
    return this.catalog.feed(query.cursor);
  }

  @Get('search')
  search(@Query(new ZodValidationPipe(SearchQuerySchema)) query: SearchQuery): Promise<SeriesPage> {
    return this.catalog.search(query.keyword, query.cursor);
  }

  @Get('series/:id')
  series(@Param('id') id: string): Promise<SeriesDetail> {
    return this.catalog.series(id);
  }

  @Get('series/:id/episodes')
  episodes(@Param('id') id: string): Promise<EpisodePage> {
    return this.catalog.episodes(id);
  }
}
