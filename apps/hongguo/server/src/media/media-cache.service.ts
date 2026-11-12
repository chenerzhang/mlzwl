import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MediaErrorCode } from '@mlzwl/hongguo-shared';
import { Mp4ParseError } from '@mlzwl/hongguo-shared';
import { CencError, decryptCenc } from './cenc.js';
import { MediaError } from './media.error.js';
import { CONFIG, type Config } from '../config/config.js';
import { redact } from '../common/redact.js';
import type { ResolvedPlayback } from './playback.service.js';

export interface CachedMedia {
  file: string;
  /** 解密后字节数（与加密文件相同，但显式记录便于校验）。 */
  size: number;
}

/**
 * 重试退避。长度即**额外尝试次数**：最多 2 次重试。
 * 与计划里 P0-5 的恢复节奏（1000 / 2500 ms）保持一致。
 */
export const MEDIA_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_500];

/** 这几个 4xx 是暂时性的，值得重试；其余 4xx 说明地址本身有问题，立刻放弃。 */
const RETRYABLE_4XX_STATUS: readonly number[] = [408, 429];

export interface MediaDownloadOptions {
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number;
  /** 读流时的硬上限（字节）。 */
  maxBytes: number;
  /** 重试退避（毫秒）。省略时用 `MEDIA_RETRY_DELAYS_MS`；测试可缩短。 */
  retryDelaysMs?: readonly number[];
  /** 每次尝试开始前的回调，供调用方记日志。`attempt` 从 0 开始。 */
  onAttempt?: (info: { url: string; attempt: number }) => void;
}

export interface MediaDownloadResult {
  bytes: Uint8Array;
  /** 命中的地址下标（从 0 开始）。 */
  index: number;
}

/**
 * 把地址压缩成可安全写进日志与错误信息的形态。
 *
 * 上游签名参数在 query 里，整条 URL 进日志等于把临时凭证写进磁盘。但**不能只丢
 * query**：有些 CDN 把 token 放在 path 段里（`/v1/<token>/a.mp4`），所以每个 path
 * 段超过 12 个字符就整个替换成 `***`。文件名（`a.mp4`）保留，它是排障时真正需要的。
 */
export function sanitizeMediaUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .split('/')
      .map((segment) => (segment.length > 12 ? '***' : segment))
      .join('/');
    return `${parsed.host}${path}`.slice(0, 80);
  } catch {
    return '(invalid url)';
  }
}

/** 单次尝试的结果。用返回值而不是异常表达可重试性，避免把重试策略塞进错误对象。 */
type AttemptOutcome = { ok: true; bytes: Uint8Array } | { ok: false; error: MediaError; retryable: boolean };

/**
 * 解密后视频的磁盘缓存。
 *
 * 流程：下载加密 MP4 → 原地解密 → 写盘 → Range 流式返回。没有转码、没有重封装。
 *
 * 关键点：
 * - 按 `episodeId` 缓存。同一集换清晰度会重新下载，但密钥不变。
 * - 同一集的并发请求共享一个 Promise，避免重复下载 15 MB。
 * - LRU 按 mtime 清理，保留 `MEDIA_KEEP` 个（沿用上游 40）。
 * - 主地址失败时按 `backup_url` 重试，但**只在写响应头之前**（见 `produce` 的注释）。
 */
@Injectable()
export class MediaCacheService {
  private readonly logger = new Logger(MediaCacheService.name);
  private readonly inflight = new Map<string, Promise<CachedMedia>>();

  constructor(@Inject(CONFIG) private readonly config: Config) {}

  private get dir(): string {
    return join(this.config.DATA_DIR, 'media');
  }

  /** 缓存文件名包含清晰度：同一集切档后两份文件并存，避免来回重下。 */
  private fileName(episodeId: string, definition: string): string {
    return `${sanitize(episodeId)}-${sanitize(definition)}.mp4`;
  }

