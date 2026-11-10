import { Controller, Get, Head, Param, Query, Req, Res } from '@nestjs/common';
import { PlaybackQuerySchema, type Playback, type PlaybackQuery } from '@mlzwl/hongguo-shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MediaCacheService } from './media-cache.service.js';
import { PlaybackService } from './playback.service.js';
import { MediaRange, rangeHeaders } from './range.js';

const CONTENT_TYPE = 'video/mp4';

@Controller('api')
export class MediaController {
  constructor(
    private readonly playback: PlaybackService,
    private readonly cache: MediaCacheService,
    private readonly ranges: MediaRange,
  ) {}

  /**
   * 播放信息。
   *
   * 返回的是**自有** `streamUrl`。上游签名地址与内容密钥都不出现在响应里。
   */
  @Get('episodes/:id/playback')
  async resolve(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(PlaybackQuerySchema)) query: PlaybackQuery,
  ): Promise<Playback> {
    const resolved = await this.playback.resolve(id, query.definition);
    const stream = resolved.stream;
    const duration = resolved.playback.duration_seconds;

    return {
      episodeId: id,
      streamUrl: `/api/media/${encodeURIComponent(id)}`,
      duration: duration !== undefined && duration > 0 ? duration : 1,
      definition: stream.definition ?? 'unknown',
      availableDefinitions: resolved.availableDefinitions,
      ...(stream.codec === undefined ? {} : { codec: stream.codec }),
      ...(stream.width === undefined ? {} : { width: stream.width }),
      ...(stream.height === undefined ? {} : { height: stream.height }),
    };
  }

  /**
   * 视频流，支持 Range。
   *
   * 用 `@Res()` 手动接管：Fastify 的 `reply.send(stream)` 才支持原生流式，
   * Nest 的自动序列化会把流当对象处理。
   */
  @Get('media/:episodeId')
  async stream(
    @Param('episodeId') episodeId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const resolved = await this.playback.resolve(episodeId);
    const media = await this.cache.get(episodeId, resolved);

    const rangeHeader = request.headers.range;
    if (rangeHeader === undefined) {
      await reply
        .header('content-type', CONTENT_TYPE)
        .header('content-length', String(media.size))
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'private, max-age=3600')
        .send(this.cache.createStream(media.file));
      return;
    }

    const range = this.ranges.parse(rangeHeader, media.size);
    if (range === null) {
      await reply.code(416).header('content-range', `bytes */${media.size}`).send();
      return;
    }

    await reply
      .code(206)
      .headers(rangeHeaders(range, media.size, CONTENT_TYPE))
      .header('cache-control', 'private, max-age=3600')
      .send(this.cache.createStream(media.file, range.start, range.end));
  }

  /** `HEAD` 用于浏览器预检文件大小。不下载、不解密，只读缓存元数据。 */
  @Head('media/:episodeId')
  async head(@Param('episodeId') episodeId: string, @Res() reply: FastifyReply): Promise<void> {
    const resolved = await this.playback.resolve(episodeId);
    const media = await this.cache.peek(episodeId, resolved.stream.definition ?? 'default');
    if (media === null) {
      // 还没缓存，返回 200 + 已知大小（上游给了 size，但可能不准），
      // 让浏览器发 Range 请求来触发实际下载。
      const size = resolved.stream.size;
      await reply
        .header('content-type', CONTENT_TYPE)
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'no-store')
        .header('content-length', String(size ?? 0))
        .send();
      return;
    }
    await reply
      .header('content-type', CONTENT_TYPE)
      .header('content-length', String(media.size))
      .header('accept-ranges', 'bytes')
      .send();
  }
}
