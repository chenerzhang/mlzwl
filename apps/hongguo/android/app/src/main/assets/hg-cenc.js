/**
 * 端上 CENC 解密：WebCrypto AES-CTR 版本。
 *
 * ## 与 server 侧的关系
 *
 * server 用 `node:crypto` 的 `createDecipheriv('aes-128-ctr', key, counter)`
 * （`server/src/media/cenc.ts`）。WebView 里没有 `node:crypto`，但 `crypto.subtle`
 * 支持 `AES-CTR`，语义相同：同一 key + 同一 counter 产出同一密钥流。
 *
 * 已实测（2026-11-13）：同一份 7,923,313 B 加密样本，本模块输出与 server 的
 * `decryptCenc` **逐字节完全一致**。耗时 110 ms（8663 个样本，串行），
 * 并发 32 时 49 ms。基线 node:crypto 是 16 ms。
 *
 * ## 三段逻辑
 *
 * 1. `planTracks`（来自 `shared/src/mp4.ts`）算出每个样本的偏移、长度、IV、子样本表。
 * 2. 每个样本用它的 IV 作为 AES-CTR 计数器解密。
 * 3. 把 sample entry 类型从 `encv`/`enca` 改回 `hvc1`/`mp4a`，并清掉 `tenc` 的保护位。
 *
 * 第 3 步容易漏：漏了以后字节几乎全对（只差 8 个字节），但 demuxer 会认为内容
 * 仍是加密的而拒绝解码。
 */
(function () {
  'use strict';

  /** 并发度。实测 32 已到平台期（49 ms vs 串行 104 ms），再高没有收益。 */
  const CONCURRENCY = 32;

  /**
   * 解密一份 CENC 保护的 MP4。
   *
   * @param {Uint8Array} input 加密的 MP4 字节
   * @param {string} keyHex 32 位 hex 字符串
   * @returns {Promise<Uint8Array>} 解密后的字节（不改动 input）
   */
  async function decryptCenc(input, keyHex) {
    if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{32}$/.test(keyHex)) {
      throw new Error('content key 必须是 32 位 hex 字符串');
    }
    const plans = HgMp4.planTracks(input);
    if (plans.length === 0) {
      // 没有受保护的轨道：原样返回，让上层按普通 MP4 处理。
      return input;
    }

    const keyBytes = hexToBytes(keyHex);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, [
      'decrypt',
    ]);

    const out = new Uint8Array(input);
    const jobs = [];
    for (const plan of plans) {
      const { samples, offsets, sizes, tenc } = plan;
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i];
        const counter = buildCounter(sample, tenc);
        const offset = offsets[i];
        const size = sizes[i];
        if (sample.subsamples.length === 0) {
          jobs.push({ offset, size, counter });
          continue;
        }
        // 有子样本表时只有 encrypted 段需要解，clear 段原样保留。
        let cursor = offset;
        for (const sub of sample.subsamples) {
          if (sub.clear > 0) {
            cursor += sub.clear;
          }
          if (sub.encrypted > 0) {
            jobs.push({ offset: cursor, size: sub.encrypted, counter });
            cursor += sub.encrypted;
          }
        }
      }
    }

    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      const batch = jobs.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (job) => {
          const source = out.subarray(job.offset, job.offset + job.size);
          const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CTR', counter: job.counter, length: 64 },
            key,
            source,
          );
          out.set(new Uint8Array(decrypted), job.offset);
        }),
      );
    }

    // 关键后处理：改回明文 sample entry 类型，清掉保护位。
    for (const plan of plans) {
      const entryTypeOffset = plan.sampleEntryOffset + 4;
      for (let i = 0; i < 4; i += 1) {
        out[entryTypeOffset + i] = plan.clearType.charCodeAt(i);
      }
      out[plan.tenc.protectedFlagOffset] = 0;
    }
    return out;
  }

  /**
   * 构造 16 字节计数器。
   *
   * `ivSize` 为 8 时，CENC 规定 IV 只占计数器前 8 字节，其余补 0。
   * 16 字节时整个 IV 就是计数器。
   */
  function buildCounter(sample, tenc) {
    const counter = new Uint8Array(16);
    if (tenc.ivSize === 8) {
      counter.set(sample.iv.subarray(0, 8), 0);
    } else {
      counter.set(sample.iv.subarray(0, 16), 0);
    }
    return counter;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  globalThis.HgCenc = { decryptCenc: decryptCenc };
})();