  async get(episodeId: string, resolved: ResolvedPlayback): Promise<CachedMedia> {
    const definition = resolved.stream.definition ?? 'default';
    const file = join(this.dir, this.fileName(episodeId, definition));

    const existing = await stat(file).catch(() => null);
    if (existing !== null && existing.size > 0) {
      // 触碰 mtime，让 LRU 认为它刚用过。
      const now = new Date();
      await import('node:fs/promises').then((fs) => fs.utimes(file, now, now)).catch(() => undefined);
      return { file, size: existing.size };
    }

    const key = `${episodeId}-${definition}`;
    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const task = this.produce(episodeId, resolved, file);
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 已缓存则返回路径，不触发下载。用于 controller 快速判断。 */
  async peek(episodeId: string, definition: string): Promise<CachedMedia | null> {
    const file = join(this.dir, this.fileName(episodeId, definition));
    const info = await stat(file).catch(() => null);
    if (info === null || info.size === 0) {
      return null;
    }
    return { file, size: info.size };
  }

  createStream(file: string, start?: number, end?: number): ReturnType<typeof createReadStream> {
    return createReadStream(file, start === undefined ? {} : end === undefined ? { start } : { start, end });
  }

  async readAll(file: string): Promise<Buffer> {
    return readFile(file);
  }

  /**
   * 下载 + 解密 + 落盘。
   *
   * **约束（P0-6）：解析、下载、解密、落盘是一个原子步骤，必须在 `reply.send()`
   * 之前全部完成；不得在已经向浏览器返回字节之后切换源地址。**
   *
   * 原因是 Range 请求：客户端可能已经收到 `bytes=0-1023`，若此时换到备用地址，
   * 新源上的字节偏移与旧源不同（不同 CDN 的容器头大小可能不同），续传拼起来
   * 就是一个损坏的 MP4，播放器只会报「解码失败」，极难定位。所以地址重试只能
   * 发生在这里，`media.controller.ts` 必须 `await cache.get()` 完成后才写响应头。
   */
  private async produce(episodeId: string, resolved: ResolvedPlayback, file: string): Promise<CachedMedia> {
    const urls = resolved.urls;
    if (urls.length === 0) {
      throw new MediaError('no_stream', `episode ${episodeId} has no stream URL`);
    }

    const started = Date.now();
    const { bytes: encrypted, index } = await downloadFromUrls(urls, {
      timeoutMs: this.config.UPSTREAM_TIMEOUT_MS,
      maxBytes: this.config.MEDIA_MAX_BYTES,
      onAttempt: ({ url, attempt }) => {
        this.logger.warn(
          redact(`media download attempt=${attempt + 1} episode=${episodeId} source=${sanitizeMediaUrl(url)}`),
        );
      },
    });
    this.logger.log(
      redact(`media download ok episode=${episodeId} source=${index + 1}/${urls.length} bytes=${encrypted.length}`),
    );
    const downloadedAt = Date.now();

    let decrypted: ReturnType<typeof decryptCenc>;
    try {
      // `onWarn` 让 planTracks 的 codec 回退路径能记进服务端日志。
      // 回退能用，但意味着上游容器变了，值得留一条痕迹。
      decrypted = decryptCenc(encrypted, resolved.key.key, {
        onWarn: (message) => this.logger.warn(redact(`cenc: ${message}`)),
      });
    } catch (error) {
      throw new MediaError('decrypt_failed', `decrypt failed: ${describeDecryptFailure(error)}`);
    }
    const { buffer, tracks } = decrypted;
    const decryptedAt = Date.now();

    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, buffer);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, file);

    this.logger.log(
      redact(
        `media ready episode=${episodeId} def=${resolved.stream.definition ?? '?'} ` +
          `bytes=${buffer.length} download=${downloadedAt - started}ms decrypt=${decryptedAt - downloadedAt}ms ` +
          `tracks=${tracks.map((t) => `${t.clearType}:${t.sampleCount}`).join(',')}`,
      ),
    );

