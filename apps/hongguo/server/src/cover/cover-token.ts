import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MAX_COVER_TOKEN_LENGTH } from '@mlzwl/hongguo-shared';

/**
 * 封面令牌：把上游签名 URL 封成不透明字符串。
 *
 * 为什么不能直接把上游 URL 放进查询参数：
 * 上游封面是签名 URL，`x-signature` / `x-expires` 就在里面。放进 URL 后浏览器
 * 能从 DOM、网络面板、地址栏和 localStorage 全部读到它，等于把签名交给客户端。
 * URL 编码不是脱敏，`decodeURIComponent` 一步就能还原。
 *
 * 为什么用加密而不是服务端映射表：
 * 1. 映射表要么无界增长，要么需要 TTL 淘汰，还要考虑重启后旧地址全部失效
 *    （浏览器 localStorage 里的收藏、观看记录、离线目录会一起变成 404）。
 * 2. 加密把「还原上游 URL」变成纯函数，不需要任何存储，重启后旧令牌依然有效。
 * 3. 令牌长度与上游 URL 成正比但恒定可解，不会因为淘汰策略出现「昨天能看的封面今天 404」。
 *
 * 用 AES-256-GCM 而不是 HMAC 摘要：摘要只能验证、不能还原，仍然需要映射表。
 * GCM 自带认证标签，令牌被篡改会直接解密失败，不会解出一个伪造地址。
 */

export { MAX_COVER_TOKEN_LENGTH };

/** 密钥文件的权限：仅属主可读写。 */
const KEY_MODE = 0o600;

/**
 * 把密钥文件权限收紧到 `0600`。
 *
 * 失败时抛出而不是吞掉：权限没收紧意味着密钥可被同机其他用户读取，而密钥能解出
 * 全部上游签名地址。宁可启动失败，也不要带着一个可读的密钥继续跑。
 */
async function restrictKeyPermissions(file: string): Promise<void> {
  await chmod(file, KEY_MODE);
}

/** 该错误是否表示「文件不存在」。只认 `ENOENT`，其他错误都要往上抛。 */
function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** 该错误是否表示「文件已存在」。排他创建失败时用它区分竞态与真实错误。 */
function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

/** 令牌格式版本。将来换算法时靠它区分，旧令牌可以按需继续解。 */
const TOKEN_VERSION = 1;

/** AES-256-GCM 的 IV 长度。每次加密都必须是新的随机值。 */
const IV_BYTES = 12;
/** GCM 认证标签长度。 */
const TAG_BYTES = 16;

/**
 * 令牌编解码器。
 *
 * 密钥从磁盘读一次后常驻内存。密钥文件权限设为 `0600`：它只保护「上游地址不可读」，
 * 不保护任何上游凭据——上游签名仍在密文里，只是需要密钥才能读出。
 */
export class CoverTokenCodec {
  private constructor(private readonly key: Buffer) {}

