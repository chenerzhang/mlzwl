import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentStore, downloadAndStoreImages, storeImageAttachments } from '../../src/media/attachments.js';

describe('image attachments', () => {
  const paths: string[] = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary');
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  it('stores supported bounded image bytes under a safe filename', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-pi-media-'));
    paths.push(dir);
    const result = await storeImageAttachments(dir, [
      { fileKey: 'image/key', fileName: '../unsafe name.png', mimeType: 'image/png', bytes: png },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toContain(dir);
    expect(await readFile(result[0]!.path)).toEqual(png);
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(result[0]!.path)).mode & 0o777).toBe(0o600);
    }
  });
  it('downloads only image descriptors through the channel callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-pi-media-'));
    paths.push(dir);
    const result = await downloadAndStoreImages(
      dir,
      [{ messageId: 'om_message', fileKey: 'img_key', type: 'image' }],
      async (messageId, fileKey, type) => {
        expect({ messageId, fileKey, type }).toEqual({ messageId: 'om_message', fileKey: 'img_key', type: 'image' });
        return { buffer: webp, contentType: 'image/webp; charset=binary' };
      },
    );
    expect(result[0]!.mimeType).toBe('image/webp');
  });

  it('rejects unsupported input before persistence and rolls back partial writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-media-'));
    paths.push(root);
    const dir = join(root, 'run');
    await expect(
      storeImageAttachments(dir, [
        { fileKey: 'valid', mimeType: 'image/png', bytes: png },
        { fileKey: 'x', mimeType: 'application/pdf', bytes: Buffer.from('%PDF') },
      ]),
    ).rejects.toThrow(/不支持/);
    await expect(readdir(dir)).rejects.toThrow();
  });

  it('detects missing MIME types and rejects forged or unknown image bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-media-detect-'));
    paths.push(root);
    const inferred = await downloadAndStoreImages(
      join(root, 'inferred'),
      [{ messageId: 'message', fileKey: 'image', type: 'image' }],
      async () => ({ buffer: png }),
    );
    expect(inferred[0]!.mimeType).toBe('image/png');
    await expect(
      storeImageAttachments(join(root, 'forged'), [
        { fileKey: 'forged', mimeType: 'image/png', bytes: Buffer.from('%PDF') },
      ]),
    ).rejects.toThrow(/内容与声明类型不匹配/);
    await expect(
      downloadAndStoreImages(
        join(root, 'unknown'),
        [{ messageId: 'message', fileKey: 'unknown', type: 'image' }],
        async () => ({ buffer: Buffer.from('not-an-image') }),
      ),
    ).rejects.toThrow(/不支持的图片类型/);
  });

  it('owns attachments by run and removes them after release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-media-run-'));
    paths.push(root);
    const store = new AttachmentStore(root);
    await store.initialize();
    const result = await store.downloadRun(
      'run-a',
      [{ messageId: 'message', fileKey: 'image', type: 'image' }],
      async () => ({ buffer: png, contentType: 'image/png' }),
    );
    expect(result[0]?.path).toContain(join(root, 'run-a'));
    await store.release('run-a');
    expect(await readdir(root)).toEqual([]);
  });

  it('sweeps stale and excess crashed runs without removing an active run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-media-sweep-'));
    paths.push(root);
    for (const name of ['stale', 'recent']) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'image.png'), 'x');
    }
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(join(root, 'stale'), old, old);
    const store = new AttachmentStore(root, { staleAgeMs: 30_000, maxStaleRuns: 1 });
    await store.initialize();
    expect(await readdir(root)).toEqual(['recent']);

    await store.downloadRun('active', [{ messageId: 'message', fileKey: 'image', type: 'image' }], async () => ({
      buffer: png,
      contentType: 'image/png',
    }));
    const futureStore = store as AttachmentStore;
    await futureStore.sweep();
    expect((await readdir(root)).sort()).toEqual(['active', 'recent']);
    await store.release('active');
  });
});