    await this.evict();
    return { file, size: buffer.length };
  }

  /** 按 mtime 清理，保留最新 `MEDIA_KEEP` 个文件。 */
  private async evict(): Promise<void> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const files = entries.filter((name) => name.endsWith('.mp4'));
    if (files.length <= this.config.MEDIA_KEEP) {
      return;
    }

    const stats = await Promise.all(
      files.map(async (name) => {
        const info = await stat(join(this.dir, name)).catch(() => null);
        return { name, mtime: info?.mtimeMs ?? 0 };
      }),
    );
    stats.sort((a, b) => a.mtime - b.mtime);
    const excess = stats.slice(0, stats.length - this.config.MEDIA_KEEP);
    await Promise.all(excess.map((entry) => rm(join(this.dir, entry.name), { force: true })));
    this.logger.log(`evicted ${excess.length} media files (keep ${this.config.MEDIA_KEEP})`);
  }
}

/**
 * 按顺序尝试多个地址（主地址 + `backup_url`）。
 *
 * 每个地址独立超时、独立重试；全部失败时抛聚合错误，message 里列出每个地址的
 * 失败原因（地址已脱敏）。
 */
export async function downloadFromUrls(
  urls: readonly string[],
  options: MediaDownloadOptions,
): Promise<MediaDownloadResult> {
  const failures: Array<{ url: string; error: MediaError }> = [];
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index];
    if (url === undefined) {
      continue;
    }
    try {
      return { bytes: await downloadWithRetry(url, options), index };
    } catch (error) {
      failures.push({ url, error: toMediaError(error, options.timeoutMs) });
    }
  }
  throw aggregateFailure(failures);
}

/** 按一个地址下载，含有限重试。失败抛 `MediaError`。 */
export async function downloadWithRetry(url: string, options: MediaDownloadOptions): Promise<Uint8Array> {
  const delays = options.retryDelaysMs ?? MEDIA_RETRY_DELAYS_MS;
  let lastError: MediaError | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    options.onAttempt?.({ url, attempt });
    const outcome = await attemptDownload(url, options);
    if (outcome.ok) {
      return outcome.bytes;
    }
    lastError = outcome.error;
    const delay = delays[attempt];
    if (!outcome.retryable || delay === undefined) {
      break;
    }
    await sleep(delay);
  }
  throw lastError ?? new MediaError('media_upstream_5xx', 'download failed without a recorded reason');
}

/**
 * 单次下载并校验。
 *
 * 四道校验，顺序按「省一次下载」的成本排：
 * 1. 响应状态码（4xx / 5xx 分类）。
 * 2. `content-type`：上游错误页 / 风控页是 `text/html` 或 `application/json`，
 *    直接喂给 `decryptCenc` 会报出难以理解的解析错误。
 * 3. `content-length`：声明值超限就提前放弃，不浪费带宽。**不能只依赖它**，
 *    上游可以不给或给错。
 * 4. 逐块读流累计字节，超限立即中止。不用 `response.arrayBuffer()`：那会把任意
 *    大小的响应整个读进内存，正是当前缺陷。
 */
async function attemptDownload(url: string, options: MediaDownloadOptions): Promise<AttemptOutcome> {
  const { timeoutMs, maxBytes } = options;
  // 提到外面持有：读流阶段被同一次超时打断时，要靠 `signal.aborted` 才能可靠识别。
  const signal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    // 连接层失败（DNS、拒绝连接、TLS）一律可重试。
    return { ok: false, error: toMediaError(error, timeoutMs, signal), retryable: true };
  }

  if (!response.ok) {
    await cancel(response);
    const retryable = response.status >= 500 || RETRYABLE_4XX_STATUS.includes(response.status);
    const code: MediaErrorCode = response.status >= 500 ? 'media_upstream_5xx' : 'media_upstream_4xx';
    return { ok: false, error: new MediaError(code, `upstream returned HTTP ${response.status}`), retryable };
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    await cancel(response);
    return {
      ok: false,
      error: new MediaError('media_not_video', `upstream returned ${contentType}, not a video`),
      retryable: false,
    };
  }

  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancel(response);
    return {
      ok: false,
      error: new MediaError('media_too_large', `upstream declared ${declared} bytes, limit ${maxBytes}`),
      retryable: false,
    };
  }

  const body = response.body;
  if (body === null) {
    return { ok: false, error: new MediaError('media_not_video', 'upstream response has no body'), retryable: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          error: new MediaError('media_too_large', `upstream response exceeded ${maxBytes} bytes`),
          retryable: false,
        };
      }
      chunks.push(value);
    }
  } catch (error) {
    // 读流阶段同样会被 `AbortSignal.timeout` 打断，按超时归类。
    await reader.cancel().catch(() => undefined);
    const mediaError = toMediaError(error, timeoutMs, signal);
    return { ok: false, error: mediaError, retryable: isRetryableCode(mediaError.code) };
  }

  if (total === 0) {
    return { ok: false, error: new MediaError('media_not_video', 'upstream response body is empty'), retryable: false };
  }
  return { ok: true, bytes: concat(chunks, total) };
}

