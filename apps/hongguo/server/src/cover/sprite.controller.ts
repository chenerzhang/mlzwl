import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { SpriteQuerySchema, type SpriteQuery } from '@mlzwl/hongguo-shared';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SpriteService } from '../media/sprite.service.js';

@Controller('api')
export class SpriteController {
  constructor(private readonly sprites: SpriteService) {}

  /**
   * 雪碧图元数据 + 每张图的地址。
   *
   * 前端需要 `gridX/gridY/cellWidth/cellHeight` 来算 `background-position`，
   * 需要 `sheetCount` 来知道第 n 帧在哪张图上。
   */
  @Get('sprite/:episodeId')
  async meta(@Param('episodeId') episodeId: string): Promise<{
    gridX: number;
    gridY: number;
    cellWidth: number;
    cellHeight: number;
    frameCount: number;
    interval: number;
    sheetCount: number;
    sheetUrls: string[];
  }> {
    const info = await this.sprites.info(episodeId);
    return {
      ...info.meta,
      sheetCount: info.sheetUrls.length,
      sheetUrls: info.sheetUrls,
    };
  }

  /** 第 `sheet` 张雪碧图，JPEG。 */
  @Get('sprite/:episodeId/:sheet')
  async sheet(
    @Param('episodeId') episodeId: string,
    @Param('sheet') sheet: string,
    @Query(new ZodValidationPipe(SpriteQuerySchema)) query: SpriteQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const index = Number.parseInt(sheet, 10);
    if (!Number.isInteger(index) || index < 0) {
      await reply.code(400).send({ error: 'invalid_sheet_index' });
      return;
    }
    try {
      const buffer = await this.sprites.sheet(episodeId, index);
      await reply
        .header('content-type', 'image/jpeg')
        .header('content-length', String(buffer.length))
        .header('cache-control', 'public, max-age=86400, immutable')
        .send(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reply.code(404).send({ error: 'sprite_unavailable', message, sheet: query.sheet ?? index });
    }
  }
}
