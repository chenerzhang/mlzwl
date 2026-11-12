import { createCipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_MOOV_BYTES, planTracks } from '@mlzwl/hongguo-shared';
import { decryptCenc } from './cenc.js';

/**
 * CENC 解密的正确性证据。
 *
 * 三层，从纯计算到真实样本：
 *
 * 1. **公开标准向量**：NIST SP 800-38A 的 AES-128-CTR 向量。验证我们的计数器
 *    构造与 CTR 语义没写错。这是纯计算，永远可跑。
 * 2. **构造夹具**：自建最小 MP4，覆盖 subsample（保留 clear 字节、CTR 只在加密
 *    字节上前进）、`sinf/frma` codec 恢复、`moov` 前置校验、fail-closed。
 *    夹具只按公开的 ISO/IEC 14496-12 与 CENC 字段布局构造。
 * 3. **真实样本**：`/tmp/probe` 里的加密文件，不存在时整组跳过。
 *
 * **重要**：真实样本的文件和密钥必须来自同一次 `resolvePlayback` 调用。跨调用混用
 * 会得到「密钥不匹配」的假失败（ffmpeg 报 Invalid NAL unit size）。
 */

const FIXTURES = [
  { file: '/tmp/probe/fresh360.mp4', key: 'd09eb1c35ad295141fccc28c84369aba', label: '360p' },
  { file: '/tmp/probe/fresh1080.mp4', key: 'd09eb1c35ad295141fccc28c84369aba', label: '1080p' },
];

const available = FIXTURES.filter((fixture) => existsSync(fixture.file));

// ---------------------------------------------------------------------------
// 构造夹具的最小 MP4 写入工具
// ---------------------------------------------------------------------------

function be16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function be32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function asciiBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    out[i] = value.charCodeAt(i) & 0xff;
  }
  return out;
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function box(type: string, ...bodies: Uint8Array[]): Uint8Array {
  const body = join(bodies);
  return join([be32(body.length + 8), asciiBytes(type), body]);
}

function zeros(count: number): Uint8Array {
  return new Uint8Array(count);
}

/** `tenc`：version/flags(4) + reserved(1) + isProtected(1) + ivSize(1) + kid(16)。 */
function tenc(ivSize: number): Uint8Array {
  const body = new Uint8Array(23);
  body[5] = 1;
  body[6] = ivSize;
  for (let i = 0; i < 16; i += 1) {
    body[7 + i] = 0xa0 + i;
  }
  return box('tenc', body);
}

export interface Subsample {
  clearBytes: number;
  encryptedBytes: number;
}

export interface FixtureOptions {
  /** `sinf/frma` 的原始编码；`null` 表示不写 `frma`。 */
  codec?: string | null;
  ivSize?: number;
  /** 每样本的 IV（hex）。长度必须等于 `ivSize`。 */
  iv: string;
  /** `mdat` 里的样本字节（已加密或明文，取决于用例）。 */
  sampleBytes: Uint8Array;
  /** 子样本表；省略表示整个样本加密。 */
  subsamples?: Subsample[];
  /** 把 `mdat` 放到 `moov` 之前，模拟未 faststart 的文件。 */
  mdatFirst?: boolean;
  /** 插在 `ftyp` 与 `moov` 之间的额外 box 类型（测 `moov` 前置白名单用）。 */
  leadingBoxes?: string[];
  /** 在 `moov` 里塞一个 `free` 撑大体积，用于测上限。 */
  moovPadding?: number;
  /** `senc` 声明的样本数，故意与 `stsz` 不一致用于测 fail-closed。 */
  sencSampleCount?: number;
  /**
   * 每个 chunk 的样本数。省略表示所有样本放在一个 chunk 里。
   *
   * 多 chunk 是必要的：`stsc`/`stco` 的展开与偏移累加只在 chunk 数 > 1 时
   * 才真正参与计算，单 chunk 的夹具测不到这段算术。
   */
  samplesPerChunk?: number[];
}

/**
 * 构造只含一条加密视频轨的最小 MP4。
 *
 * `stco` 需要 `mdat` 数据的绝对偏移，而 `moov` 的大小又依赖 `stco` 的内容，所以
 * 用两遍构建：先用占位偏移算布局，再写真实偏移。
 */
