import { Injectable } from '@nestjs/common';
import type { ContentKey } from '@mlzwl/hongguo-shared';
import type { Client, PlaybackResult, Stream } from 'openhongguo';
import { HongguoService } from '../hongguo/hongguo.service.js';
import { VideoModelCapture } from './video-model-capture.service.js';

/** 解析结果，含内容密钥。**密钥不得离开服务端**。 */
export interface ResolvedPlayback {
  playback: PlaybackResult['playback'];
  key: ContentKey;
  /** 选定的流。 */
  stream: Stream;
  /** 该集所有可用清晰度，从低到高。 */
  availableDefinitions: string[];
}

export class PlaybackUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'no_stream' | 'not_encrypted' | 'key_unavailable',
  ) {
    super(message);
    this.name = 'PlaybackUnavailableError';
  }
}

/** 清晰度排序：把 "1080p" 这类标签转成数字。 */
function resolutionOf(stream: Stream): number {
  if (stream.height !== undefined && stream.height > 0) {
    return stream.height;
  }
  const match = /^(\d{3,4})p$/.exec(stream.definition ?? '');
  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

@Injectable()
export class PlaybackService {
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

    const stream = pickStream(playable, preferredDefinition);
    if (stream === undefined) {
      throw new PlaybackUnavailableError('no matching stream', 'no_stream');
    }

    const key = this.resolveKey(result, stream);
    return {
      playback: result.playback,
      key,
      stream,
      availableDefinitions: [...new Set(playable.map((item) => item.definition ?? 'unknown'))],
    };
  }

  private resolveKey(result: PlaybackResult, stream: Stream): ContentKey {
    const fromSdk = result.contentKey;
    if (fromSdk !== undefined && /^[0-9a-f]{32}$/i.test(fromSdk.key)) {
      return { key: fromSdk.key.toLowerCase(), version: fromSdk.version ?? '1' };
    }

    // SDK 推导失败时用本地 spade 实现兜底。capture 里存的是同一份响应里的
    // spade_a，所以两条路得到的是同一个密钥。
    const fallback = this.capture.takeKey(result.playback.episode_id);
    if (fallback !== undefined) {
      return fallback;
    }

    const failure = result.contentKeyError;
    throw new PlaybackUnavailableError(
      `content key unavailable (${failure?.code ?? 'unknown'}: ${failure?.message ?? 'no key'}, protected=${String(stream.protected)})`,
      'key_unavailable',
    );
  }
}

/** 按偏好挑一档；没有偏好时挑 720p，没有 720p 就挑中间那档。 */
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
