import { Controller, Get, Head, Param, Query, Req, Res } from '@nestjs/common';
import { PlaybackQuerySchema, type Playback, type PlaybackQuery } from '@mlzwl/hongguo-shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MediaCacheService } from './media-cache.service.js';
import { MediaError } from './media.error.js';
import { PlaybackService, PlaybackUnavailableError, type ResolvedPlayback } from './playback.service.js';
import { MediaRange, rangeHeaders } from './range.js';

const CONTENT_TYPE = 'video/mp4';

/**
 * 把清晰度标签拼进媒体地址。
 *
 * 为什么要拼：`/api/media/:id` 不携带档位时，服务端只能走默认选档，于是
 * “播放信息说 540p、实际媒体流是默认档”会静默不一致。缓存文件名带清晰度，
 * 入口参数一丢，缓存也永远只命中默认档。
 *
 * 标签不合法（例如上游没给 `definition`，映射为 `unknown`）时不拼参数：
 * 此时默认选档会得到同一个流，拼上去反而会让 `PlaybackQuerySchema` 报 400。
 */
function mediaUrl(episodeId: string, definition: string | undefined): string {
  const base = `/api/media/${encodeURIComponent(episodeId)}`;
  if (definition === undefined) {
    return base;
  }
  const valid = PlaybackQuerySchema.shape.definition.safeParse(definition).success;
  return valid ? `${base}?definition=${encodeURIComponent(definition)}` : base;
}

/**
 * 把 `PlaybackUnavailableError` 转成带 `code` 的 `MediaError` 并抛出。
 *
 * 三个 `reason` 本身就是前端认识的 code，所以直接透传。不转的话浏览器只能拿到
 * 一个没有 code 的 500，前端就退回到「HEVC 不兼容」的错文案——正是 P0-5 要修的缺陷。
 */
function rethrowPlaybackError(error: unknown): never {
  if (error instanceof PlaybackUnavailableError) {
    throw new MediaError(error.reason, error.message);
  }
  throw error;
}

@Controller('api')
export class MediaController {
  constructor(
    private readonly playback: PlaybackService,
    private readonly cache: MediaCacheService,
    private readonly ranges: MediaRange,
  ) {}

  /** 解析播放信息，并把 `PlaybackUnavailableError` 翻成带 `code` 的响应。 */
  private async resolvePlayback(episodeId: string, definition?: string): Promise<ResolvedPlayback> {
    return this.playback.resolve(episodeId, definition).catch(rethrowPlaybackError);
  }

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
    const resolved = await this.resolvePlayback(id, query.definition);
    const stream = resolved.stream;
    const duration = resolved.playback.duration_seconds;

    return {
      episodeId: id,
      streamUrl: mediaUrl(id, stream.definition),
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
    @Query(new ZodValidationPipe(PlaybackQuerySchema)) query: PlaybackQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // 解析 + 下载 + 解密 + 落盘全部在写响应头之前完成（见 `MediaCacheService.produce`
    // 的约束注释）。任何一步失败都在这里抛出，浏览器拿到的是错误状态码而不是
    // 一个开头正常、中途断掉的 200/206。
    const resolved = await this.resolvePlayback(episodeId, query.definition);
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
  async head(
    @Param('episodeId') episodeId: string,
    @Query(new ZodValidationPipe(PlaybackQuerySchema)) query: PlaybackQuery,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const resolved = await this.resolvePlayback(episodeId, query.definition);
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
