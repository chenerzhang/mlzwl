import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { RpcImageContent } from './rpc-connection.js';

export const MAX_RPC_IMAGES = 4;
export const MAX_RPC_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_RPC_IMAGE_TOTAL_BYTES = MAX_RPC_IMAGES * MAX_RPC_IMAGE_BYTES;

/** Re-open already validated run-owned images without following symlinks. */
export async function readRpcImages(paths: readonly string[] | undefined): Promise<RpcImageContent[]> {
  if (!paths?.length) {
    return [];
  }
  if (paths.length > MAX_RPC_IMAGES) {
    throw new Error(`Pi RPC image count exceeded ${MAX_RPC_IMAGES}`);
  }
  const images: RpcImageContent[] = [];
  let total = 0;
  for (const path of paths) {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error('Pi RPC image must be a regular non-symlink file');
    }
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    const handle = await open(path, flags);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.dev !== before.dev || metadata.ino !== before.ino) {
        throw new Error('Pi RPC image changed while being opened');
      }
      if (metadata.size <= 0 || metadata.size > MAX_RPC_IMAGE_BYTES) {
        throw new Error(`Pi RPC image size must be between 1 and ${MAX_RPC_IMAGE_BYTES} bytes`);
      }
      total += metadata.size;
      if (total > MAX_RPC_IMAGE_TOTAL_BYTES) {
        throw new Error(`Pi RPC images exceeded ${MAX_RPC_IMAGE_TOTAL_BYTES} bytes`);
      }
      const bytes = await handle.readFile();
      if (bytes.length !== metadata.size) {
        throw new Error('Pi RPC image changed while being read');
      }
      const mimeType = detectImageMimeType(bytes);
      if (!mimeType) {
        throw new Error('Pi RPC image content is not PNG, JPEG, GIF, or WebP');
      }
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType });
    } finally {
      await handle.close();
    }
  }
  return images;
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
