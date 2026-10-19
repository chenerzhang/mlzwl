import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AtomicFileHooks {
  beforeRename?(tempPath: string, targetPath: string): Promise<void>;
}

/** Persist a private file completely before the atomic rename commit point. */
export async function writePrivateAtomicFile(path: string, content: string, hooks?: AtomicFileHooks): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  let committed = false;
  try {
    await file.writeFile(content);
    await file.chmod(0o600);
    await file.sync();
    const value = await file.stat();
    if (!value.isFile() || (process.platform !== 'win32' && (value.mode & 0o777) !== 0o600)) {
      throw new Error('private atomic file validation failed');
    }
    await hooks?.beforeRename?.(temp, path);
    await file.close();
    await rename(temp, path);
    committed = true;
  } finally {
    await file.close().catch(() => {});
    if (!committed) {
      await unlink(temp).catch(() => {});
    }
  }
  // Rename is the final fallible operation; no post-commit filesystem call is permitted.
}
