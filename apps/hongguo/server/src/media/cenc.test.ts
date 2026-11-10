import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planTracks } from '@mlzwl/hongguo-shared';
import { decryptCenc } from './cenc.js';

/**
 * 用真实加密样本验证解密。
 *
 * 样本不入库（版权 + 体积），放在 `/tmp/probe`。文件不存在时整组跳过，
 * 这样 CI 里不会因为缺样本而红。本地要跑的话先按
 * `docs/implementation-notes.md` 第 4.3 节的方式抓一份。
 *
 * **重要**：文件和密钥必须来自同一次 `resolvePlayback` 调用。跨调用混用会
 * 得到「密钥不匹配」的假失败（ffmpeg 报 Invalid NAL unit size）。
 */
const FIXTURES = [
  { file: '/tmp/probe/fresh360.mp4', key: 'd09eb1c35ad295141fccc28c84369aba', label: '360p' },
  { file: '/tmp/probe/fresh1080.mp4', key: 'd09eb1c35ad295141fccc28c84369aba', label: '1080p' },
];

const available = FIXTURES.filter((fixture) => existsSync(fixture.file));

describe.skipIf(available.length === 0)('decryptCenc', () => {
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
    const fixture = available[0];
    if (fixture === undefined) {
      return;
    }
    const encrypted = new Uint8Array(readFileSync(fixture.file));
    const plans = planTracks(encrypted);
    expect(plans.map((plan) => plan.entryType)).toEqual(['encv', 'enca']);
    // 实测 360p 与 1080p 的样本数相同：视频 3524，音频 6326。
    expect(plans[0]?.samples.length).toBe(3524);
    expect(plans[1]?.samples.length).toBe(6326);
  });

  it('rejects a key of the wrong length', () => {
    const fixture = available[0];
    if (fixture === undefined) {
      return;
    }
    const encrypted = new Uint8Array(readFileSync(fixture.file));
    expect(() => decryptCenc(encrypted, 'deadbeef')).toThrow(/32 hex characters/);
  });
});
