import { Injectable, Logger } from '@nestjs/common';
import type { ContentKey } from '@mlzwl/hongguo-shared';
import type { Client, PlaybackResult, Stream } from 'openhongguo';
import { redact } from '../common/redact.js';
import { HongguoService } from '../hongguo/hongguo.service.js';
import { VideoModelCapture } from './video-model-capture.service.js';

/** 解析结果，含内容密钥。**密钥不得离开服务端**。 */
export interface ResolvedPlayback {
  playback: PlaybackResult['playback'];
  key: ContentKey;
  /** 选定的流。 */
  stream: Stream;
  /**
   * 可下载的地址，主地址在前、`backup_url` 在后，已去重。
   *
   * 单独给一份数组而不是让下载层自己拼：去重规则只写一次，下载层不必知道
   * `backup_url` 这个字段名。`stream.url` 保持原样，其它地方可能在用。
   */
  urls: string[];
  /** 该集所有可用清晰度，从低到高。 */
  availableDefinitions: string[];
}

export class PlaybackUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'no_stream' | 'not_encrypted' | 'key_unavailable' | 'definition_unavailable',
  ) {
    // 这条 message 经 `MediaController` 变成响应体回到浏览器。构造点分散，
    // 统一在这里过一道 `redact`，避免以后有人顺手把上游字符串拼进来。
    super(redact(message));
    this.name = 'PlaybackUnavailableError';
  }
}

/**
 * 同一文件的候选地址：主地址在前，`backup_url` 在后，去空去重。
 *
 * 上游把备用地址注释为「同一文件的第二个 CDN 地址」，所以两个地址的字节应当
 * 完全一致。这也是「写响应头之前完成下载」这条约束的前提（见 `MediaCacheService`）。
 */
export function streamUrls(stream: Stream): string[] {
  const candidates = [stream.url, stream.backup_url];
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && !urls.includes(candidate)) {
      urls.push(candidate);
    }
  }
  return urls;
}

/**
 * 清晰度排序键：取**短边**像素数。
 *
 * 为什么不能用 `height`：竖屏短剧是 540×960。按 `height` 排序会把 540p 当成 960，
 * 判定为高于 720p，于是默认选档与"可用清晰度从低到高"的排序同时出错。
 * 取 `min(width, height)` 后，横屏 1280×720 与竖屏 540×960 都归到 720 与 540。
 *
 * 只有一个维度时用它，但这种情况说明上游字段不全，`pickStream` 会记一条 warn。
 */
