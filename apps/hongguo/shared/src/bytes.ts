/**
 * 安全的字节读取工具。
 *
 * tsconfig 开了 `noUncheckedIndexedAccess`，所以 `buf[i]` 的类型是
 * `number | undefined`。这里集中处理越界，避免在解析代码里到处写 `!`。
 */

export function at(buf: Uint8Array, index: number): number {
  const value = buf[index];
  if (value === undefined) {
    throw new RangeError(`byte ${index} out of range (length ${buf.length})`);
  }
  return value;
}

export function u32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset);
}

export function u64(buf: Uint8Array, offset: number): number {
  return Number(new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getBigUint64(offset));
}

export function u16(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(offset);
}

export function ascii(buf: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > buf.length) {
    throw new RangeError(`ascii range ${offset}+${length} out of range (length ${buf.length})`);
  }
  return new TextDecoder('latin1').decode(buf.subarray(offset, offset + length));
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

// 用 atob/btoa 而不是 Buffer：本包同时被 apps/server（Node）和 apps/web（浏览器）引用。
// Node 18+ 与所有现代浏览器都提供这两个全局函数。

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
