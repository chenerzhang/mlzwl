import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoverTokenCodec, MAX_COVER_TOKEN_LENGTH } from './cover-token.js';

const UPSTREAM =
  'https://p3-reading-sign.fqnovelpic.com/novel-pic/abc~tplv-x:400:0.heic?lk3s=64477e16&x-expires=1799667985&x-signature=Kdoqgcf2bGS34IBHQFSZBzkrjlg%3D';

const key = randomBytes(32);
const codec = CoverTokenCodec.fromKey(key);

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CoverTokenCodec seal/open', () => {
  it('round-trips an upstream URL', () => {
    expect(codec.open(codec.seal(UPSTREAM))).toBe(UPSTREAM);
  });

  it('produces a token that does not contain the upstream host or signature', () => {
    const token = codec.seal(UPSTREAM);
    // 这是本模块存在的唯一理由：浏览器看到令牌，看不到签名。
    expect(token).not.toContain('fqnovelpic');
    expect(token).not.toContain('x-signature');
    expect(token).not.toContain('Kdoqgcf2bGS34IBHQFSZBzkrjlg');
    // base64url 只含这些字符，可以安全放进路径段。
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is url-safe and never needs further encoding', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = codec.seal(`https://p3-reading-sign.fqnovelpic.com/x${i}.heic?a=${i}`);
      expect(encodeURIComponent(token)).toBe(token);
    }
  });

  it('produces a different token for the same input each time', () => {
    // 每次加密都用新 IV；令牌相同会让「同一封面」在网络层可被关联。
    expect(codec.seal(UPSTREAM)).not.toBe(codec.seal(UPSTREAM));
  });

  it('rejects a token sealed with a different key', () => {
    const other = CoverTokenCodec.fromKey(randomBytes(32));
    expect(codec.open(other.seal(UPSTREAM))).toBeNull();
  });

  it('rejects tampered ciphertext', () => {
    const token = codec.seal(UPSTREAM);
    const raw = Buffer.from(token, 'base64url');
    // 改最后一个字节（密文尾部）。
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    expect(codec.open(raw.toString('base64url'))).toBeNull();
  });

  it('rejects tampered auth tag', () => {
    const raw = Buffer.from(codec.seal(UPSTREAM), 'base64url');
    // 标签在版本(1) + IV(12) 之后。
    raw[13] = (raw[13] ?? 0) ^ 0xff;
    expect(codec.open(raw.toString('base64url'))).toBeNull();
  });

  it('rejects an unknown version byte', () => {
    const raw = Buffer.from(codec.seal(UPSTREAM), 'base64url');
    raw[0] = 99;
    expect(codec.open(raw.toString('base64url'))).toBeNull();
  });

  it('rejects truncated, empty and garbage input', () => {
    expect(codec.open('')).toBeNull();
    expect(codec.open('abc')).toBeNull();
    expect(codec.open('!!!not-base64!!!')).toBeNull();
    // 长度够但内容随机。
    expect(codec.open(randomBytes(64).toString('base64url'))).toBeNull();
  });

  it('does not throw on any input', () => {
    // 控制器直接把用户输入喂进来，抛错会变成 500。
    for (const input of ['', 'a', '\u0000', 'x'.repeat(10_000), '../../etc/passwd']) {
      expect(() => codec.open(input)).not.toThrow();
    }
  });
});

describe('CoverTokenCodec.loadOrCreate', () => {
  it('creates a 0600 key file and reuses it across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cover-token-'));
    tempDirs.push(dir);
    const file = join(dir, 'nested', 'cover.key');

    const first = await CoverTokenCodec.loadOrCreate(file);
    const token = first.seal(UPSTREAM);

    const info = await stat(file);
    // 权限必须收紧：密钥可读等于令牌可解。
    expect(info.mode & 0o777).toBe(0o600);

    // 模拟重启：重新加载必须解出同一个 URL，否则 localStorage 里的旧封面全部 404。
    const second = await CoverTokenCodec.loadOrCreate(file);
    expect(second.open(token)).toBe(UPSTREAM);
  });

  it('refuses to overwrite a key file whose length is not 32 bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cover-token-'));
    tempDirs.push(dir);
    const file = join(dir, 'cover.key');
    await writeFile(file, Buffer.from('too-short'));

    // 长度不对说明这个文件不是本程序写的，或已经损坏。**不能覆盖**：
    // 覆盖会静默丢弃一把可能仍被其他进程使用的密钥。交给人工处理。
    await expect(CoverTokenCodec.loadOrCreate(file)).rejects.toThrow(/unexpected length 9/);
    expect((await readFile(file)).toString()).toBe('too-short');
  });

  it('tightens an existing key file that was left world-readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cover-token-'));
    tempDirs.push(dir);
    const file = join(dir, 'cover.key');
    // 合法长度但权限过宽：可能来自旧版本程序、手工 chmod 或从备份恢复。
    await writeFile(file, Buffer.alloc(32, 7), { mode: 0o644 });
    await chmod(file, 0o644);

    const codec = await CoverTokenCodec.loadOrCreate(file);

    // 必须收紧，且密钥内容不变（收紧权限不能顺手换掉密钥，否则旧令牌全失效）。
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file)).toEqual(Buffer.alloc(32, 7));
    expect(codec.open(codec.seal(UPSTREAM))).toBe(UPSTREAM);
  });

  it('keeps every token well under the declared length limit', () => {
    const codec = CoverTokenCodec.fromKey(Buffer.alloc(32, 3));
    // 3072 字节的上游 URL 是 `MAX_COVER_URL_LENGTH` 假设的上限。
    const longest = `https://p3-reading-sign.fqnovelpic.com/${'a'.repeat(3072)}`;
    const token = codec.seal(longest);

    // 上限必须真的覆盖最长的合法输入，否则会出现「接口给了地址、浏览器 414」。
    expect(token.length).toBeLessThan(MAX_COVER_TOKEN_LENGTH);
    expect(codec.open(token)).toBe(longest);
  });

  it('does not overwrite a readable-but-unwritable key file it cannot read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cover-token-'));
    tempDirs.push(dir);
    const file = join(dir, 'cover.key');
    const original = Buffer.alloc(32, 9);
    await writeFile(file, original, { mode: 0o200 });
    await chmod(file, 0o200);

    // 只写不可读：`readFile` 报 `EACCES`。必须原样抛出，而不是当成「文件不存在」
    // 去重新生成——那会把一把仍然有效的密钥覆盖掉，此前签发的令牌全部失效。
    await expect(CoverTokenCodec.loadOrCreate(file)).rejects.toThrow(/EACCES|permission denied/);
    // 内容没被覆盖：读之前先补上读权限（原权限故意不可读，就是被测场景）。
    await chmod(file, 0o600);
    expect(await readFile(file)).toEqual(original);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => CoverTokenCodec.fromKey(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
