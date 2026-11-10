/**
 * spade_a 内容密钥还原。
 *
 * 对应上游 openhongguo 的 `internal/drm/spade.go`。红果把 CENC 的 AES 内容密钥
 * 包在播放模型 `encrypt_info.spade_a` 这个 base64 串里，算法是「标记字节 + 定长
 * 前缀 + 固定置换」。本文件是纯函数实现，不依赖 Node API，前后端都能跑。
 *
 * 已验证：与 SDK 的 `contentKey.key` / `.version` 逐字节一致。
 */

import { at, base64ToBytes } from './bytes.js';

export interface ContentKey {
  /** 16 字节 AES 密钥的小写 hex，即 ffmpeg `-decryption_key` 接受的形式。 */
  key: string;
  /** 播放器在密钥旁读取的方案标记，实测为 "1"。 */
  version: string;
}

export class SpadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpadeError';
  }
}

function popcount(value: number): number {
  let n = 0;
  for (let i = 0; i < 4; i += 1) {
    let byte = (value >>> (i * 8)) & 0xff;
    while (byte !== 0) {
      n += byte & 1;
      byte >>= 1;
    }
  }
  return n;
}

function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x57;
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x37;
  }
  return -1;
}

/**
 * 播放器的字节置换。v2 对应 "app_v2" / "web_v2" 家族：
 * 先交换相邻字节，再在每步减去前一个滚动常量。
 */
function scramble(buf: Uint8Array, v2: boolean): void {
  if (v2) {
    const last = buf.length - 1;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const tmp = at(buf, i);
      buf[i] = at(buf, i + 1);
      buf[i + 1] = tmp;
      if (i === last - 2) {
        break;
      }
    }
  }

  let prev = 0x55;
  let cur = 0xfa;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = at(buf, i);
    const term = -(0x15 + popcount(i)) & 0xff;
    if (i % 2 === 0) {
      buf[i] = v2 ? ((cur ^ byte) - prev + term) & 0xff : (term + (cur ^ byte)) & 0xff;
      cur = byte;
    } else {
      buf[i] = v2 ? ((prev ^ byte) - prev + term) & 0xff : (term + (prev ^ byte)) & 0xff;
      prev = byte;
    }
  }
}

/**
 * 从 `encrypt_info.spade_a` 还原内容密钥。
 *
 * @throws {SpadeError} 输入不是可识别的密钥材料。
 */
export function deriveContentKey(spadeA: string): ContentKey {
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(spadeA);
  } catch {
    throw new SpadeError('spade_a is not valid base64');
  }
  if (raw.length < 4) {
    throw new SpadeError(`spade_a too short (${raw.length} bytes)`);
  }

  const marker = at(raw, 0) ^ at(raw, 1) ^ at(raw, 2);
  const prefixLen = marker - 0x30;
  if (prefixLen < 1 || prefixLen > raw.length) {
    throw new SpadeError(`bad prefix length ${prefixLen} for ${raw.length} bytes`);
  }

  const outLen = raw.length - marker + 0x2f;
  if (outLen < 2 || 1 + outLen > raw.length) {
    throw new SpadeError(`bad output length ${outLen} for ${raw.length} bytes`);
  }

  const buf = raw.slice(1, 1 + outLen);

  const tail = raw.length - prefixLen;
  const b16 = at(raw, tail - 2);
  const b14 = at(raw, tail - 1);
  const tag = new Uint8Array(prefixLen);
  for (let i = 0; i < prefixLen; i += 1) {
    tag[i] = b14 ^ b16 ^ at(raw, i + tail);
  }

  const tagText = new TextDecoder('latin1').decode(tag);
  scramble(buf, tagText.startsWith('app_v2') || tagText.startsWith('web_v2'));

  const versionLen = hexDigit(at(buf, 0));
  if (versionLen < 1 || versionLen >= outLen) {
    throw new SpadeError(`bad version length ${versionLen}`);
  }

  const keyLen = outLen - versionLen;
  const keyChars: string[] = [];
  for (let i = 1; i < keyLen; i += 1) {
    const code = at(buf, i);
    if (hexDigit(code) < 0) {
      throw new SpadeError(`non-hex byte 0x${code.toString(16)} at key offset ${i - 1}`);
    }
    keyChars.push(String.fromCharCode(code));
  }

  const key = keyChars.join('');
  if (key.length === 0 || key.length % 2 !== 0) {
    throw new SpadeError(`key hex has odd length ${key.length}`);
  }

  const versionChars: string[] = [];
  for (let i = keyLen; i < outLen; i += 1) {
    versionChars.push(String.fromCharCode(at(buf, i)));
  }

  return { key: key.toLowerCase(), version: versionChars.join('') };
}
