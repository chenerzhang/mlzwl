import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import heicConvert from 'heic-convert';
import sharp from 'sharp';
import { CONFIG, type Config } from '../config/config.js';

/**
 * 封面代理。
 *
 * 上游封面是 HEIC（`.heic`），浏览器普遍不支持，且 URL 带签名会过期。这里做三件事：
 * 1. 只允许白名单域名，避免变成任意 URL 代理。
 * 2. HEIC → JPEG，可选缩放。
 * 3. 按原始 URL 的哈希缓存到磁盘，转一次全体复用。
 *
 * `sharp` **不能**读 HEIC（实测报 `bad seek`），必须先过 `heic-convert`。
 */
@Injectable()
export class CoverProxyService {
  /**
   * 允许的封面域名后缀。
   *
   * 上游 CDN 用多个子域且会变（实测出现过 p3-reading-sign、p9-reading-sign、
   * p6-novel、p5-ex-gddgtc-sign）。写死具体主机名会静默失效，所以按后缀放行。
   *
   * 只放行字节的图片 CDN。不要加通配的「任意域名」，否则这里就变成开放代理。
   */
  private readonly allowedSuffixes = ['.fqnovelpic.com', '.byteimg.com', '.douyinpic.com', '.bytedance.com'] as const;
  /** 同一 URL 的并发请求只转一次。 */
  private readonly inflight = new Map<string, Promise<Buffer>>();

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  /**
   * 把上游封面地址改写成本服务的代理地址。
   *
   * 返回相对路径而不是绝对地址：前端可能部署在不同 origin，绝对地址会写错。
   */
  proxyUrl(upstream: string): string {
    return `/api/cover?u=${encodeURIComponent(upstream)}`;
  }

  /** 域名白名单。非白名单一律拒绝，不提供「任意 URL 代理」能力。 */
  isAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      return this.allowedSuffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
    } catch {
      return false;
    }
  }

  /**
   * 取得可发送给浏览器的 JPEG 字节。
   *
   * @param url 上游封面地址（必须过白名单）。
   * @param width 目标宽度；`undefined` 表示保持原尺寸。
   */
  async fetchJpeg(url: string, width?: number): Promise<{ buffer: Buffer; contentType: string }> {
    if (!this.isAllowed(url)) {
      throw new Error(`cover host not allowed: ${safeHost(url)}`);
    }

    const key = `${createHash('sha256').update(url).digest('hex')}${width === undefined ? '' : `-w${width}`}`;
    const dir = join(this.config.DATA_DIR, 'covers');
    const file = join(dir, `${key}.jpg`);

    const cached = await readFile(file).catch(() => null);
    if (cached !== null) {
      return { buffer: cached, contentType: 'image/jpeg' };
    }

    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      return { buffer: await pending, contentType: 'image/jpeg' };
    }

    const task = this.produce(url, width, dir, file);
    this.inflight.set(key, task);
    try {
      return { buffer: await task, contentType: 'image/jpeg' };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async produce(url: string, width: number | undefined, dir: string, file: string): Promise<Buffer> {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`cover fetch failed: HTTP ${response.status}`);
    }
    const source = Buffer.from(await response.arrayBuffer());

    // 已经是 JPEG 且不需要缩放时直接缓存，省一次编解码。
    const isHeic = looksLikeHeic(source);
    let jpeg: Buffer;
    if (isHeic) {
      jpeg = Buffer.from(await heicConvert({ buffer: source, format: 'JPEG', quality: 0.85 }));
    } else if (width === undefined) {
      jpeg = source;
    } else {
      jpeg = source;
    }

    const output =
      width === undefined
        ? jpeg
        : await sharp(jpeg).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();

    await mkdir(dir, { recursive: true });
    await writeFile(file, output);
    return output;
  }

  /** 缓存目录占用，便于运维观察。 */
  async cacheSize(): Promise<number> {
    const dir = join(this.config.DATA_DIR, 'covers');
    const stats = await stat(dir).catch(() => null);
    return stats === null ? 0 : stats.size;
  }
}

/**
 * 判断是否是 HEIC/HEIF。
 *
 * ISO-BMFF 的 `ftyp` box 在偏移 4，brand 在偏移 8。`heic`/`heix`/`mif1`/`msf1`
 * 都可能是 HEIC 变体。
 */
function looksLikeHeic(buf: Buffer): boolean {
  if (buf.length < 12) {
    return false;
  }
  if (buf.toString('latin1', 4, 8) !== 'ftyp') {
    return false;
  }
  const brand = buf.toString('latin1', 8, 12);
  return brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'mif1' || brand === 'msf1';
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid url)';
  }
}
