import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionCatalog, sessionCatalogKey } from '../../src/session/catalog.js';
import { pruneSessions } from '../../src/session/retention.js';
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

  it('does not remove a catalog entry changed after a retention snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-catalog-cas-'));
    paths.push(root);
    const path = join(root, 'sessions.json');
    const identity = { scopeId: 'scope', cwdRealpath: '/repo', policyFingerprint: 'policy' };
    const catalog = new SessionCatalog(path);
    await catalog.load();
    await catalog.upsertActive(identity, 'session-old');
    const [snapshot] = catalog.values();
    await catalog.upsertActive(identity, 'session-new');
    const mutation = await catalog.removeEntries([snapshot!]);
    expect(mutation.removed).toEqual([]);
    expect(catalog.activeFor(identity)?.sessionId).toBe('session-new');
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

  it('prunes expired active, archived, and orphan sessions while preserving recent data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-retention-'));
    paths.push(root);
    const catalogPath = join(root, 'sessions.json.catalog.json');
    const sessionDir = join(root, 'pi-agent', 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const now = Date.UTC(2026, 0, 120);
    const old = now - 100 * 24 * 60 * 60_000;
    const recent = now - 2 * 24 * 60 * 60_000;
    const identities = ['active-old', 'active-recent', 'archived-old', 'missing'].map((scopeId) => ({
      scopeId,
      cwdRealpath: `/${scopeId}`,
      policyFingerprint: `policy-${scopeId}`,
    }));
    await writeFile(
      catalogPath,
      `${JSON.stringify(
        identities.map((identity, index) => ({
          key: sessionCatalogKey(identity),
          ...identity,
          sessionId: index === 3 ? 'missing-session' : identity.scopeId,
          status: identity.scopeId.startsWith('archived') ? 'archived' : 'active',
          updatedAt: identity.scopeId === 'active-recent' ? recent : old,
        })),
      )}\n`,
    );
    for (const [id, timestamp] of [
      ['active-old', old],
      ['active-recent', old],
      ['archived-old', old],
      ['orphan-old', old],
      ['orphan-recent', recent],
    ] as const) {
      const path = join(sessionDir, `${id}.jsonl`);
      await writeFile(path, `${JSON.stringify({ type: 'session', version: 3, id, cwd: '/repo' })}\n`);
      await utimes(path, timestamp / 1_000, timestamp / 1_000);
    }

    const preview = await pruneSessions({
      sessionDir,
      catalogFile: catalogPath,
      policy: { enabled: true, activeDays: 90, archivedDays: 7, orphanDays: 7 },
      dryRun: true,
      now,
    });
    expect(preview).toMatchObject({
      dryRun: true,
      scannedFiles: 5,
      activeKept: 1,
      orphanKept: 1,
      filesDeleted: 0,
      staleCatalogWouldDelete: 1,
      wouldDelete: { 'active-expired': 1, 'archived-expired': 1, 'orphan-expired': 1 },
    });
    expect(await stat(join(sessionDir, 'active-old.jsonl'))).toBeDefined();

    const applied = await pruneSessions({
      sessionDir,
      catalogFile: catalogPath,
      policy: { enabled: true, activeDays: 90, archivedDays: 7, orphanDays: 7 },
      dryRun: false,
      now,
    });
    expect(applied).toMatchObject({
      dryRun: false,
      filesDeleted: 3,
      catalogEntriesDeleted: 3,
      staleCatalogDeleted: 1,
      warnings: 0,
    });
    await expect(stat(join(sessionDir, 'active-old.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(sessionDir, 'archived-old.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(sessionDir, 'orphan-old.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(join(sessionDir, 'active-recent.jsonl'))).toBeDefined();
    expect(await stat(join(sessionDir, 'orphan-recent.jsonl'))).toBeDefined();
    const remaining = new SessionCatalog(catalogPath);
    await remaining.load();
    expect(remaining.values().map((entry) => entry.sessionId)).toEqual(['active-recent']);
  });

  it('keeps malformed, duplicate, and symlink session entries and suppresses uncertain stale-catalog cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-retention-unsafe-'));
    paths.push(root);
    const catalogPath = join(root, 'sessions.json.catalog.json');
    const sessionDir = join(root, 'sessions');
    await mkdir(sessionDir, { recursive: true });
    const identity = { scopeId: 'missing', cwdRealpath: '/repo', policyFingerprint: 'policy' };
    await writeFile(
      catalogPath,
      `${JSON.stringify([{ key: sessionCatalogKey(identity), ...identity, sessionId: 'missing', status: 'active', updatedAt: 1 }])}\n`,
    );
    await writeFile(join(sessionDir, 'bad.jsonl'), '{bad}\n');
    await writeFile(join(sessionDir, 'duplicate-a.jsonl'), `${JSON.stringify({ type: 'session', id: 'duplicate' })}\n`);
    await writeFile(join(sessionDir, 'duplicate-b.jsonl'), `${JSON.stringify({ type: 'session', id: 'duplicate' })}\n`);
    await symlink(join(sessionDir, 'duplicate-a.jsonl'), join(sessionDir, 'linked.jsonl'));

    const result = await pruneSessions({
      sessionDir,
      catalogFile: catalogPath,
      policy: { enabled: true, activeDays: 90, archivedDays: 7, orphanDays: 7 },
      dryRun: false,
      now: 200 * 24 * 60 * 60_000,
    });
    expect(result).toMatchObject({ filesDeleted: 0, catalogEntriesDeleted: 0, staleCatalogDeleted: 0 });
    expect(result.warnings).toBeGreaterThanOrEqual(3);
    const remaining = new SessionCatalog(catalogPath);
    await remaining.load();
    expect(remaining.values()).toHaveLength(1);
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
