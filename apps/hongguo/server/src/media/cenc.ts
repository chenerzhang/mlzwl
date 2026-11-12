/**
 * CENC 原地解密。
 *
 * 关键设计：**解密后字节长度完全不变**。这带来三个好处：
 * 1. `stbl` 里所有偏移表（`stco`/`stsz`/`stsc`）继续有效，不需要重写 `moov`。
 * 2. 可以直接对解密后的文件做 Range 请求，不需要临时拼接。
 * 3. 不需要 ffmpeg 重封装。
 *
 * 实测 1080p（14.7 MB）解密中位数 62 ms，冷启动 261–306 ms，约 240 MB/s。
 */

import { createDecipheriv } from 'node:crypto';
import { planTracks, type TrackPlan } from '@mlzwl/hongguo-shared';

export class CencError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CencError';
  }
}

export interface DecryptResult {
  /** 已解密的完整 MP4 字节。与输入等长。 */
  buffer: Uint8Array;
  tracks: Array<{ entryType: string; clearType: string; sampleCount: number; ivSize: number }>;
}

function decryptSample(
  decipher: ReturnType<typeof createDecipheriv>,
  src: Uint8Array,
  dst: Uint8Array,
  offset: number,
): void {
  const out = decipher.update(src);
  dst.set(out, offset);
}

function decryptTrack(buf: Uint8Array, plan: TrackPlan, key: Uint8Array): void {
  const { samples, offsets, sizes, tenc } = plan;
  if (samples.length !== offsets.length) {
    throw new CencError(`senc has ${samples.length} samples but stbl has ${offsets.length}`);
  }
  if (tenc.ivSize !== 8 && tenc.ivSize !== 16) {
    throw new CencError(`unsupported IV size ${tenc.ivSize} (expected 8 or 16)`);
  }

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const offset = offsets[i];
    const size = sizes[i];
    if (sample === undefined || offset === undefined || size === undefined) {
      throw new CencError(`inconsistent sample table at index ${i}`);
    }

    // CENC 的 IV 是 16 字节 AES 计数器。ivSize = 8 时，明文 IV 填在**高** 8 字节，
    // 低 8 字节从 0 开始计数；ivSize = 16 时直接用整个 IV。
    const counter = new Uint8Array(16);
    if (tenc.ivSize === 8) {
      counter.set(sample.iv.subarray(0, 8), 0);
    } else {
      counter.set(sample.iv.subarray(0, 16), 0);
    }

    const decipher = createDecipheriv('aes-128-ctr', key, counter);

    if (sample.subsamples.length === 0) {
      const end = offset + size;
      if (end > buf.length) {
        throw new CencError(`sample ${i} overruns file (${end} > ${buf.length})`);
      }
      decryptSample(decipher, buf.subarray(offset, end), buf, offset);
      continue;
    }

    /*
     * subsample 必须在**本 sample 的边界内**闭合。
     *
     * 只检查 `buf.length` 不够：畸形文件可以让 subsample 声明越过当前 sample
     * 但仍落在整个文件内，那样会静默解密下一个 sample 的字节，破坏偏移表。
     * 这里改为 fail-closed：越界即抛错，绝不跨界写入。
     */
    const sampleEnd = offset + size;
    if (sampleEnd > buf.length) {
      throw new CencError(`sample ${i} overruns file (${sampleEnd} > ${buf.length})`);
    }

    let cursor = offset;
    for (const sub of sample.subsamples) {
      cursor += sub.clearBytes;
      if (sub.encryptedBytes > 0) {
        const end = cursor + sub.encryptedBytes;
        if (end > sampleEnd) {
          throw new CencError(
            `subsample overruns sample ${i} (${end} > ${sampleEnd}); subsample table is inconsistent`,
          );
        }
        decryptSample(decipher, buf.subarray(cursor, end), buf, cursor);
        cursor = end;
      }
    }

    // clear 段累计也可能越过 sample 末尾（没有 encrypted 段可触发上面的检查）。
    if (cursor > sampleEnd) {
      throw new CencError(`subsamples overrun sample ${i} (${cursor} > ${sampleEnd})`);
    }
  }

  // 把 sample entry 类型改回明文类型，并清掉 tenc 的保护位。
  // 否则某些 demuxer 会认为内容仍是加密的而拒绝解码。
  const entryTypeOffset = plan.sampleEntryOffset + 4;
  for (let i = 0; i < 4; i += 1) {
    buf[entryTypeOffset + i] = plan.clearType.charCodeAt(i);
  }
  buf[tenc.protectedFlagOffset] = 0;
}

export interface DecryptOptions {
  /**
   * 回退路径的告警出口。
   *
   * `planTracks` 在读不到 `sinf/frma` 时会回退到固定映射（`encv → hvc1`）。
   * 回退能用，但意味着上游容器变了，值得记一条。不传时静默。
   */
  onWarn?: (message: string) => void;
}

/**
 * 原地解密一个 CENC 加密的 MP4。
 *
 * @param input 加密文件字节。函数会**直接修改**这个数组。
 * @param keyHex 16 字节 AES 密钥的小写 hex。
 * @throws {CencError} 结构不支持或样本表不一致。
 */
export function decryptCenc(input: Uint8Array, keyHex: string, options: DecryptOptions = {}): DecryptResult {
  const key = hexKey(keyHex);
  const plans = planTracks(input, options.onWarn === undefined ? {} : { onWarn: options.onWarn });
  if (plans.length === 0) {
    throw new CencError('no encrypted tracks found (file may already be clear)');
  }

  const tracks: DecryptResult['tracks'] = [];
  for (const plan of plans) {
    decryptTrack(input, plan, key);
    tracks.push({
      entryType: plan.entryType,
      clearType: plan.clearType,
      sampleCount: plan.samples.length,
      ivSize: plan.tenc.ivSize,
    });
  }

  return { buffer: input, tracks };
}

function hexKey(keyHex: string): Uint8Array {
  if (keyHex.length !== 32) {
    throw new CencError(`key must be 32 hex characters, got ${keyHex.length}`);
  }
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    const byte = Number.parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new CencError(`invalid hex in key at offset ${i * 2}`);
    }
    key[i] = byte;
  }
  return key;
}
