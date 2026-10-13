import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLaunchdManifest, writeLaunchdManifest } from '../../src/daemon/launchd.js';

describe('launchd manifest rendering', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('renders an inert user-agent manifest and writes it privately without invoking launchctl', async () => {
    const manifest = renderLaunchdManifest({
      label: 'ai.x-connect.lark-pi-bridge.default',
      programArguments: ['/usr/local/bin/node', '/package/dist/cli.js', '--home', '/private/home', 'run'],
      workingDirectory: '/private/home',
      standardOutPath: '/private/home/logs/out.log',
      standardErrorPath: '/private/home/logs/error.log',
    });
    expect(manifest).toContain('<key>RunAtLoad</key>\n  <false/>');
    expect(manifest).toContain('<key>KeepAlive</key>\n  <false/>');
    expect(manifest).not.toContain('launchctl');
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-launchd-'));
    cleanup.push(root);
    const path = join(root, 'runtime', 'agent.plist');
    await writeLaunchdManifest(path, manifest);
    expect(await readFile(path, 'utf8')).toBe(manifest);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects a label outside the bridge namespace', () => {
    expect(() =>
      renderLaunchdManifest({
        label: 'evil.agent',
        programArguments: ['node'],
        workingDirectory: '/',
        standardOutPath: '/tmp/out',
        standardErrorPath: '/tmp/error',
      }),
    ).toThrow(/invalid launchd label/);
  });
});
