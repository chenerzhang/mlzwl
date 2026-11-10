import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 设备档案存储。
 *
 * 档案是「一台手机」的匿名身份，约 605 字节 JSON。必须持久化：不保存的话每次
 * 进程重启都会注册新设备，服务端会开始拒绝（返回 device_id: 0）。
 *
 * 现在用 JSON 文件（上游 fileProfileStore 的做法），下一步换成 SQLite 时只需
 * 替换这个类的实现，接口不变。
 */
export interface ProfileStore {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
  reset(): Promise<void>;
}

export class FileProfileStore implements ProfileStore {
  constructor(private readonly path: string) {}

  async load(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(json: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, json, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  async reset(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
