import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { LocalServiceController } from '../../src/daemon/service.js';

describe('LocalServiceController', () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  it('owns one foreground handle and cleans advisory state on stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-'));
    paths.push(root);
    const controller = new LocalServiceController(
      join(root, 'runtime', 'profile.lock'),
      join(root, 'runtime', 'service.pid'),
    );
    let stopped = false;
    const handle = await controller.start(async () => ({
      async stop() {
        stopped = true;
      },
    }));
    expect(await controller.status()).toEqual({ running: true, pid: process.pid, identityMatch: true });
    await handle.stop();
    expect(stopped).toBe(true);
    expect(await controller.status()).toEqual({ running: false });
  });
  it('does not signal an arbitrary stale pid and reports it not running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-'));
    paths.push(root);
    const pidPath = join(root, 'runtime', 'service.pid');
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(pidPath, `${JSON.stringify({ pid: 999999, startedAt: 'stale', writtenAt: 'stale' })}\n`);
    const controller = new LocalServiceController(join(root, 'runtime', 'profile.lock'), pidPath);
    expect(await controller.status()).toEqual({ running: false, pid: 999999, identityMatch: false });
    await expect(controller.stop()).resolves.toBeUndefined();
  });

  it('reclaims a malformed stale lock instead of permanently wedging the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-stale-lock-'));
    paths.push(root);
    const runtime = join(root, 'runtime');
    const lockPath = join(runtime, 'profile.lock');
    await mkdir(runtime, { recursive: true });
    await writeFile(lockPath, 'malformed stale pid\n');
    const controller = new LocalServiceController(lockPath, join(runtime, 'service.pid'));
    const handle = await controller.start(async () => ({ async stop() {} }));
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ pid: process.pid });
    await handle.stop();
  });

  it('treats a live PID with a mismatched start token as stale and never signals it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-service-pid-reuse-'));
    paths.push(root);
    const runtime = join(root, 'runtime');
    const pidPath = join(runtime, 'service.pid');
    await mkdir(runtime, { recursive: true });
    await writeFile(
      pidPath,
      `${JSON.stringify({ pid: process.pid, startedAt: 'not-this-process', writtenAt: 'stale' })}\n`,
    );
    const controller = new LocalServiceController(join(runtime, 'profile.lock'), pidPath);
    expect(await controller.status()).toEqual({ running: false, pid: process.pid, identityMatch: false });
    await expect(controller.stop()).resolves.toBeUndefined();
  });
});
