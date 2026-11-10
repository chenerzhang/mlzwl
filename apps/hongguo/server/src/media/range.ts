import { Injectable, Logger } from '@nestjs/common';

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * 解析 `Range: bytes=...` 请求头。
 *
 * 只支持单段 Range。浏览器播放视频只会发单段，多段（`bytes=0-99,200-299`）在
 * 实践中几乎不出现，且 RFC 允许服务端忽略多段请求返回整个文件。
 *
 * @returns `null` 表示 Range 不合法，应返回 416。
 */
export function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (match?.[1] === undefined) {
    return null;
  }

  const spec = match[1].trim();
  if (spec.includes(',')) {
    return null;
  }

  const parts = spec.split('-');
  if (parts.length !== 2) {
    return null;
  }
  const [rawStart, rawEnd] = parts;
  if (rawStart === undefined || rawEnd === undefined) {
    return null;
  }

  if (rawStart === '') {
    // `bytes=-500`：最后 500 字节。
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return null;
    }
    const start = Math.max(0, size - suffix);
    return { start, end: size - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) {
    return null;
  }

  if (rawEnd === '') {
    return { start, end: size - 1 };
  }

  const end = Number.parseInt(rawEnd, 10);
  if (!Number.isFinite(end) || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

/** Range 响应头。 */
export function rangeHeaders(range: ByteRange, size: number, contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-length': String(range.end - range.start + 1),
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'accept-ranges': 'bytes',
  };
}

@Injectable()
export class MediaRange {
  private readonly logger = new Logger(MediaRange.name);

  parse(header: string | undefined, size: number): ByteRange | null {
    if (header === undefined) {
      return null;
    }
    const range = parseRange(header, size);
    if (range === null) {
      this.logger.debug(`rejected range header: ${header} (size ${size})`);
    }
    return range;
  }
}
