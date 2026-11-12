import { HttpException } from '@nestjs/common';
import type { MediaErrorCode } from '@mlzwl/hongguo-shared';
import { redact } from '../common/redact.js';

/** 每个错误码对应的 HTTP 状态码。集中一处，避免各处各写一套。 */
const STATUS_BY_CODE: Record<MediaErrorCode, number> = {
  // 剧集层面的确定性失败：重试也拿不到。
  no_stream: 404,
  not_encrypted: 404,
  // 档位不存在是**调用方指定了不存在的档**，属于请求问题。
  definition_unavailable: 400,
  // 密钥来自上游，拿不到算上游问题。
  key_unavailable: 502,
  media_timeout: 504,
  // 上游给出的响应不可用，统一算上游错误（502）而不是本服务的 500。
  media_upstream_4xx: 502,
  media_upstream_5xx: 502,
  media_too_large: 502,
  media_not_video: 502,
  // 上游字节正常但解不开，是本服务的解析问题。
  decrypt_failed: 500,
};

/**
 * 带稳定 `code` 的媒体错误。
 *
 * Nest 会把构造参数里的对象原样作为响应体，所以前端拿到的就是
 * `{ code, message }`，可以直接 `JSON.parse` 后取 `code` 选文案。
 *
 * `message` 在构造时统一过 `redact`：这是所有回浏览器的媒体错误唯一的必经之路，
 * 把脱敏放在这里，就不必指望每个构造点都记得处理上游字符串。`redact` 幂等，
 * 调用方提前脱敏也不会被二次改写。
 */
export class MediaError extends HttpException {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    status: number = MediaError.statusFor(code),
  ) {
    super({ code, message: redact(message) }, status);
    this.name = 'MediaError';
  }

  /** 状态码映射的唯一入口；构造时默认取它。 */
  static statusFor(code: MediaErrorCode): number {
    return STATUS_BY_CODE[code];
  }
}
