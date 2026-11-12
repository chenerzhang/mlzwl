import { Injectable, Logger } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';
import { deriveContentKey, type ContentKey } from '@mlzwl/hongguo-shared';
import type { Transport, TransportRequest, TransportResponse } from 'openhongguo';
import type { UpstreamSprite } from '../cover/sprite-cache.service.js';

/** 从 `video_model` 响应里抽出来的原始材料。**不得离开服务端**。 */
export interface VideoModelData {
  /** base64 的 `encrypt_info.spade_a`。能推出内容密钥，按密钥对待。 */
  spadeA?: string;
  /** 雪碧图的原始结构。 */
  sprite?: UpstreamSprite;
  /** 上游 video id，雪碧图缓存键。 */
  videoId?: string;
  /** 视频时长（秒）。 */
  durationSeconds?: number;
}

/**
 * 捕获上游 `video_model` 响应里的原始材料。
 *
 * 为什么需要：SDK 的 `resolvePlayback` 只返回整理过的 `PlaybackResult`，
 * 不含 `spade_a`，也不含 `big_thumbs`。这两样都要从同一份原始响应里取：
 *
 * - `spade_a`：SDK 的密钥推导失败时用本地实现兜底。
 * - `big_thumbs`：进度条雪碧图，SDK 完全没暴露。
 *
 * 捕获是**短期**的：取走即删，避免内存里长期堆着密钥材料。
 */
interface CapturedEntry {
  data: VideoModelData;
  capturedAt: number;
}

export const VIDEO_MODEL_CAPTURE_TTL_MS = 5 * 60 * 1000;
export const VIDEO_MODEL_CAPTURE_MAX_ENTRIES = 100;

@Injectable()
export class VideoModelCapture {
  private readonly logger = new Logger(VideoModelCapture.name);
  private readonly captured = new Map<string, CapturedEntry>();

