import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { normalizeRootConfig, type RootConfig } from './profile-schema.js';

export async function loadRootConfig(path: string): Promise<RootConfig | undefined> {
  try {
    return normalizeRootConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

export async function saveRootConfig(path: string, config: RootConfig): Promise<void> {
  await writePrivateText(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function writeActiveProfile(path: string, profile: string): Promise<void> {
  await writePrivateText(path, `${profile}\n`);
}

export async function readActiveProfile(path: string): Promise<string | undefined> {
  try {
    const profile = (await readFile(path, 'utf8')).trim();
    return profile || undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

export async function saveAppSecret(path: string, secret: string): Promise<void> {
  if (!secret) {
    throw new Error('App Secret 为空');
  }
  await writePrivateText(path, secret);
}

/** Resolve a profile App Secret without exposing it through argv or stdout. */
export async function resolveAppSecret(
  app: { secret?: string; secretFile?: string },
  configFile: string,
  profileDir?: string,
): Promise<string> {
  if (app.secret) {
    return app.secret;
  }
  if (!app.secretFile) {
    throw new Error('accounts.app is missing secretFile');
  }
  if (isAbsolute(app.secretFile)) {
    throw new Error('App Secret file must be bridge-home-relative');
  }
  const path = resolve(dirname(configFile), app.secretFile);
  if (profileDir && !isPathInside(profileDir, path)) {
    throw new Error(`App Secret file must stay inside the selected profile directory: ${path}`);
  }
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`App Secret path is not a regular file: ${path}`);
  }
  if ((before.mode & 0o077) !== 0) {
    throw new Error(`App Secret file must not be accessible by group/others: ${path}`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`App Secret path changed while opening: ${path}`);
    }
    if ((opened.mode & 0o077) !== 0) {
      throw new Error(`App Secret file must not be accessible by group/others: ${path}`);
    }
    const secret = (await handle.readFile('utf8')).trim();
    if (!secret) {
      throw new Error(`App Secret file is empty: ${path}`);
    }
    return secret;
  } finally {
    await handle.close();
  }
}

async function writePrivateText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function isPathInside(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
