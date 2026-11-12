import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { SpriteQuerySchema, type SpriteQuery } from '@mlzwl/hongguo-shared';
import type { FastifyReply } from 'fastify';
import { redactError } from '../common/redact.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { SpriteService } from '../media/sprite.service.js';

/**
 * 严格解析雪碧图序号。
 *
 * 只接受纯十进制非负整数字符串。`parseInt` 会把 `1x`、`1.5` 都解析成 1，
 * 导致畸形路径静默返回第 1 张图。这里先正则验证整个字符串，
 * 再用 `Number()` 和 `Number.isSafeInteger()` 确认能安全表示。
 */
export function parseSheetIndex(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return null;
  }
  return value;
}

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
    // 先用完整字符串正则验证，再转数字。
    // `Number.parseInt('1x', 10)` 和 `Number.parseInt('1.5', 10)` 都会得到 1，
    // 那样畸形路径会静默返回第 1 张图，给同一个 immutable 资源造出畸形别名。
    const index = parseSheetIndex(sheet);
    if (index === null) {
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
      await reply
        .code(404)
        .send({ error: 'sprite_unavailable', message: redactError(error).message, sheet: query.sheet ?? index });
    }
  }
}
