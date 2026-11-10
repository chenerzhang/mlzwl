import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { CoverQuerySchema, type CoverQuery } from '@mlzwl/hongguo-shared';
import type { FastifyReply } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CoverProxyService } from './cover-proxy.service.js';

@Controller('api')
export class CoverController {
  constructor(private readonly covers: CoverProxyService) {}

  /**
   * HEIC/JPEG 封面代理。
   *
   * 上游地址是签名 URL，会过期，所以缓存键用 URL 本身；URL 变了自然重新取。
   * 响应带长缓存头：封面内容不变，URL 变了键也就变了。
   */
  @Get('cover')
  @Header('cache-control', 'public, max-age=604800, immutable')
  async cover(
    @Query(new ZodValidationPipe(CoverQuerySchema)) query: CoverQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      const { buffer, contentType } = await this.covers.fetchJpeg(query.u, query.w);
      await reply.header('content-type', contentType).header('content-length', String(buffer.length)).send(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await reply.code(502).send({ error: 'cover_unavailable', message });
    }
  }
}