  /** 包一层 transport，顺手记录原始材料。 */
  wrap(inner: Transport): Transport {
    return async (request: TransportRequest): Promise<TransportResponse> => {
      const response = await inner(request);
      try {
        this.inspect(request, response);
      } catch (error) {
        // 捕获失败不能影响正常播放：SDK 的返回值才是主路径。
        this.logger.debug(`video_model capture skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
      return response;
    };
  }

  /** 取走某个 id 的捕获，并按对象身份清掉全部别名。 */
  take(id: string): VideoModelData | undefined {
    this.evictExpired();
    const entry = this.captured.get(id);
    if (entry !== undefined) {
      this.deleteAliases(entry);
    }
    return entry?.data;
  }

  /** SDK 已给出有效密钥时，只清除密钥材料，保留雪碧图元数据。 */
  clearKey(id: string): void {
    this.evictExpired();
    const entry = this.captured.get(id);
    if (entry !== undefined) {
      delete entry.data.spadeA;
    }
  }

  /** 用捕获到的材料推导内容密钥；成功与失败都不再保留 spadeA。 */
  takeKey(id: string): ContentKey | undefined {
    this.evictExpired();
    const capture = this.captured.get(id)?.data;
    if (capture === undefined) {
      return undefined;
    }
    const spadeA = capture.spadeA;
    if (spadeA === undefined) {
      return undefined;
    }
    delete capture.spadeA;
    try {
      return deriveContentKey(spadeA);
    } catch (error) {
      this.logger.warn(`spade fallback failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private inspect(request: TransportRequest, response: TransportResponse): void {
    if (!request.url.includes('/novel/player/video_model/')) {
      return;
    }
    const body = decodeBody(response);
    if (body === null) {
      return;
    }

    const parsed: unknown = JSON.parse(body);
    const model = readVideoModel(parsed);
    if (model === null) {
      return;
    }

    const capture: VideoModelData = {};
    const spadeA = readSpadeA(model);
    if (spadeA !== undefined) {
      capture.spadeA = spadeA;
    }
    const sprite = readSprite(model);
    if (sprite !== undefined) {
      capture.sprite = sprite;
    }
    const videoId = readString(model, ['video_id']);
    if (videoId !== undefined) {
      capture.videoId = videoId;
    }
    const durationSeconds = readNumber(model, ['video_duration']);
    if (durationSeconds !== undefined) {
      capture.durationSeconds = durationSeconds;
    }
    if (Object.keys(capture).length === 0) {
      return;
    }

    // 实测请求体的 video_id 与 episode_id 相同，但不保证永远相同，两个键都存。
    const keys = new Set<string>();
    const fromRequest = readRequestVideoId(request);
    if (fromRequest !== undefined) {
      keys.add(fromRequest);
    }
    const fromResponse = readString(model, ['episode_id']);
    if (fromResponse !== undefined) {
      keys.add(fromResponse);
    }
    const entry: CapturedEntry = { data: capture, capturedAt: Date.now() };
    this.evictExpired();
    for (const key of keys) {
      this.captured.set(key, entry);
    }
    this.evictOverflow();
  }

  private evictExpired(): void {
    const cutoff = Date.now() - VIDEO_MODEL_CAPTURE_TTL_MS;
    const expired = new Set<CapturedEntry>();
    for (const entry of this.captured.values()) {
      if (entry.capturedAt <= cutoff) {
        expired.add(entry);
      }
    }
    for (const entry of expired) {
      this.deleteAliases(entry);
    }
  }

  private evictOverflow(): void {
    const entries = [...new Set(this.captured.values())].sort((a, b) => a.capturedAt - b.capturedAt);
    while (entries.length > VIDEO_MODEL_CAPTURE_MAX_ENTRIES) {
      const oldest = entries.shift();
      if (oldest !== undefined) {
        this.deleteAliases(oldest);
      }
    }
  }

  private deleteAliases(target: CapturedEntry): void {
    for (const [key, entry] of this.captured) {
      if (entry === target) {
        this.captured.delete(key);
      }
    }
  }
}

function decodeBody(response: TransportResponse): string | null {
  let bytes = Buffer.from(response.body);
  if (bytes.length === 0) {
    return null;
  }
  const encoding = response.headers['content-encoding'] ?? response.headers['Content-Encoding'] ?? '';
  if (encoding.includes('gzip') || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      return null;
    }
  }
  return bytes.toString('utf8');
}

function readRequestVideoId(request: TransportRequest): string | undefined {
  if (request.body.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(request.body).toString('utf8'));
    return readString(parsed, ['video_id']);
  } catch {
    return undefined;
  }
}

/**
 * 取出 `data.video_model`。
 *
 * 注意它是**字符串化的 JSON**，不是对象。上游这么嵌套是为了让外层解析器
 * 不关心它的结构。
 */
function readVideoModel(payload: unknown): unknown {
  const raw = readPath(payload, ['data', 'video_model']);
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 同一集的所有清晰度共用一把密钥，取第一个非空值即可（已实测）。 */
function readSpadeA(model: unknown): string | undefined {
  const videoList = readPath(model, ['video_list']);
  if (!Array.isArray(videoList)) {
    return undefined;
  }
  for (const entry of videoList) {
    const spadeA = readString(entry, ['encrypt_info', 'spade_a']);
    if (spadeA !== undefined && spadeA.length > 0) {
      return spadeA;
    }
  }
  return undefined;
}

/**
 * 读 `big_thumbs[0]`。
 *
 * 字段名是蛇形：`img_num`、`img_x_len`、`img_y_len`、`img_x_size`、`img_y_size`、
 * `interval`、`img_urls`。`img_urls` 是数组，可能有 1–6 张。
 */
function readSprite(model: unknown): UpstreamSprite | undefined {
  const thumbs = readPath(model, ['big_thumbs']);
  if (!Array.isArray(thumbs)) {
    return undefined;
  }
  const first: unknown = thumbs[0];
  if (typeof first !== 'object' || first === null) {
    return undefined;
  }

  const imgNum = readNumber(first, ['img_num']);
  const gridX = readNumber(first, ['img_x_len']);
  const gridY = readNumber(first, ['img_y_len']);
  const cellWidth = readNumber(first, ['img_x_size']);
  const cellHeight = readNumber(first, ['img_y_size']);
  const interval = readNumber(first, ['interval']);
  const urlsRaw = readPath(first, ['img_urls']);
  if (imgNum === undefined || gridX === undefined || gridY === undefined) {
    return undefined;
  }
  if (cellWidth === undefined || cellHeight === undefined || interval === undefined) {
    return undefined;
  }
  if (!Array.isArray(urlsRaw)) {
    return undefined;
  }
  const urls = urlsRaw.filter((url): url is string => typeof url === 'string' && url.length > 0);
  if (urls.length === 0) {
    return undefined;
  }

  return { imgNum, gridX, gridY, cellWidth, cellHeight, interval, urls };
}

function readString(value: unknown, path: readonly string[]): string | undefined {
  const found = readPath(value, path);
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}

function readNumber(value: unknown, path: readonly string[]): number | undefined {
  const found = readPath(value, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : undefined;
}

/** 逐层读取路径，任一层不是对象或缺失就返回 undefined。 */
function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
