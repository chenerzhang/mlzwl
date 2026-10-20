import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentFileIdentity,
  isExactPiSessionId,
  locateHandoffSession,
  removeOwnedForkSession,
  safeCwdDirectoryName,
  snapshotProfileSessionDirectory,
  validateProfileForkSession,
} from '../../src/session/handoff.js';
import { HandoffBindingStore } from '../../src/session/handoff-store.js';

const ID = '12345678-1234-4234-8234-123456789abc';
const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; sessions: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-handoff-'));
  cleanup.push(root);
  const sessions = join(root, 'sessions');
  const cwd = join(root, 'outside-workspace');
  await Promise.all([mkdir(sessions), mkdir(cwd)]);
  return { root, sessions, cwd };
}

function header(id: string, cwd: string): string {
  return `${JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`;
}

describe('handoff source locator and binding store', () => {
  it.each([
    [ID, true],
    ['ABCDEF12-ABCD-EFAB-0123-ABCDEF012345', true],
    ['partial', false],
    ['a', false],
    ['12345678-1234-4234-8234', false],
    ['source.jsonl', false],
    ['../source', false],
    ['/tmp/source.jsonl', false],
    ['a'.repeat(200), false],
  ])('validates the complete Pi UUID text boundary: %s', (value, accepted) => {
    expect(isExactPiSessionId(value)).toBe(accepted);
  });

  it('accepts normal Unicode cwd basenames and rejects unsafe Unicode status characters', () => {
    expect(safeCwdDirectoryName('/private/项目资料')).toBe('项目资料');
    expect(safeCwdDirectoryName('/private/café-東京')).toBe('café-東京');
    expect(safeCwdDirectoryName('/')).toBe('已验证');
    for (const unsafe of [
      'line\nbreak',
      'next\u0085line',
      'spoof\u202Ename',
      'line\u2028separator',
      'paragraph\u2029separator',
    ]) {
      expect(safeCwdDirectoryName(`/private/${unsafe}`)).toBe('已验证');
    }
  });

  it('finds one exact ordinary session and preserves cwd outside configured workspaces', async () => {
    const value = await fixture();
    await writeFile(join(value.sessions, 'source.jsonl'), header(ID, value.cwd));
    const located = await locateHandoffSession(ID, [value.sessions]);
    expect(located.id).toBe(ID);
    expect(located.cwdRealpath).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(value.cwd)));
    expect(safeCwdDirectoryName(located.cwdRealpath)).toBe('outside-workspace');
  });

  it('fails closed for missing, duplicate, corrupt and symlink sources', async () => {
    const value = await fixture();
    await expect(locateHandoffSession(ID, [value.sessions])).rejects.toMatchObject({ failure: 'not-found' });
    await writeFile(join(value.sessions, 'bad.jsonl'), '{bad}\n');
    await expect(locateHandoffSession(ID, [value.sessions])).rejects.toMatchObject({ failure: 'uncertain' });
    await rm(join(value.sessions, 'bad.jsonl'));
    await writeFile(join(value.sessions, 'a.jsonl'), header(ID, value.cwd));
    await mkdir(join(value.sessions, 'nested'));
    await writeFile(join(value.sessions, 'nested', 'b.jsonl'), header(ID, value.cwd));
    await expect(locateHandoffSession(ID, [value.sessions])).rejects.toMatchObject({ failure: 'duplicate' });
    await rm(join(value.sessions, 'a.jsonl'));
    await rm(join(value.sessions, 'nested'), { recursive: true });
    await writeFile(join(value.sessions, 'bad.jsonl'), '{bad}\n');
    await symlink(join(value.sessions, 'bad.jsonl'), join(value.sessions, 'link.jsonl'));
    await expect(locateHandoffSession(ID, [value.sessions])).rejects.toMatchObject({ failure: 'uncertain' });
  });

  it('counts every directory entry and fails at the hard bound without exposing paths', async () => {
    const value = await fixture();
    await Promise.all(Array.from({ length: 6 }, (_, index) => writeFile(join(value.sessions, `${index}.txt`), 'x')));
    const failure = await locateHandoffSession(ID, [value.sessions], { maxEntries: 5 }).catch((error) => error);
    expect(failure).toMatchObject({ failure: 'scan-limit' });
    expect(String(failure)).not.toContain(value.root);
  });

  it('fails closed for a directory symlink, unreadable root, and Windows no-follow downgrade', async () => {
    const value = await fixture();
    await mkdir(join(value.root, 'outside'));
    await symlink(join(value.root, 'outside'), join(value.sessions, 'linked-dir'));
    await expect(locateHandoffSession(ID, [value.sessions])).rejects.toMatchObject({ failure: 'uncertain' });
    await rm(join(value.sessions, 'linked-dir'));
    if (process.platform !== 'win32') {
      await chmod(value.sessions, 0o000);
      try {
        const failure = await locateHandoffSession(ID, [value.sessions]).catch((error) => error);
        // Root may bypass POSIX mode checks; either behavior must remain safe.
        expect(['uncertain', 'not-found']).toContain(failure.failure);
      } finally {
        await chmod(value.sessions, 0o700);
      }
    }
    await expect(locateHandoffSession(ID, [value.sessions], { platform: 'win32' })).rejects.toMatchObject({
      failure: 'unsupported-platform',
    });
  });

  it('owns only a unique post-snapshot profile fork and removes it through a tombstone', async () => {
    const value = await fixture();
    const before = await snapshotProfileSessionDirectory(value.sessions);
    const forkId = 'abcdef12-1234-4234-8234-123456789abc';
    const forkPath = join(value.sessions, 'fork.jsonl');
    await writeFile(forkPath, header(forkId, value.cwd));
    const fork = await validateProfileForkSession(
      forkId,
      value.sessions,
      await import('node:fs/promises').then(({ realpath }) => realpath(value.cwd)),
      before,
    );
    await removeOwnedForkSession(fork, value.sessions);
    await expect(currentFileIdentity(forkPath)).rejects.toMatchObject({ failure: 'uncertain' });
  });

  it('rejects a pre-existing ID, missing artifact, wrong cwd and duplicate fork without deleting pre-existing data', async () => {
    const value = await fixture();
    const forkId = 'abcdef12-1234-4234-8234-123456789abc';
    const preexisting = join(value.sessions, 'existing.jsonl');
    await writeFile(preexisting, header(forkId, value.cwd));
    const before = await snapshotProfileSessionDirectory(value.sessions);
    await expect(validateProfileForkSession(forkId, value.sessions, value.cwd, before)).rejects.toMatchObject({
      failure: 'uncertain',
    });
    expect(await currentFileIdentity(preexisting)).toBeDefined();
    const missingBefore = await snapshotProfileSessionDirectory(value.sessions);
    await expect(validateProfileForkSession(ID, value.sessions, value.cwd, missingBefore)).rejects.toMatchObject({
      failure: 'not-found',
    });
    await writeFile(join(value.sessions, 'wrong.jsonl'), header(ID, value.root));
    await expect(validateProfileForkSession(ID, value.sessions, value.cwd, missingBefore)).rejects.toMatchObject({
      failure: 'uncertain',
    });
    await writeFile(join(value.sessions, 'duplicate.jsonl'), header(ID, value.root));
    await expect(validateProfileForkSession(ID, value.sessions, value.root, missingBefore)).rejects.toMatchObject({
      failure: 'duplicate',
    });
  });

  it('refuses rollback after the owned artifact identity is replaced', async () => {
    const value = await fixture();
    const forkPath = join(value.sessions, 'fork.jsonl');
    await writeFile(forkPath, header(ID, value.cwd));
    const fork = await locateHandoffSession(ID, [value.sessions]);
    await rm(forkPath);
    await writeFile(forkPath, header(ID, value.cwd));
    await expect(removeOwnedForkSession(fork, value.sessions)).rejects.toMatchObject({ failure: 'uncertain' });
    expect(await currentFileIdentity(forkPath)).toBeDefined();
  });

  it('keeps the prior binding when the pre-rename permission step fails', async () => {
    const value = await fixture();
    const path = join(value.root, 'profile', 'handoff-bindings.json');
    const original = {
      scopeId: 'chat:thread',
      chatId: 'chat',
      threadId: 'thread',
      sourceSessionId: ID,
      cwdSafeName: 'outside-workspace',
      forkSessionId: 'abcdef12-1234-4234-8234-123456789abc',
      cwdRealpath: value.cwd,
    };
    await new HandoffBindingStore(path).set(original);
    const failing = new HandoffBindingStore(path, {
      beforeRename: async () => Promise.reject(new Error('permission failed')),
    });
    await expect(failing.set({ ...original, forkSessionId: 'bbbbbbbb-1234-4234-8234-123456789abc' })).rejects.toThrow(
      /permission failed/,
    );
    const reloaded = new HandoffBindingStore(path);
    await reloaded.load();
    expect(reloaded.get('chat:thread')?.forkSessionId).toBe(original.forkSessionId);
  });

  it('fails closed when persisted bindings contain a non-UUID source or fork ID', async () => {
    const value = await fixture();
    const path = join(value.root, 'profile', 'handoff-bindings.json');
    await mkdir(join(value.root, 'profile'));
    const binding = {
      scopeId: 'chat:thread',
      chatId: 'chat',
      threadId: 'thread',
      sourceSessionId: ID,
      cwdSafeName: 'outside-workspace',
      forkSessionId: 'abcdef12-1234-4234-8234-123456789abc',
      cwdRealpath: value.cwd,
      updatedAt: Date.now(),
    };
    const { cwdSafeName: _cwdSafeName, ...legacyBinding } = binding;
    for (const invalid of [
      { ...binding, sourceSessionId: 'partial' },
      { ...binding, forkSessionId: '12345678-1234-4234-8234' },
      { ...legacyBinding, sourceSafeName: 'source.jsonl' },
      { ...binding, cwdSafeName: '../private' },
      { ...binding, cwdSafeName: 'line\nbreak' },
      { ...binding, cwdSafeName: 'next\u0085line' },
      { ...binding, cwdSafeName: 'spoof\u202Ename' },
      { ...binding, cwdSafeName: 'line\u2028separator' },
      { ...binding, cwdSafeName: 'paragraph\u2029separator' },
    ]) {
      await writeFile(path, `${JSON.stringify([invalid])}\n`);
      await expect(new HandoffBindingStore(path).load()).rejects.toThrow(/invalid entry/);
    }
  });

  it('atomically persists private bindings for restart recovery', async () => {
    const value = await fixture();
    const path = join(value.root, 'profile', 'handoff-bindings.json');
    const first = new HandoffBindingStore(path);
    await first.load();
    await first.set({
      scopeId: 'chat:thread',
      chatId: 'chat',
      threadId: 'thread',
      sourceSessionId: ID,
      cwdSafeName: 'outside-workspace',
      forkSessionId: 'abcdef12-1234-4234-8234-123456789abc',
      cwdRealpath: value.cwd,
    });
    const restarted = new HandoffBindingStore(path);
    await restarted.load();
    expect(restarted.get('chat:thread')).toMatchObject({ sourceSessionId: ID, threadId: 'thread' });
    await restarted.set({
      scopeId: 'chat:unicode',
      chatId: 'chat',
      threadId: 'unicode',
      sourceSessionId: ID,
      cwdSafeName: '项目资料',
      forkSessionId: 'bbbbbbbb-1234-4234-8234-123456789abc',
      cwdRealpath: value.cwd,
    });
    expect((await new HandoffBindingStore(path).getLatest('chat:unicode'))?.cwdSafeName).toBe('项目资料');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await restarted.delete('chat:thread');
    expect(await restarted.getLatest('chat:thread')).toBeUndefined();
  });
});