  /**
   * 从 `file` 读取密钥；不存在时生成一个并写入。
   *
   * 目录用 `mkdir -p`，文件用 `chmod 0600`。失败直接抛出：拿不到稳定密钥时
   * 生成的令牌重启就解不开，宁可启动失败也不要产生一批「明天就失效」的地址。
   */
  static async loadOrCreate(file: string): Promise<CoverTokenCodec> {
    // 只把 `ENOENT` 当成「还没有密钥」。其余错误（`EACCES`、I/O 故障）必须原样抛出：
    // 若把「存在但读不到」也当成缺失，下一步会 `writeFile` 覆盖掉那把仍然有效的密钥，
    // 于是此前签发的全部封面令牌一起失效，而用户看到的只是「封面全挂了」。
    const existing = await readFile(file).catch((error: unknown) => {
      if (isMissingFileError(error)) {
        return null;
      }
      throw error;
    });
    if (existing !== null && existing.length === 32) {
      // 已存在的密钥也要收紧权限：文件可能是上一版程序建的、被手工 `chmod 644`
      // 的、或从备份恢复时带了宽权限。**不吞错误**——权限收不紧等于密钥可被同机
      // 其他用户读取，而密钥能解出全部上游签名地址。
      await restrictKeyPermissions(file);
      return new CoverTokenCodec(existing);
    }
    const key = randomBytes(32);
    await mkdir(dirname(file), { recursive: true });
    // 先写一个完整的临时文件（`0600`），再用 `link` 把它**原子地**发布到目标路径。
    //
    // 为什么不用 `writeFile(..., { flag: 'wx' })`：`wx` 只在目录项创建时才排他，
    // 而内容随后才写入。两个进程同时启动时，输的一方可能在胜者还没写完就读到
    // 0～31 字节，误判成「密钥损坏」。`link` 只有在源文件已完整落盘后才让目标
    // 路径出现，读到的内容一定是完整的。
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      // 先把完整密钥写进临时文件。`mode` 只在创建时生效，但这里不会复用已存在的
      // 临时文件名（带随机后缀），所以权限一定是 `0600`。
      await writeFile(temp, key, { mode: 0o600 });
      try {
        await link(temp, file);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
        // 竞态失败：别的进程已经发布了密钥，用它而不是自己这把。
        const raced = await readFile(file);
        if (raced.length !== 32) {
          throw new Error(`cover token key at ${file} has unexpected length ${raced.length}`, { cause: error });
        }
        await restrictKeyPermissions(file);
        return new CoverTokenCodec(raced);
      }
      await restrictKeyPermissions(file);
      return new CoverTokenCodec(key);
    } finally {
      /*
        无论成功、竞态失败还是 `writeFile` 自己失败，临时文件都必须删掉。
        `rm` 放在 `finally` 而不是各分支里：`writeFile` 可能在创建文件后
        才报错（磁盘满、部分写入），漏掉这一支会在 DATA_DIR 里堆半截密钥文件。
        `force: true` 只忽略「文件不存在」，其它错误（EACCES、I/O）照常抛出。
      */
      await rm(temp, { force: true });
    }
  }

  /** 仅用于测试：直接给定密钥，不落盘。 */
  static fromKey(key: Buffer): CoverTokenCodec {
    if (key.length !== 32) {
      throw new Error('cover token key must be 32 bytes');
    }
    return new CoverTokenCodec(key);
  }

  /**
   * 把上游 URL 封成不透明令牌。
   *
   * 输出是 base64url：可以安全放进路径段，不需要再 `encodeURIComponent`。
   */
  seal(upstream: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    // 版本号也进认证范围：改版本号会让标签校验失败，不能只改前缀绕过。
    cipher.setAAD(Buffer.from([TOKEN_VERSION]));
    const ciphertext = Buffer.concat([cipher.update(upstream, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([TOKEN_VERSION]), iv, tag, ciphertext]).toString('base64url');
  }

  /**
   * 还原上游 URL。令牌不合法、被篡改或版本不认识时返回 `null`。
   *
   * 返回 `null` 而不是抛错：控制器要把「令牌坏了」当成 400 调用方错误处理，
   * 用返回值比用异常更容易在调用点区分「我们拒了」与「上游坏了」。
   */
  open(token: string): string | null {
    let raw: Buffer;
    try {
      raw = Buffer.from(token, 'base64url');
    } catch {
      return null;
    }
    // 版本 1 字节 + IV 12 字节 + 标签 16 字节，再加至少 1 字节密文。
    if (raw.length < 1 + IV_BYTES + TAG_BYTES + 1) {
      return null;
    }
    if (raw[0] !== TOKEN_VERSION) {
      return null;
    }
    const iv = raw.subarray(1, 1 + IV_BYTES);
    const tag = raw.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(1 + IV_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from([TOKEN_VERSION]));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // 标签校验失败、密文被截断、密钥不匹配都走这里。
      return null;
    }
  }
}
