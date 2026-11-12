import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
/**
 * 封面缓存的文件数上限。
 *
 * 与 `hongguoTV` 的 `ArtworkCache.kt` 对齐（≤ 100 个文件、≤ 24 MB 总量）：一部剧
 * 的封面加上首页几十部，100 个足够覆盖实际浏览面，超出说明是签名 URL 变化产生的
 * 重复副本，留着只是占盘。
 */
export const COVER_MAX_FILES = 100;

/**
 * 封面缓存的总字节上限（24 MB）。
 *
 * 同样对齐 `ArtworkCache.kt`。单个封面 50–300 KB，100 个文件通常只有 10–20 MB，
 * 所以这个上限主要挡「某些封面特别大」的极端情况。
 */
export const COVER_MAX_BYTES = 24 * 1024 * 1024;

/**
 * 单个封面下载的字节上限（8 MB）。
 *
 * 实测封面 50–300 KB，HEIC 原图也很少超 1 MB。8 MB 足够覆盖异常大的原图，
 * 又能挡住「上游返回一个巨大响应」把进程内存吃满。
 */
export const COVER_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

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
      // 带凭据的 URL 一律拒：封面 CDN 不需要认证，出现 `user:pass@` 只可能是探测。
      // 而且 `fetch` 会把凭据编成 `Authorization` 头发出去，等于把本机拼进去的东西漏给上游。
      if (parsed.username !== '' || parsed.password !== '') {
        return false;
      }
      const host = parsed.hostname.toLowerCase();
      if (!this.allowedSuffixes.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
        return false;
      }
      return !isPrivateHost(host);
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
      throw new CoverUrlRejectedError(`cover host not allowed: ${safeHost(url)}`);
    }

    const key = `${createHash('sha256').update(url).digest('hex')}${width === undefined ? '' : `-w${width}`}`;
    const dir = join(this.config.DATA_DIR, 'covers');
    const file = join(dir, `${key}.jpg`);

    const cached = await readFile(file).catch(() => null);
    if (cached !== null) {
      // 触碰 mtime：LRU 与过期都以 mtime 为准，命中不更新会让「还在用」的封面被删掉。
      const now = new Date();
      await utimes(file, now, now).catch(() => undefined);
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
    // `redirect: 'error'` 而不是 `'follow'`：白名单只校验了第一次请求的 URL，
    // 跟随重定向等于让上游 CDN 指定最终目标，可以绕过白名单与私网检查。
    // 封面 CDN 实测不重定向；真遇到重定向就失败，比默默代理一个未知地址安全。
    const response = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`cover fetch failed: HTTP ${response.status}`);
    }

    // 先按 `content-length` 预判，再逐块累计。不能直接 `arrayBuffer()`：
    // 声明长度可以造假，必须在读的过程中也设上限，否则一个恶意响应能把进程内存吃满。
    const declared = Number(response.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > COVER_MAX_SOURCE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`cover too large: ${declared} bytes`);
    }
    const source = await readBodyWithLimit(response, COVER_MAX_SOURCE_BYTES);
    // 空响应必须报错，不能当 JPEG 写盘：`looksLikeHeic` 对 <12 字节返回 false，
    // 后面的分支会把 0 字节 buffer 直接写进缓存，于是这个坏图会一直返回到过期。
    if (source.length === 0) {
      throw new Error('cover fetch returned an empty body');
    }

    // 已经是 JPEG 且不需要缩放时直接缓存，省一次编解码。
    const isHeic = looksLikeHeic(source);
    let jpeg: Buffer;
    if (isHeic) {
      jpeg = Buffer.from(await heicConvert({ buffer: source, format: 'JPEG', quality: 0.85 }));
    } else {
      jpeg = source;
    }

    const output =
      width === undefined
        ? jpeg
        : await sharp(jpeg).resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();

    await mkdir(dir, { recursive: true });
    await writeFile(file, output);
    // 修剪是副作用，不是写入的前提：清理失败（权限、文件被占用、目录被并发删）
    // 不能让已经写成功的封面变成请求失败。上限失效只意味着多占盘，下次写再修。
    await this.evict(dir).catch(() => undefined);
    return output;
  }

  /**
   * 修剪封面缓存：先按天数过期，再按 mtime 从旧到新删到两条上限以内。
   *
   * 写入后调用（`ArtworkCache.kt` 的做法）：请求路径上不需要定期任务，写一次就
   * 顺手修剪一次，成本是一次 `readdir` + 每个文件的 `stat`。
   *
   * 两条规则有先后：过期优先，因为它们无论如何都不该留；剩下的再按容量淘汰，
   * 这样「总数没超但有一堆陈旧文件」的情况也能被清掉。
   */
  private async evict(dir: string): Promise<void> {
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.jpg'));
    if (names.length === 0) {
      return;
    }

    const entries: Array<{ file: string; mtime: number; size: number }> = [];
    for (const name of names) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (info === null) {
        continue;
      }
      entries.push({ file: path, mtime: info.mtimeMs, size: info.size });
    }

    const expiredBefore = Date.now() - this.config.COVER_KEEP_DAYS * 24 * 60 * 60 * 1000;
    const expired = entries.filter((entry) => entry.mtime < expiredBefore);
    await Promise.all(expired.map((entry) => rm(entry.file, { force: true })));

    const alive = entries.filter((entry) => entry.mtime >= expiredBefore);
    alive.sort((a, b) => a.mtime - b.mtime);
    let totalBytes = alive.reduce((sum, entry) => sum + entry.size, 0);
    let fileCount = alive.length;
    let index = 0;
    while (index < alive.length && (fileCount > COVER_MAX_FILES || totalBytes > COVER_MAX_BYTES)) {
      const victim = alive[index];
      index += 1;
      if (victim === undefined) {
        break;
      }
      await rm(victim.file, { force: true });
      totalBytes -= victim.size;
      fileCount -= 1;
    }
  }
}