/** 超时与上游 5xx 可重试；`media_upstream_5xx` 也覆盖连接层失败。 */
function isRetryableCode(code: MediaErrorCode): boolean {
  return code === 'media_timeout' || code === 'media_upstream_5xx';
}

/**
 * 把任意错误翻译成 `MediaError`。
 *
 * 两个硬约束：
 * 1. **message 只能含 `error.name`**。`error.message` 可能是 Node 的
 *    `Failed to parse URL from <原始 URL>`，会把带签名的完整上游地址带进
 *    `MediaError.message`，而这个 message 会作为响应体回到浏览器——直接违反
 *    「浏览器不接触上游签名」。需要地址时一律用 `sanitizeMediaUrl`。
 * 2. 超时识别先看 `signal.aborted`：`AbortSignal.timeout()` 触发时该标志必为 true，
 *    而读流阶段抛的错误并不总是 `TimeoutError` / `AbortError`——连接被拆时 undici
 *    抛的是 `TypeError: terminated`（Node 22 实测：超时给 `TimeoutError`，
 *    socket 被 destroy 给 `TypeError: terminated` 且 `aborted === false`）。
 *    只看名字会把后者误判成 5xx。
 */
function toMediaError(error: unknown, timeoutMs: number, signal?: AbortSignal): MediaError {
  if (error instanceof MediaError) {
    return error;
  }
  if (signal?.aborted === true) {
    return new MediaError('media_timeout', `upstream did not respond within ${timeoutMs}ms`);
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new MediaError('media_timeout', `upstream did not respond within ${timeoutMs}ms`);
  }
  return new MediaError('media_upstream_5xx', `upstream request failed: ${name === '' ? 'unknown error' : name}`);
}

/**
 * 解密失败的错误描述。
 *
 * 只有本仓库自己的两种错误才把 message 写进响应：`CencError`（样本表与偏移）与
 * `Mp4ParseError`（box 类型与偏移）。它们由我们的代码拼出，不含密钥与 URL。
 * 其它错误只保留 `name`，理由同 `toMediaError`。
 */
function describeDecryptFailure(error: unknown): string {
  if (error instanceof CencError || error instanceof Mp4ParseError) {
    return error.message;
  }
  return error instanceof Error ? error.name : 'unknown error';
}

function aggregateFailure(failures: readonly { url: string; error: MediaError }[]): MediaError {
  // 取**第一个**地址的错误码作为聚合码：主地址的失败原因最能代表这次请求的诊断结论，
  // 备用地址往往是被主地址拖累（例如同一次风控）。
  const code = failures[0]?.error.code ?? 'media_upstream_5xx';
  // 这里的 `error.message` 全部来自上面的构造函数，已经过「只取 name / 脱敏地址」这道关。
  const detail = failures.map(({ url, error }) => `${sanitizeMediaUrl(url)}: ${error.message}`).join('; ');
  return new MediaError(code, `all ${failures.length} stream URLs failed: ${detail}`);
}

async function cancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
