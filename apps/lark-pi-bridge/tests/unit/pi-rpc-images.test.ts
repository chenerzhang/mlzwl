import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRpcImages } from '../../src/agent/pi/rpc-images.js';

describe('Pi RPC images', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('converts a validated private image to protocol base64 without a path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-rpc-image-'));
    cleanup.push(root);
    const path = join(root, 'image.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(path, bytes, { mode: 0o600 });
    const images = await readRpcImages([path]);
    expect(images).toEqual([{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }]);
    expect(JSON.stringify(images)).not.toContain(path);
  });

  it('rejects symlinks, forged content, empty and oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-rpc-image-invalid-'));
    cleanup.push(root);
    const real = join(root, 'real.png');
    await writeFile(real, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { mode: 0o600 });
    const link = join(root, 'link.png');
    await symlink(real, link);
    await expect(readRpcImages([link])).rejects.toThrow(/non-symlink/);
    const forged = join(root, 'forged.png');
    await writeFile(forged, 'not-an-image', { mode: 0o600 });
    await expect(readRpcImages([forged])).rejects.toThrow(/content/);
    const empty = join(root, 'empty.png');
    await writeFile(empty, '', { mode: 0o600 });
    await chmod(empty, 0o600);
    await expect(readRpcImages([empty])).rejects.toThrow(/size/);
  });
});
