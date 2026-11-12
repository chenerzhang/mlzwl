import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { CoverQuerySchema, type CoverQuery } from '@mlzwl/hongguo-shared';
import type { FastifyReply } from 'fastify';
import { redactError } from '../common/redact.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CoverProxyService, CoverUrlRejectedError } from './cover-proxy.service.js';

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
      // 地址不合法（非白名单、带凭据、私网）是**调用方错误**，用 400；
      // 上游拉不到才是 502。两者分开，客户端与日志才能区分「我们拒了」与「上游坏了」。
      const status = error instanceof CoverUrlRejectedError ? 400 : 502;
      const code = status === 400 ? 'cover_url_rejected' : 'cover_unavailable';
      await reply.code(status).send({ error: code, message: redactError(error).message });
    }
  }
}
