import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionCatalog } from '../../src/session/catalog.js';
import { ScopeSettingsStore } from '../../src/session/scope-settings.js';

describe('concurrent private session persistence', () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('merges concurrent catalog mutations from stale in-memory instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-catalog-concurrent-'));
    paths.push(root);
    const path = join(root, 'sessions.json');
    const first = new SessionCatalog(path);
    const second = new SessionCatalog(path);
    await Promise.all([first.load(), second.load()]);
    await Promise.all([
      first.upsertActive({ scopeId: 'a', cwdRealpath: '/a', policyFingerprint: 'one' }, 'session-a'),
      second.upsertActive({ scopeId: 'b', cwdRealpath: '/b', policyFingerprint: 'two' }, 'session-b'),
    ]);
    const loaded = new SessionCatalog(path);
    await loaded.load();
    expect(
      loaded
        .values()
        .map((entry) => entry.sessionId)
        .sort(),
    ).toEqual(['session-a', 'session-b']);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('merges concurrent scope updates instead of letting an old snapshot win', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-settings-concurrent-'));
    paths.push(root);
    const path = join(root, 'scope-settings.json');
    const first = new ScopeSettingsStore(path);
    const second = new ScopeSettingsStore(path);
    await Promise.all([first.load(), second.load()]);
    await Promise.all([
      first.update('scope-a', { workspaceAlias: 'a' }),
      second.update('scope-b', { idleTimeoutMinutes: 5, accessMode: 'read-only' }),
    ]);
    const loaded = new ScopeSettingsStore(path);
    await loaded.load();
    expect(loaded.get('scope-a')).toMatchObject({ workspaceAlias: 'a' });
    expect(loaded.get('scope-b')).toMatchObject({ idleTimeoutMinutes: 5, accessMode: 'read-only' });
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed on corrupted persisted state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-persistence-corrupt-'));
    paths.push(root);
    const catalogPath = join(root, 'sessions.json');
    const settingsPath = join(root, 'scope-settings.json');
    await writeFile(catalogPath, '{bad', { mode: 0o644 });
    await writeFile(settingsPath, JSON.stringify([{ scopeId: 'missing-updated-at' }]), { mode: 0o644 });
    await expect(new SessionCatalog(catalogPath).load()).rejects.toThrow();
    await expect(new ScopeSettingsStore(settingsPath).load()).rejects.toThrow(/invalid entry/);
    await chmod(catalogPath, 0o600);
  });

  it('rejects a catalog entry whose persisted key does not match its identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-catalog-key-'));
    paths.push(root);
    const path = join(root, 'sessions.json');
    await writeFile(
      path,
      `${JSON.stringify([
        {
          key: 'forged',
          scopeId: 'scope',
          cwdRealpath: '/repo',
          policyFingerprint: 'policy',
          sessionId: 'session',
          status: 'active',
          updatedAt: Date.now(),
        },
      ])}\n`,
    );
    await expect(new SessionCatalog(path).load()).rejects.toThrow(/invalid entry/);
    expect(await readFile(path, 'utf8')).toContain('forged');
  });
});
