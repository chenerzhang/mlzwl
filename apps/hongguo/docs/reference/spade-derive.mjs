// spade_a 内容密钥还原：openhongguo internal/drm/spade.go 的等价 JavaScript 实现。
// 输入 encrypt_info.spade_a（base64），输出 { key: 32 位小写 hex, version }。
// 已在真实分集上对照 SDK 输出的 contentKey 验证一致。

const b64 = (s) => Uint8Array.from(Buffer.from(s.trim(), 'base64'));

function popcount(v) {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    let b = (v >>> (i * 8)) & 255;
    while (b) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}

function hexDigit(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

function scramble(buf, v2) {
  if (v2) {
    const last = buf.length - 1;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const t = buf[i];
      buf[i] = buf[i + 1];
      buf[i + 1] = t;
      if (i === last - 2) break;
    }
  }
  let prev = 0x55;
  let cur = 0xfa;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const term = -(0x15 + popcount(i)) & 255;
    if (i % 2 === 0) {
      buf[i] = v2 ? ((cur ^ b) - prev + term) & 255 : (term + (cur ^ b)) & 255;
      cur = b;
    } else {
      buf[i] = v2 ? ((prev ^ b) - prev + term) & 255 : (term + (prev ^ b)) & 255;
      prev = b;
    }
  }
}

export function deriveContentKey(spadeA) {
  const raw = b64(spadeA);
  if (raw.length < 4) throw new Error('spade_a too short');
  const marker = raw[0] ^ raw[1] ^ raw[2];
  const prefixLen = marker - 0x30;
  if (prefixLen < 1 || prefixLen > raw.length) throw new Error('bad marker');
  const outLen = raw.length - marker + 0x2f;
  if (outLen < 2 || 1 + outLen > raw.length) throw new Error('bad out length');
  const buf = raw.slice(1, 1 + outLen);
  const tail = raw.length - prefixLen;
  const b16 = raw[tail - 2];
  const b14 = raw[tail - 1];
  const tag = new Uint8Array(prefixLen);
  for (let i = 0; i < prefixLen; i++) tag[i] = b14 ^ b16 ^ raw[i + tail];
  const tagText = Buffer.from(tag).toString('latin1');
  scramble(buf, tagText.startsWith('app_v2') || tagText.startsWith('web_v2'));
  const versionLen = hexDigit(buf[0]);
  if (versionLen < 1 || versionLen >= outLen) throw new Error('bad version length');
  const keyLen = outLen - versionLen;
  const hexKey = Buffer.from(buf.slice(1, keyLen)).toString('latin1');
  if (!hexKey || hexKey.length % 2) throw new Error('bad key length');
  for (const ch of hexKey) if (hexDigit(ch.charCodeAt(0)) < 0) throw new Error('bad hex digit');
  return { key: hexKey.toLowerCase(), version: Buffer.from(buf.slice(keyLen)).toString('latin1') };
}