function fixture(options: FixtureOptions): Uint8Array {
  const codec = options.codec === undefined ? 'hvc1' : options.codec;
  const ivSize = options.ivSize ?? 8;
  const iv = hexBytes(options.iv);
  if (iv.length !== ivSize) {
    throw new Error(`fixture iv must be ${ivSize} bytes`);
  }
  const padding = options.moovPadding ?? 0;

  const ftyp = box('ftyp', asciiBytes('isom'), be32(0), asciiBytes('isom'));
  const mdat = box('mdat', options.sampleBytes);
  const leading = (options.leadingBoxes ?? []).map((type) => box(type, zeros(8)));
  const leadingLength = leading.reduce((sum, chunk) => sum + chunk.length, 0);

  // 样本大小表：显式给每样本长度，让多 chunk 的偏移累加真的被计算。
  const perChunk = options.samplesPerChunk ?? [1];
  const sampleCount = perChunk.reduce((sum, count) => sum + count, 0);
  // 不整除时 `Math.floor` 会静默截断，`stsz` 里剩下的字节就没人解释了。
  expect(options.sampleBytes.length % sampleCount, 'fixture sample bytes must split evenly across samples').toBe(0);
  const sampleSize = Math.floor(options.sampleBytes.length / sampleCount);
  const sizes = new Array<number>(sampleCount).fill(sampleSize);

  const buildMoov = (dataOffset: number): Uint8Array => {
    const sinfChildren: Uint8Array[] = [];
    if (codec !== null) {
      sinfChildren.push(box('frma', asciiBytes(codec)));
    }
    sinfChildren.push(box('schi', tenc(ivSize)));
    const sinf = box('sinf', ...sinfChildren);

    // VisualSampleEntry 的固定字段区是 78 字节，之后才是 sinf。
    const entry = box('encv', zeros(78), sinf);
    const stsd = box('stsd', zeros(4), be32(1), entry);

    const stsz = box('stsz', zeros(4), be32(0), be32(sampleCount), ...sizes.map((size) => be32(size)));

    // `stsc` 每个 entry 描述"从第 firstChunk 个 chunk 起每 chunk 多少样本"。
    // `firstChunk` 是 **1-based 的 chunk 序号**，所以要逐 chunk 递增 1，
    // 不能累加样本数——累加会把 run 指向不存在的 chunk，后面的样本全部丢掉。
    const stscParts: Uint8Array[] = [zeros(4), be32(perChunk.length)];
    for (let i = 0; i < perChunk.length; i += 1) {
      stscParts.push(be32(i + 1), be32(perChunk[i] ?? 0), be32(1));
    }
    const stsc = box('stsc', ...stscParts);

    // 每个 chunk 的偏移：按该 chunk 的样本总字节数向后排。
    const stcoParts: Uint8Array[] = [zeros(4), be32(perChunk.length)];
    let byteCursor = dataOffset;
    for (const count of perChunk) {
      stcoParts.push(be32(byteCursor));
      byteCursor += count * sampleSize;
    }
    const stco = box('stco', ...stcoParts);

    const sencCount = options.sencSampleCount ?? sampleCount;
    const sencParts: Uint8Array[] = [];
    // flags 的 0x2 位表示带子样本表。
    sencParts.push(be32(options.subsamples === undefined ? 0 : 0x2));
    sencParts.push(be32(sencCount));
    // 每个样本都要写一份完整的 IV + 子样本表，否则 `readSenc` 会先报截断，
    // 测不到后续的样本数一致性检查。
    for (let i = 0; i < sencCount; i += 1) {
      sencParts.push(iv);
      if (options.subsamples !== undefined) {
        sencParts.push(be16(options.subsamples.length));
        for (const sub of options.subsamples) {
          sencParts.push(be16(sub.clearBytes), be32(sub.encryptedBytes));
        }
      }
    }
    const senc = box('senc', ...sencParts);

    const stbl = box('stbl', stsd, stsz, stsc, stco, senc);
    const parts: Uint8Array[] = [];
    if (padding > 0) {
      parts.push(box('free', zeros(padding)));
    }
    parts.push(box('trak', box('mdia', box('minf', stbl))));
    return box('moov', ...parts);
  };

  const probeMoov = buildMoov(0);
  if (options.mdatFirst === true) {
    const dataOffset = ftyp.length + leadingLength + mdat.length - options.sampleBytes.length;
    return join([ftyp, ...leading, mdat, buildMoov(dataOffset)]);
  }

  const dataOffset = ftyp.length + leadingLength + probeMoov.length + mdat.length - options.sampleBytes.length;
  const moov = buildMoov(dataOffset);
  // 偏移字面长度固定为 4 字节，所以两遍布局必须等长；不等说明夹具写坏了。
  if (moov.length !== probeMoov.length) {
    throw new Error('fixture layout is unstable');
  }
  return join([ftyp, ...leading, moov, mdat]);
}

