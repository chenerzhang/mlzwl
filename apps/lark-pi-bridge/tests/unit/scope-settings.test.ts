import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScopeSettingsStore } from '../../src/session/scope-settings.js';

describe('ScopeSettingsStore', () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
  it('persists a scope-local workspace alias and timeout without session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-settings-'));
    paths.push(root);
    const path = join(root, 'scope-settings.json');
    const store = new ScopeSettingsStore(path);
    await store.update('oc_chat:thread', {
      workspaceAlias: 'api',
      idleTimeoutMinutes: 15,
      accessMode: 'read-only',
    });
    const reloaded = new ScopeSettingsStore(path);
    await reloaded.load();
    expect(reloaded.get('oc_chat:thread')).toMatchObject({
      workspaceAlias: 'api',
      idleTimeoutMinutes: 15,
      accessMode: 'read-only',
    });
  });
});
