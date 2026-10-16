import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileMutationLock } from '../runtime/file-mutation.js';

export interface SessionCatalogIdentity {
  scopeId: string;
  cwdRealpath: string;
  policyFingerprint: string;
}

export interface SessionCatalogEntry extends SessionCatalogIdentity {
  key: string;
  sessionId: string;
  status: 'active' | 'archived';
  updatedAt: number;
}

export function sessionCatalogKey(input: SessionCatalogIdentity): string {
  return [input.scopeId, 'pi', input.cwdRealpath, input.policyFingerprint].join('\x1f');
}

export class SessionCatalog {
  private entriesByKey = new Map<string, SessionCatalogEntry>();
  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    this.entriesByKey = await readEntries(this.path);
  }

  activeFor(identity: SessionCatalogIdentity): SessionCatalogEntry | undefined {
    const entry = this.entriesByKey.get(sessionCatalogKey(identity));
    return entry?.status === 'active' ? { ...entry } : undefined;
  }

  async upsertActive(identity: SessionCatalogIdentity, sessionId: string): Promise<void> {
    if (!sessionId) {
      throw new Error('Pi sessionId is required');
    }
    await withFileMutationLock(this.path, async () => {
      const latest = await readEntries(this.path);
      const entry: SessionCatalogEntry = {
        key: sessionCatalogKey(identity),
        ...identity,
        sessionId,
        status: 'active',
        updatedAt: nextTimestamp(latest.get(sessionCatalogKey(identity))?.updatedAt),
      };
      latest.set(entry.key, entry);
      await persistEntries(this.path, latest);
      this.entriesByKey = latest;
    });
  }

  async archive(identity: SessionCatalogIdentity): Promise<void> {
    await withFileMutationLock(this.path, async () => {
      const latest = await readEntries(this.path);
      const key = sessionCatalogKey(identity);
      const entry = latest.get(key);
      if (!entry) {
        this.entriesByKey = latest;
        return;
      }
      latest.set(key, { ...entry, status: 'archived', updatedAt: nextTimestamp(entry.updatedAt) });
      await persistEntries(this.path, latest);
      this.entriesByKey = latest;
    });
  }

  async removeEntries(
    expected: Array<Pick<SessionCatalogEntry, 'key' | 'sessionId' | 'updatedAt'>>,
  ): Promise<{ removed: SessionCatalogEntry[]; remaining: SessionCatalogEntry[] }> {
    return withFileMutationLock(this.path, async () => {
      const latest = await readEntries(this.path);
      const removed: SessionCatalogEntry[] = [];
      for (const candidate of new Map(expected.map((entry) => [entry.key, entry])).values()) {
        const entry = latest.get(candidate.key);
        if (entry && entry.sessionId === candidate.sessionId && entry.updatedAt === candidate.updatedAt) {
          removed.push(entry);
          latest.delete(candidate.key);
        }
      }
      if (removed.length > 0) {
        await persistEntries(this.path, latest);
      }
      this.entriesByKey = latest;
      return {
        removed: removed.map((entry) => ({ ...entry })),
        remaining: [...latest.values()].map((entry) => ({ ...entry })),
      };
    });
  }

  values(): SessionCatalogEntry[] {
    return [...this.entriesByKey.values()].map((entry) => ({ ...entry }));
  }
}

async function readEntries(path: string): Promise<Map<string, SessionCatalogEntry>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error('session catalog must be an array');
    }
    const entries = new Map<string, SessionCatalogEntry>();
    for (const item of raw) {
      const entry = parseEntry(item);
      if (!entry) {
        throw new Error('session catalog contains an invalid entry');
      }
      const existing = entries.get(entry.key);
      if (!existing || existing.updatedAt <= entry.updatedAt) {
        entries.set(entry.key, entry);
      }
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
}

async function persistEntries(path: string, entries: Map<string, SessionCatalogEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify([...entries.values()], null, 2)}\n`);
    await file.sync();
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
  await rename(tmp, path);
  await chmod(path, 0o600);
}

function parseEntry(value: unknown): SessionCatalogEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const item = value as Partial<SessionCatalogEntry>;
  if (
    typeof item.key !== 'string' ||
    typeof item.scopeId !== 'string' ||
    typeof item.cwdRealpath !== 'string' ||
    typeof item.policyFingerprint !== 'string' ||
    typeof item.sessionId !== 'string' ||
    (item.status !== 'active' && item.status !== 'archived') ||
    typeof item.updatedAt !== 'number' ||
    !Number.isFinite(item.updatedAt) ||
    item.key !== sessionCatalogKey(item as SessionCatalogIdentity)
  ) {
    return undefined;
  }
  return item as SessionCatalogEntry;
}

function nextTimestamp(previous?: number): number {
  return Math.max(Date.now(), (previous ?? 0) + 1);
}
