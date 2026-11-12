import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { redactError } from '../common/redact.js';
import { CoverProxyService, CoverUrlRejectedError } from './cover-proxy.service.js';

@Controller('api')
export class CoverController {
  constructor(private readonly covers: CoverProxyService) {}

  /**
   * HEIC/JPEG 封面代理。
   *
   * 路径里是**不透明令牌**，不是上游地址。上游是签名 URL，`x-signature` 就在
   * 查询串里；把它放进浏览器可见的任何位置都等于把签名交给客户端。
   * 令牌由服务端 AES-GCM 解密还原，浏览器侧不可解。
   *
   * 把上游地址放在查询串里的旧路由已移除：保留它等于保留泄漏面。
   *
   * 响应带长缓存头：封面内容不变，令牌对应的上游地址变了令牌也就变了。
   */
  @Get('cover/:token')
  @Header('cache-control', 'public, max-age=604800, immutable')
  async cover(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const upstream = this.covers.resolveToken(token);
    if (upstream === null) {
      // 令牌不合法是**调用方错误**：400，不是 502。分开才能区分「我们拒了」与「上游坏了」。
      await reply.code(400).send({ error: 'cover_token_invalid', message: 'cover token is invalid' });
      return;
    }

    try {
      const { buffer, contentType } = await this.covers.fetchJpeg(upstream);
      await reply.header('content-type', contentType).header('content-length', String(buffer.length)).send(buffer);
    } catch (error) {
      // 地址不合法（非白名单、带凭据、私网）是**调用方错误**，用 400；
      // 上游拉不到才是 502。
      const status = error instanceof CoverUrlRejectedError ? 400 : 502;
      const code = status === 400 ? 'cover_url_rejected' : 'cover_unavailable';
      await reply.code(status).send({ error: code, message: redactError(error).message });
    }
  }
}