/**
 * 判断主机名是否属于私网、回环、链路本地或保留地址。
 *
 * 只看**字面主机名**，不做 DNS 解析。理由：
 * 1. 白名单已经限定到字节的图片 CDN 后缀，DNS 解析结果必然在这些域名下；
 * 2. 在请求路径上做一次 DNS 查询会多一次往返，而且解析结果与 `fetch` 实际用的
 *    地址之间还有 TOCTOU 窗口，挡不住真正的 DNS rebinding。
 *
 * 这一层的实际作用是把「字面写成 IP 的探测请求」挡在外面。
 *
 */
export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare.includes(':')) {
    const groups = parseIpv6(bare);
    if (groups === null) {
      return false;
    }
    const first = groups[0] ?? 0;
    // 未指定、回环、unique-local、链路本地及已废弃的 site-local。
    if (
      groups.every((group) => group === 0) ||
      (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xffc0) === 0xfec0
    ) {
      return true;
    }
    // 64:ff9b::/96（NAT64 well-known prefix）。
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
      return true;
    }
    // ::ffff:0:0/96：把最后 32 位按 IPv4 再过一遍保留地址规则。
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return isPrivateIpv4([
        (groups[6] ?? 0) >> 8,
        (groups[6] ?? 0) & 0xff,
        (groups[7] ?? 0) >> 8,
        (groups[7] ?? 0) & 0xff,
      ]);
    }
    return false;
  }

  const octets = parseIpv4(bare);
  return octets === null ? false : isPrivateIpv4(octets);
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function parseIpv6(host: string): number[] | null {
  let normalized = host;
  const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)?.[1];
  if (dotted !== undefined) {
    const octets = parseIpv4(dotted);
    if (octets === null) {
      return null;
    }
    const replacement = `${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
    normalized = `${host.slice(0, -dotted.length)}${replacement}`;
  }
  if ((normalized.match(/::/g) ?? []).length > 1) {
    return null;
  }
  const [leftRaw, rightRaw] = normalized.split('::');
  const left = leftRaw === '' || leftRaw === undefined ? [] : leftRaw.split(':');
  const right = rightRaw === '' || rightRaw === undefined ? [] : rightRaw.split(':');
  const missing = 8 - left.length - right.length;
  if ((rightRaw === undefined && missing !== 0) || (rightRaw !== undefined && missing < 1)) {
    return null;
  }
  const rawGroups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (rawGroups.length !== 8 || !rawGroups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return rawGroups.map((group) => Number.parseInt(group, 16));
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && (b === 168 || (b === 0 && c <= 0xff))) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true;
  }
  return a >= 224;
}

/**
 * 逐块读取响应体，超过 `limit` 立即中止。
 *
 * 不能先 `arrayBuffer()` 再量长度：那一步已经把整个响应读进内存了，
 * 上限只会在内存被吃满之后才生效。
 */
async function readBodyWithLimit(response: Response, limit: number): Promise<Buffer> {
  const body = response.body;
  if (body === null) {
    return Buffer.alloc(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`cover too large: over ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** 地址不合法（非白名单、带凭据、私网）。与上游拉取失败分开，控制器据此返回 400。 */
export class CoverUrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverUrlRejectedError';
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