export function resolutionOf(stream: Stream): number {
  const width = stream.width !== undefined && stream.width > 0 ? stream.width : undefined;
  const height = stream.height !== undefined && stream.height > 0 ? stream.height : undefined;
  if (width !== undefined && height !== undefined) {
    return Math.min(width, height);
  }
  if (width !== undefined) {
    return width;
  }
  if (height !== undefined) {
    return height;
  }
  const match = /^(\d{3,4})p$/.exec(stream.definition ?? '');
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

@Injectable()
export class PlaybackService {
  private readonly logger = new Logger(PlaybackService.name);

  constructor(
    private readonly hongguo: HongguoService,
    private readonly capture: VideoModelCapture,
  ) {}

  /**
   * 解析一集的播放信息。
   *
   * 密钥优先用 SDK 的 `contentKey`，失败时用本地 spade 实现兜底——两条路都验证过
   * 会得到同一个值，多一条路能在 SDK 升级出错时继续工作。
   */
  async resolve(episodeId: string, preferredDefinition?: string): Promise<ResolvedPlayback> {
    const client: Client = await this.hongguo.getClient();
    const result = await client.resolvePlayback(episodeId);

    const playable = result.playback.streams.filter((stream) => stream.url !== undefined && stream.url !== '');
    if (playable.length === 0) {
      throw new PlaybackUnavailableError('episode has no stream URL', 'no_stream');
    }

    // 显式指定档位时必须精确命中：`pickStream` 在匹配不到时会静默回退到 720p
    // 或中间档。那会让「选了 1080p」变成「实际 720p」，而下载文件名仍写着
    // `-1080p.mp4`。可用档位是**逐集**算的，别的集有 1080p 不代表这一集有。
    if (preferredDefinition !== undefined && !playable.some((item) => item.definition === preferredDefinition)) {
      throw new PlaybackUnavailableError(
        `definition ${preferredDefinition} is not available for this episode`,
        'definition_unavailable',
      );
    }
    const stream = pickStream(playable, preferredDefinition);
    if (stream === undefined) {
      throw new PlaybackUnavailableError('no matching stream', 'no_stream');
    }
    this.warnOnIncompleteDimensions(playable);

    const key = this.resolveKey(result, stream);
    return {
      playback: result.playback,
      key,
      stream,
      urls: streamUrls(stream),
      // 按短边从低到高排序，与 `pickStream` 的判定口径一致。
      availableDefinitions: [...playable]
        .sort((a, b) => resolutionOf(a) - resolutionOf(b))
        .map((item) => item.definition ?? 'unknown')
        .filter((definition, index, all) => all.indexOf(definition) === index),
    };
  }

  /**
   * 缺 `width` 或 `height` 时记一条 warn。
   *
   * 这不影响选档（会退回按单一维度或 `definition` 数字判断），但说明上游字段
   * 变了。留一条日志，比等用户报"清晰度不对"再回头查要省事。
   */
  private warnOnIncompleteDimensions(streams: readonly Stream[]): void {
    const incomplete = streams.filter((stream) => stream.width === undefined || stream.height === undefined);
    if (incomplete.length === 0) {
      return;
    }
    this.logger.warn(
      `stream dimensions incomplete for ${incomplete.length}/${streams.length} streams ` +
        `(${incomplete.map((stream) => stream.definition ?? '?').join(',')}); resolution falls back to one axis or label`,
    );
  }

  private resolveKey(result: PlaybackResult, stream: Stream): ContentKey {
    const fromSdk = result.contentKey;
    if (fromSdk !== undefined && /^[0-9a-f]{32}$/i.test(fromSdk.key)) {
      this.capture.clearKey(result.playback.episode_id);
      return { key: fromSdk.key.toLowerCase(), version: fromSdk.version ?? '1' };
    }

    // SDK 推导失败时用本地 spade 实现兜底。capture 里存的是同一份响应里的
    // spade_a，所以两条路得到的是同一个密钥。
    const fallback = this.capture.takeKey(result.playback.episode_id);
    if (fallback !== undefined) {
      return fallback;
    }

    const failure = result.contentKeyError;
    // 只透传 SDK 的错误码，不透传 `failure.message`：那个字符串来自上游响应，
    // 可能带地址或其它凭证，而这条 message 会经 `MediaError` 回到浏览器。
    throw new PlaybackUnavailableError(
      `content key unavailable (${failure?.code ?? 'unknown'}, protected=${String(stream.protected)})`,
      'key_unavailable',
    );
  }
}

/**
 * 按偏好挑一档。
 *
 * 优先级：`preferredDefinition` 精确匹配 → 短边为 720 的档 → 中间那档。
 * "中间"用 `Math.floor((len - 1) / 2)` 而不是 `len / 2`：两档时取较低档，
 * 避免在弱网下默认选高的那一档。
 */
export function pickStream(streams: readonly Stream[], preferredDefinition?: string): Stream | undefined {
  if (streams.length === 0) {
    return undefined;
  }
  if (preferredDefinition !== undefined) {
    const exact = streams.find((stream) => stream.definition === preferredDefinition);
    if (exact !== undefined) {
      return exact;
    }
  }
  const sorted = [...streams].sort((a, b) => resolutionOf(a) - resolutionOf(b));
  const at720 = sorted.find((stream) => resolutionOf(stream) === 720);
  if (at720 !== undefined) {
    return at720;
  }
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