/** 按 CENC 语义加密：CTR 只在加密字节上前进，clear 字节不消耗密钥流。 */
function encryptSubsamples(
  plain: Uint8Array,
  subsamples: readonly Subsample[],
  key: Uint8Array,
  counter: Uint8Array,
): Uint8Array {
  const out = plain.slice();
  const cipher = createCipheriv('aes-128-ctr', key, counter);
  let cursor = 0;
  for (const sub of subsamples) {
    cursor += sub.clearBytes;
    if (sub.encryptedBytes > 0) {
      const slice = plain.subarray(cursor, cursor + sub.encryptedBytes);
      out.set(cipher.update(slice), cursor);
      cursor += sub.encryptedBytes;
    }
  }
  return out;
}

/**
 * 独立算出期望密文：先生成一整段密钥流，再按字节异或。
 *
 * 存在的意义是**避免自证**。`encryptSubsamples` 用的是「同一个 cipher 依次 update」，
 * 而 `decryptTrack` 也是这个模式。两边用同一种写法时，即使写法错了也会互相对上。
 * 这里改成"一次算出密钥流再按偏移取"，是一条独立的计算路径：只要 subsample 的
 * 密钥流偏移算错（比如 clear 字节也消耗了密钥流），两条路径就会不一致。
 */
function expectedCipher(
  plain: Uint8Array,
  subsamples: readonly Subsample[],
  key: Uint8Array,
  counter: Uint8Array,
): Uint8Array {
  const totalEncrypted = subsamples.reduce((sum, sub) => sum + sub.encryptedBytes, 0);
  const keystream = createCipheriv('aes-128-ctr', key, counter).update(new Uint8Array(totalEncrypted));

  const out = plain.slice();
  let cursor = 0;
  let streamAt = 0;
  for (const sub of subsamples) {
    cursor += sub.clearBytes;
    for (let i = 0; i < sub.encryptedBytes; i += 1) {
      out[cursor + i] = (plain[cursor + i] ?? 0) ^ (keystream[streamAt + i] ?? 0);
    }
    cursor += sub.encryptedBytes;
    streamAt += sub.encryptedBytes;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 公开标准向量
// ---------------------------------------------------------------------------

/** NIST SP 800-38A，F.5.1 CTR-AES128.Encrypt。 */
const NIST = {
  key: '2b7e151628aed2a6abf7158809cf4f3c',
  counter: 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
  plain: join([
    hexBytes('6bc1bee22e409f96e93d7e117393172a'),
    hexBytes('ae2d8a571e03ac9c9eb76fac45af8e51'),
    hexBytes('30c81c46a35ce411e5fbc1191a0a52ef'),
    hexBytes('f69f2445df4f9b17ad2b417be66c3710'),
  ]),
  cipher: join([
    hexBytes('874d6191b620e3261bef6864990db6ce'),
    hexBytes('9806f66b7970fdff8617187bb9fffdff'),
    hexBytes('5ae4df3edbd5d35e5b4f09020db03eab'),
    hexBytes('1e031dda2fbe03d1792170a0f3009cee'),
  ]),
};

describe('decryptCenc with the NIST AES-128-CTR vector', () => {
  it('recovers the published plaintext from the published ciphertext', () => {
    // ivSize = 16：直接用整个 IV 作为初始计数器块，正好对应 NIST 的 counter。
    const encrypted = fixture({ ivSize: 16, iv: NIST.counter, sampleBytes: NIST.cipher });
    const { buffer, tracks } = decryptCenc(encrypted, NIST.key);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.ivSize).toBe(16);
    // 长度不变是原地解密的核心不变量：所有偏移表继续有效。
    expect(buffer.length).toBe(encrypted.length);

    const mdatOffset = buffer.length - NIST.plain.length;
    expect(Array.from(buffer.subarray(mdatOffset))).toEqual(Array.from(NIST.plain));
  });

  it('rewrites the moov prefix while keeping the total length', () => {
    const encrypted = fixture({ ivSize: 16, iv: NIST.counter, sampleBytes: NIST.cipher });
    const before = encrypted.slice();
    const { buffer } = decryptCenc(encrypted, NIST.key);

    const mdatOffset = buffer.length - NIST.plain.length;
    // `moov` 之前的字节不变，只有 sample entry 类型与 tenc 保护位被改。
    expect(Array.from(buffer.subarray(0, mdatOffset))).not.toEqual(Array.from(before.subarray(0, mdatOffset)));
    // 但总长度必须一致。
    expect(buffer.length).toBe(before.length);
  });

  /**
   * 每个加密长度都逐一对拍。
   *
   * 这是本 API 真正支持、也真正容易错的边界：
   * - 样本长度不是 16 的倍数时，最后一块只有部分字节参与。
   * - 长度 1 到 15 一个整块都凑不满，计数器只前进 0 块。
   * - 长度 17 时是「一整块 + 1 字节」，第二块必须用递增后的计数器。
   *
   * 期望值用 `expectedCipher`（独立按密钥流偏移异或），不用 `encryptSubsamples`，
   * 避免两边用同一种写法互相掩盖错误。
   */
  it('recovers every sample length from 1 to 40 bytes', () => {
    const KEY = hexBytes(NIST.key);
    const COUNTER = hexBytes(NIST.counter);

    for (let length = 1; length <= 40; length += 1) {
      const subsamples: Subsample[] = [{ clearBytes: 0, encryptedBytes: length }];
      const plain = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        plain[i] = (0x11 * (i + 1) + length) & 0xff;
      }
      const encryptedBytes = expectedCipher(plain, subsamples, KEY, COUNTER);

      const { buffer } = decryptCenc(fixture({ ivSize: 16, iv: NIST.counter, sampleBytes: encryptedBytes }), NIST.key);
      const mdatOffset = buffer.length - length;
      expect(Array.from(buffer.subarray(mdatOffset)), `length=${length}`).toEqual(Array.from(plain));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 构造夹具：subsample、codec 恢复、布局校验、fail-closed
// ---------------------------------------------------------------------------

describe('decryptCenc with multiple chunks', () => {
  const KEY = hexBytes('2b7e151628aed2a6abf7158809cf4f3c');
  const IV = 'f0f1f2f3f4f5f6f7';
  const COUNTER = hexBytes(`${IV}0000000000000000`);

  /**
   * 多 chunk 的偏移算术。
   *
   * 红果的音频轨 `stsc` 有 1449 个 run，`samplesPerChunk` 在 1 和 2 之间交替。
   * 只读第一个 run、或把每个 chunk 当成固定样本数，都会让第二个 chunk 起整体错位。
   * 这里用 4 个 chunk × 不等样本数（1/2/1/3）构造，确保 `expandStsc` 与
   * `sampleOffsets` 的累加都真正参与计算。
   */
  it('walks stsc runs and chunk offsets to find every sample', () => {
    const perChunk = [1, 2, 1, 3];
    const sampleCount = perChunk.reduce((sum, count) => sum + count, 0);
    const sampleSize = 16;
    const plain = new Uint8Array(sampleCount * sampleSize);
    for (let i = 0; i < plain.length; i += 1) {
      plain[i] = (i * 7 + 3) & 0xff;
    }
    // 每个样本都是整段加密，密钥流在每个样本开头重新从同一计数器开始。
    const encryptedBytes = plain.slice();
    for (let s = 0; s < sampleCount; s += 1) {
      const slice = plain.subarray(s * sampleSize, (s + 1) * sampleSize);
      encryptedBytes.set(createCipheriv('aes-128-ctr', KEY, COUNTER).update(slice), s * sampleSize);
    }

    const file = fixture({ ivSize: 8, iv: IV, sampleBytes: encryptedBytes, samplesPerChunk: perChunk });
    const plans = planTracks(file);
    expect(plans[0]?.offsets).toHaveLength(sampleCount);
    // 相邻样本偏移的差值必须正好是样本长度；错位会在这里立刻显形。
    const offsets = plans[0]?.offsets ?? [];
    for (let i = 1; i < offsets.length; i += 1) {
      expect((offsets[i] ?? 0) - (offsets[i - 1] ?? 0)).toBe(sampleSize);
    }

    const { buffer } = decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c');
    const mdatOffset = buffer.length - plain.length;
    expect(Array.from(buffer.subarray(mdatOffset))).toEqual(Array.from(plain));
  });

  it('handles a single chunk with many samples', () => {
    const plain = new Uint8Array(64);
    for (let i = 0; i < plain.length; i += 1) {
      plain[i] = i;
    }
    const encryptedBytes = plain.slice();
    for (let s = 0; s < 4; s += 1) {
      encryptedBytes.set(
        createCipheriv('aes-128-ctr', KEY, COUNTER).update(plain.subarray(s * 16, (s + 1) * 16)),
        s * 16,
      );
    }

    const file = fixture({ ivSize: 8, iv: IV, sampleBytes: encryptedBytes, samplesPerChunk: [4] });
    const { buffer } = decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c');
    const mdatOffset = buffer.length - plain.length;
    expect(Array.from(buffer.subarray(mdatOffset))).toEqual(Array.from(plain));
  });
});
describe('decryptCenc with subsamples', () => {
  const KEY = hexBytes('2b7e151628aed2a6abf7158809cf4f3c');
  // ivSize = 8：CENC 约定 IV 填在计数器高 8 字节，低 8 字节从 0 开始计数。
  const IV = 'f0f1f2f3f4f5f6f7';
  const COUNTER = hexBytes(`${IV}0000000000000000`);

  it('keeps clear bytes untouched and advances CTR only over encrypted bytes', () => {
    // 明文布局：[3 clear][16 enc][2 clear][16 enc]，共 37 字节。
    const subsamples: Subsample[] = [
      { clearBytes: 3, encryptedBytes: 16 },
      { clearBytes: 2, encryptedBytes: 16 },
    ];
    const plain = new Uint8Array(37);
    for (let i = 0; i < plain.length; i += 1) {
      plain[i] = 0x40 + i;
    }
    // 必须用 `expectedCipher`（一次算整段密钥流再按偏移异或），不能用
    // `encryptSubsamples`：后者与 `decryptTrack` 同为「单个 cipher 顺序 update」，
    // 两边若都误以为 clear 字节推进密钥流，往返仍然会通过。
    const encryptedBytes = expectedCipher(plain, subsamples, KEY, COUNTER);
    // 前置断言：clear 区在加密后必须保持原样，否则夹具本身没构造出可验证的差异。
    expect(encryptedBytes[0]).toBe(plain[0]);
    expect(encryptedBytes[3]).not.toBe(plain[3]);
    expect(encryptedBytes[19]).toBe(plain[19]);
    expect(encryptedBytes[21]).not.toBe(plain[21]);

    const file = fixture({ ivSize: 8, iv: IV, sampleBytes: encryptedBytes, subsamples });
    const { buffer } = decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c');

    const mdatOffset = buffer.length - plain.length;
    expect(Array.from(buffer.subarray(mdatOffset))).toEqual(Array.from(plain));
  });

  it('handles an encrypted region that is not a multiple of 16', () => {
    // 21 字节的加密区：最后一块只有 5 字节，验证部分块的 CTR 收尾。
    const subsamples: Subsample[] = [{ clearBytes: 0, encryptedBytes: 21 }];
    const plain = new Uint8Array(21);
    for (let i = 0; i < plain.length; i += 1) {
      plain[i] = 0x11 * (i % 15);
    }
    const encryptedBytes = encryptSubsamples(plain, subsamples, KEY, COUNTER);

    const file = fixture({ ivSize: 8, iv: IV, sampleBytes: encryptedBytes, subsamples });
    const { buffer } = decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c');
    const mdatOffset = buffer.length - plain.length;
    expect(Array.from(buffer.subarray(mdatOffset))).toEqual(Array.from(plain));
  });

  it('restores the codec tag and clears the protected flag', () => {
    const file = fixture({ codec: 'avc1', iv: IV, sampleBytes: zeros(16) });
    const { buffer, tracks } = decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c');

    expect(tracks[0]?.entryType).toBe('encv');
    expect(tracks[0]?.clearType).toBe('avc1');

    const text = Buffer.from(buffer).toString('latin1');
    // sample entry 的类型被改回原始编码。
    expect(text.includes('encv')).toBe(false);
    expect(text.includes('avc1')).toBe(true);
    // `sinf` 必须**保留**：原地解密要求字节长度不变，不能删除 box。
    // 残留的 `sinf` 不影响解码，因为 sample entry 已经不是加密类型了。
    expect(text.includes('sinf')).toBe(true);
    expect(buffer.length).toBe(file.length);
  });

  it('falls back to hvc1 and warns when frma is missing', () => {
    const warnings: string[] = [];
    const file = fixture({ codec: null, iv: IV, sampleBytes: zeros(16) });
    const { tracks } = decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c', {
      onWarn: (message) => warnings.push(message),
    });

    expect(tracks[0]?.clearType).toBe('hvc1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no usable sinf\/frma/);
  });

  it('falls back and warns when frma repeats the encrypted entry type', () => {
    // `frma === encv` 时写回去等于没解密，而 tenc 的保护位已被清零，文件会自相矛盾。
    const warnings: string[] = [];
    const file = fixture({ codec: 'encv', iv: IV, sampleBytes: zeros(16) });
    const entryOffset = planTracks(file)[0]?.sampleEntryOffset ?? 0;
    const { buffer, tracks } = decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c', {
      onWarn: (message) => warnings.push(message),
    });

    expect(tracks[0]?.clearType).toBe('hvc1');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/sinf\/frma === encv/);
    // 只能看 sample entry 的类型字段：`frma` 的 body 里本来就写着 `encv`，
    // 全文件搜字符串会误判。
    expect(asciiBytes('hvc1')).toEqual(buffer.subarray(entryOffset + 4, entryOffset + 8));
  });
});

describe('planTracks layout validation', () => {
  const IV = 'f0f1f2f3f4f5f6f7';

  it('accepts a faststart layout', () => {
    expect(planTracks(fixture({ iv: IV, sampleBytes: zeros(16) }))).toHaveLength(1);
  });

  it('rejects a file whose moov is not front-loaded', () => {
    // mdat 在 moov 之前：浏览器必须先读到文件尾部才能起播，解密与 Range 都不可靠。
    expect(() => planTracks(fixture({ iv: IV, sampleBytes: zeros(16), mdatFirst: true }))).toThrow(/not front-loaded/);
  });

  it('accepts pdin and uuid before moov', () => {
    // 两者都不携带媒体负载：pdin 是 progressive download info（faststart 常见），
    // uuid 是通用元数据 box。把它们当成非法布局会把合法文件整集判为不可播。
    expect(planTracks(fixture({ iv: IV, sampleBytes: zeros(16), leadingBoxes: ['pdin', 'uuid'] }))).toHaveLength(1);
  });

  it('rejects a file that does not start with ftyp', () => {
    const broken = fixture({ iv: IV, sampleBytes: zeros(16) }).slice();
    broken.set(asciiBytes('junk'), 4);
    expect(() => planTracks(broken)).toThrow(/ftyp must be the first box/);
  });

  it('rejects an oversized moov', () => {
    expect(() => planTracks(fixture({ iv: IV, sampleBytes: zeros(16), moovPadding: MAX_MOOV_BYTES }))).toThrow(
      /moov is too large/,
    );
  });

  it('accepts a moov well under the limit', () => {
    // 上限 8 MB，塞 1 MB 填充确保没把正常文件误杀。
    expect(() => planTracks(fixture({ iv: IV, sampleBytes: zeros(16), moovPadding: 1024 * 1024 }))).not.toThrow();
  });

  it('rejects a truncated file instead of returning a partial plan', () => {
    const truncated = fixture({ iv: IV, sampleBytes: zeros(16) }).slice(0, 40);
    expect(() => planTracks(truncated)).toThrow();
  });
});

describe('decryptCenc fail-closed behaviour', () => {
  const IV = 'f0f1f2f3f4f5f6f7';

  it('rejects a key of the wrong length', () => {
    expect(() => decryptCenc(fixture({ iv: IV, sampleBytes: zeros(16) }), 'deadbeef')).toThrow(/32 hex characters/);
  });

  it('rejects a non-hex key', () => {
    expect(() => decryptCenc(fixture({ iv: IV, sampleBytes: zeros(16) }), 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toThrow(
      /invalid hex/,
    );
  });

  it('rejects a sample table that disagrees with senc', () => {
    // senc 声明 2 个样本，stsz 只有 1 个。
    expect(() =>
      decryptCenc(fixture({ iv: IV, sampleBytes: zeros(16), sencSampleCount: 2 }), '2b7e151628aed2a6abf7158809cf4f3c'),
    ).toThrow(/senc has 2 samples but stbl has 1/);
  });

  it('rejects an unsupported IV size', () => {
    // ivSize 12 既不是 8 也不是 16。
    expect(() =>
      decryptCenc(
        fixture({ ivSize: 12, iv: 'f0f1f2f3f4f5f6f7f8f9fafb', sampleBytes: zeros(16) }),
        '2b7e151628aed2a6abf7158809cf4f3c',
      ),
    ).toThrow(/unsupported IV size 12/);
  });

  it('rejects a file with no encrypted tracks', () => {
    // 明文 `avc1` entry 不在加密类型映射里，planTracks 返回空数组。
    const ftyp = box('ftyp', asciiBytes('isom'), be32(0), asciiBytes('isom'));
    const entry = box('avc1', zeros(78));
    const stsd = box('stsd', zeros(4), be32(1), entry);
    const stbl = box('stbl', stsd);
    const moov = box('moov', box('trak', box('mdia', box('minf', stbl))));
    const file = join([ftyp, moov]);

    expect(() => decryptCenc(file, '2b7e151628aed2a6abf7158809cf4f3c')).toThrow(/no encrypted tracks/);
  });

  it('rejects a subsample that overruns the file', () => {
    // 声明 4096 字节加密区，但样本只有 16 字节。
    // sample 边界检查先于文件边界触发，两者都属 fail-closed。
    const subsamples: Subsample[] = [{ clearBytes: 0, encryptedBytes: 4096 }];
    expect(() =>
      decryptCenc(fixture({ iv: IV, sampleBytes: zeros(16), subsamples }), '2b7e151628aed2a6abf7158809cf4f3c'),
    ).toThrow(/overruns sample 0/);
  });

  /*
   * 只检查文件边界不够：两个 sample 各 16 字节时，第一个 sample 声明 24 字节
   * 加密区，虽然越过了 sample 0 的末尾，却仍在整个文件内。
   * 旧实现会静默解密 sample 1 的字节，破坏偏移表。这里必须 fail-closed，
   * 而且必须**报在 sample 0**：如果报在 sample 1，说明代码放过了跨界写入。
   */
  it('rejects a subsample that overruns its own sample but not the file', () => {
    const subsamples: Subsample[] = [{ clearBytes: 0, encryptedBytes: 24 }];
    expect(() =>
      decryptCenc(
        fixture({ iv: IV, sampleBytes: zeros(32), samplesPerChunk: [2], subsamples }),
        '2b7e151628aed2a6abf7158809cf4f3c',
      ),
    ).toThrow(/overruns sample 0 /);
  });

  it('rejects accumulated clear bytes that overrun the sample', () => {
    // 全部是 clear 段时没有 encrypted 段可触发检查，累计也必须判界。
    const subsamples: Subsample[] = [
      { clearBytes: 12, encryptedBytes: 0 },
      { clearBytes: 12, encryptedBytes: 0 },
    ];
    expect(() =>
      decryptCenc(
        fixture({ iv: IV, sampleBytes: zeros(32), samplesPerChunk: [2], subsamples }),
        '2b7e151628aed2a6abf7158809cf4f3c',
      ),
    ).toThrow(/overrun sample 0 /);
  });
});

// ---------------------------------------------------------------------------
// 3. 真实样本（不存在时跳过）
// ---------------------------------------------------------------------------

describe.skipIf(available.length === 0)('decryptCenc on real samples', () => {
  it.each(available)('decrypts $label without changing length', ({ file, key }) => {
    const encrypted = new Uint8Array(readFileSync(file));
    const { buffer, tracks } = decryptCenc(encrypted, key);

    // 原地解密的核心不变量：长度不变，所以所有偏移表继续有效。
    expect(buffer.length).toBe(encrypted.length);

    // 视频轨与音频轨都应被处理，且 iv 长度为 8（红果实测值）。
    expect(tracks.length).toBe(2);
    expect(tracks.map((track) => track.clearType)).toEqual(['hvc1', 'mp4a']);
    for (const track of tracks) {
      expect(track.ivSize).toBe(8);
    }
  });

  it('reports the track plan before decryption', () => {
    const fixtureEntry = available[0];
    if (fixtureEntry === undefined) {
      return;
    }
    const encrypted = new Uint8Array(readFileSync(fixtureEntry.file));
    const plans = planTracks(encrypted);
    expect(plans.map((plan) => plan.entryType)).toEqual(['encv', 'enca']);
    // 实测 360p 与 1080p 的样本数相同：视频 3524，音频 6326。
    expect(plans[0]?.samples.length).toBe(3524);
    expect(plans[1]?.samples.length).toBe(6326);
  });
});
