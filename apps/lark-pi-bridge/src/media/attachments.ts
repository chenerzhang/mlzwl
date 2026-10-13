import { mkdir, lstat, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const MAX_ATTACHMENTS = 4;
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_STALE_RUNS = 32;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface RemoteImageAttachment {
  fileKey: string;
  fileName?: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface LarkImageDownload {
  messageId: string;
  fileKey: string;
  type: 'image';
}

export interface StoredImageAttachment {
  fileKey: string;
  path: string;
  mimeType: string;
}

export interface AttachmentStoreOptions {
  staleAgeMs?: number;
  maxStaleRuns?: number;
  now?: () => number;
}

/**
 * Run-owned attachment storage. Completed runs are removed immediately; a
 * crash can only leave bounded stale directories, swept on the next startup.
 */
export class AttachmentStore {
  private readonly active = new Set<string>();
  private readonly staleAgeMs: number;
  private readonly maxStaleRuns: number;
  private readonly now: () => number;

  constructor(
    private readonly mediaDir: string,
    opts: AttachmentStoreOptions = {},
  ) {
    this.staleAgeMs = nonNegative(opts.staleAgeMs, DEFAULT_STALE_AGE_MS, 'staleAgeMs');
    this.maxStaleRuns = nonNegative(opts.maxStaleRuns, DEFAULT_MAX_STALE_RUNS, 'maxStaleRuns');
    this.now = opts.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
    await this.sweep();
  }

  async downloadRun(
    runId: string,
    attachments: LarkImageDownload[],
    download: (messageId: string, fileKey: string, type: 'image') => Promise<{ buffer: Buffer; contentType?: string }>,
  ): Promise<StoredImageAttachment[]> {
    const runDir = this.runDir(runId);
    if (this.active.has(runId)) {
      throw new Error(`attachment run is already active: ${runId}`);
    }
    this.active.add(runId);
    try {
      if (!attachments.length) {
        return [];
      }
      await mkdir(runDir, { recursive: false, mode: 0o700 });
      const stored = await downloadAndStoreImages(runDir, attachments, download);
      await assertPrivateTree(
        runDir,
        stored.map((item) => item.path),
      );
      return stored;
    } catch (error) {
      this.active.delete(runId);
      await rm(runDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async release(runId: string): Promise<void> {
    const runDir = this.runDir(runId);
    this.active.delete(runId);
    await rm(runDir, { recursive: true, force: true });
  }

  async sweep(): Promise<void> {
    await mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
    const candidates: Array<{ name: string; path: string; mtimeMs: number }> = [];
    for (const name of await readdir(this.mediaDir)) {
      if (!SAFE_RUN_ID.test(name) || this.active.has(name)) {
        continue;
      }
      const path = join(this.mediaDir, name);
      const metadata = await lstat(path).catch(() => undefined);
      if (!metadata) {
        continue;
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      candidates.push({ name, path, mtimeMs: metadata.mtimeMs });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const cutoff = this.now() - this.staleAgeMs;
    await Promise.all(
      candidates
        .filter((candidate, index) => candidate.mtimeMs <= cutoff || index >= this.maxStaleRuns)
        .map((candidate) => rm(candidate.path, { recursive: true, force: true })),
    );
  }

  private runDir(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) {
      throw new Error(`invalid attachment run id: ${runId}`);
    }
    return join(this.mediaDir, runId);
  }
}

/** Validate before writing user-controlled Lark image bytes to a run-owned directory. */
export async function storeImageAttachments(
  runDir: string,
  attachments: RemoteImageAttachment[],
): Promise<StoredImageAttachment[]> {
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`图片数量不能超过 ${MAX_ATTACHMENTS}`);
  }
  const validated = attachments.map(validateAttachment);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const stored: StoredImageAttachment[] = [];
  try {
    for (const [index, attachment] of validated.entries()) {
      const safeName = safeFileName(attachment.fileName ?? attachment.fileKey, attachment.mimeType, index);
      const path = join(runDir, safeName);
      await writeFile(path, attachment.bytes, { mode: 0o600, flag: 'wx' });
      stored.push({ fileKey: attachment.fileKey, path, mimeType: attachment.mimeType });
    }
    return stored;
  } catch (error) {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function downloadAndStoreImages(
  runDir: string,
  attachments: LarkImageDownload[],
  download: (messageId: string, fileKey: string, type: 'image') => Promise<{ buffer: Buffer; contentType?: string }>,
): Promise<StoredImageAttachment[]> {
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`图片数量不能超过 ${MAX_ATTACHMENTS}`);
  }
  const remote = await Promise.all(
    attachments.map(async (attachment) => {
      const result = await download(attachment.messageId, attachment.fileKey, 'image');
      return {
        fileKey: attachment.fileKey,
        fileName: attachment.fileKey,
        mimeType: result.contentType?.trim() || detectImageMimeType(result.buffer) || 'application/octet-stream',
        bytes: result.buffer,
      };
    }),
  );
  return storeImageAttachments(runDir, remote);
}

function validateAttachment(attachment: RemoteImageAttachment): RemoteImageAttachment {
  if (attachment.bytes.byteLength === 0 || attachment.bytes.byteLength > MAX_BYTES) {
    throw new Error(`图片大小必须在 1 B 到 ${MAX_BYTES} B 之间`);
  }
  const mimeType = normalizeMimeType(attachment.mimeType);
  if (!IMAGE_TYPES.has(mimeType)) {
    throw new Error(`不支持的图片类型：${attachment.mimeType}`);
  }
  const detected = detectImageMimeType(attachment.bytes);
  if (detected !== mimeType) {
    throw new Error(`图片内容与声明类型不匹配：${mimeType}`);
  }
  return { ...attachment, mimeType };
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function detectImageMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
    return 'image/gif';
  }
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    return 'image/webp';
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  return [...value].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}

async function assertPrivateTree(runDir: string, files: string[]): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  if (((await stat(runDir)).mode & 0o777) !== 0o700) {
    throw new Error('attachment run directory permissions are not 0700');
  }
  for (const path of files) {
    if (((await stat(path)).mode & 0o777) !== 0o600) {
      throw new Error('attachment file permissions are not 0600');
    }
  }
}

function safeFileName(value: string, mimeType: string, index: number): string {
  const root =
    basename(value, extname(value))
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 80) || `image-${index + 1}`;
  const extension =
    mimeType === 'image/png'
      ? '.png'
      : mimeType === 'image/jpeg'
        ? '.jpg'
        : mimeType === 'image/webp'
          ? '.webp'
          : '.gif';
  return `${index + 1}-${root}${extension}`;
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return result;
}
