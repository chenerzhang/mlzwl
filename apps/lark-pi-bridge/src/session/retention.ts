import { constants } from 'node:fs';
import { lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SessionRetentionPolicy } from '../config/profile-schema.js';
import { SessionCatalog, type SessionCatalogEntry } from './catalog.js';

const DAY_MS = 24 * 60 * 60_000;
const MAX_SESSION_HEADER_BYTES = 64 * 1_024;
export const SESSION_STORAGE_SOFT_LIMIT_BYTES = 512 * 1_024 * 1_024;

export type SessionRetentionReason = 'active-expired' | 'archived-expired' | 'orphan-expired';

export interface SessionRetentionSummary {
  enabled: boolean;
  dryRun: boolean;
  scannedFiles: number;
  storedBytes: number;
  remainingBytes: number;
  softLimitExceeded: boolean;
  activeKept: number;
  archivedKept: number;
  orphanKept: number;
  filesDeleted: number;
  catalogEntriesDeleted: number;
  staleCatalogWouldDelete: number;
  staleCatalogDeleted: number;
  bytesReclaimed: number;
  wouldDelete: Record<SessionRetentionReason, number>;
  warnings: number;
}

export interface PruneSessionsOptions {
  sessionDir: string;
  catalogFile: string;
  policy: SessionRetentionPolicy;
  dryRun?: boolean;
  now?: number;
}

interface SessionFile {
  path: string;
  sessionId: string;
  mtimeMs: number;
  size: number;
  dev: number | bigint;
  ino: number | bigint;
}

interface DeletionCandidate {
  file: SessionFile;
  entries: SessionCatalogEntry[];
  reason: SessionRetentionReason;
}

export async function pruneSessions(options: PruneSessionsOptions): Promise<SessionRetentionSummary> {
  const dryRun = options.dryRun ?? true;
  const summary = emptySummary(options.policy.enabled, dryRun);
  if (!options.policy.enabled) {
    return summary;
  }

  const catalog = new SessionCatalog(options.catalogFile);
  await catalog.load();
  const entries = catalog.values();
  const scanned = await scanSessionFiles(options.sessionDir);
  summary.scannedFiles = scanned.files.length;
  summary.storedBytes = scanned.storedBytes;
  summary.remainingBytes = summary.storedBytes;
  summary.softLimitExceeded = summary.remainingBytes > SESSION_STORAGE_SOFT_LIMIT_BYTES;
  summary.warnings += scanned.warnings;

  const filesById = new Map<string, SessionFile>();
  const duplicateIds = new Set<string>();
  for (const file of scanned.files) {
    if (filesById.has(file.sessionId)) {
      duplicateIds.add(file.sessionId);
    } else {
      filesById.set(file.sessionId, file);
    }
  }
  summary.warnings += duplicateIds.size;

  const entriesBySession = groupEntries(entries);
  const candidates: DeletionCandidate[] = [];
  const now = options.now ?? Date.now();
  for (const file of scanned.files) {
    if (duplicateIds.has(file.sessionId)) {
      continue;
    }
    const references = entriesBySession.get(file.sessionId) ?? [];
    const status = references.some((entry) => entry.status === 'active')
      ? 'active'
      : references.length > 0
        ? 'archived'
        : 'orphan';
    const lastUsedAt = Math.max(file.mtimeMs, ...references.map((entry) => entry.updatedAt));
    const days =
      status === 'active'
        ? options.policy.activeDays
        : status === 'archived'
          ? options.policy.archivedDays
          : options.policy.orphanDays;
    if (lastUsedAt > now - days * DAY_MS) {
      if (status === 'active') {
        summary.activeKept += 1;
      } else if (status === 'archived') {
        summary.archivedKept += 1;
      } else {
        summary.orphanKept += 1;
      }
      continue;
    }
    const reason: SessionRetentionReason =
      status === 'active' ? 'active-expired' : status === 'archived' ? 'archived-expired' : 'orphan-expired';
    candidates.push({ file, entries: references, reason });
    summary.wouldDelete[reason] += 1;
  }

  const missingEntries =
    scanned.warnings === 0 && duplicateIds.size === 0 ? entries.filter((entry) => !filesById.has(entry.sessionId)) : [];
  summary.staleCatalogWouldDelete = missingEntries.length;
  if (dryRun) {
    return summary;
  }

  const expectedCatalogEntries = [...missingEntries, ...candidates.flatMap((candidate) => candidate.entries)];
  const mutation = await catalog.removeEntries(expectedCatalogEntries);
  summary.catalogEntriesDeleted = mutation.removed.length;
  const missingKeys = new Set(missingEntries.map((entry) => entry.key));
  summary.staleCatalogDeleted = mutation.removed.filter((entry) => missingKeys.has(entry.key)).length;
  const remainingSessionIds = new Set(mutation.remaining.map((entry) => entry.sessionId));
  for (const candidate of candidates) {
    if (candidate.entries.some((entry) => !mutation.removed.some((removed) => removed.key === entry.key))) {
      continue;
    }
    if (remainingSessionIds.has(candidate.file.sessionId)) {
      continue;
    }
    const tombstonePath = `${candidate.file.path.slice(0, -'.jsonl'.length)}.prune-${process.pid}-${Date.now()}.jsonl`;
    try {
      const current = await lstat(candidate.file.path);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== candidate.file.dev ||
        current.ino !== candidate.file.ino ||
        current.size !== candidate.file.size ||
        current.mtimeMs !== candidate.file.mtimeMs
      ) {
        summary.warnings += 1;
        continue;
      }
      await rename(candidate.file.path, tombstonePath);
      const moved = await lstat(tombstonePath);
      if (
        moved.isSymbolicLink() ||
        !moved.isFile() ||
        moved.dev !== candidate.file.dev ||
        moved.ino !== candidate.file.ino ||
        moved.size !== candidate.file.size ||
        moved.mtimeMs !== candidate.file.mtimeMs
      ) {
        summary.warnings += 1;
        await restoreTombstone(tombstonePath, candidate.file.path);
        continue;
      }
      try {
        await rm(tombstonePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          summary.warnings += 1;
          await restoreTombstone(tombstonePath, candidate.file.path);
          continue;
        }
      }
      summary.filesDeleted += 1;
      summary.bytesReclaimed += candidate.file.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        summary.warnings += 1;
      }
    }
  }
  summary.remainingBytes = Math.max(0, summary.storedBytes - summary.bytesReclaimed);
  summary.softLimitExceeded = summary.remainingBytes > SESSION_STORAGE_SOFT_LIMIT_BYTES;
  return summary;
}

async function scanSessionFiles(
  sessionDir: string,
): Promise<{ files: SessionFile[]; storedBytes: number; warnings: number }> {
  let names: string[];
  try {
    names = (await readdir(sessionDir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { files: [], storedBytes: 0, warnings: 0 };
    }
    throw error;
  }
  const files: SessionFile[] = [];
  let storedBytes = 0;
  let warnings = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const path = resolve(sessionDir, name);
    try {
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile()) {
        warnings += 1;
        continue;
      }
      storedBytes += before.size;
      const handle = await open(path, constants.O_RDONLY | noFollowFlag());
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
          warnings += 1;
          continue;
        }
        const buffer = Buffer.alloc(Math.min(opened.size, MAX_SESSION_HEADER_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, bytesRead).toString('utf8');
        const newline = content.indexOf('\n');
        if (newline < 0) {
          warnings += 1;
          continue;
        }
        const sessionId = parseSessionId(content.slice(0, newline));
        if (!sessionId) {
          warnings += 1;
          continue;
        }
        files.push({
          path,
          sessionId,
          mtimeMs: opened.mtimeMs,
          size: opened.size,
          dev: opened.dev,
          ino: opened.ino,
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        warnings += 1;
      }
    }
  }
  return { files, storedBytes, warnings };
}

async function restoreTombstone(tombstonePath: string, originalPath: string): Promise<void> {
  try {
    await lstat(originalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rename(tombstonePath, originalPath).catch(() => {});
    }
  }
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
}

function parseSessionId(header: string): string | undefined {
  try {
    const parsed = JSON.parse(header) as { type?: unknown; id?: unknown };
    return parsed.type === 'session' && typeof parsed.id === 'string' && parsed.id ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function groupEntries(entries: SessionCatalogEntry[]): Map<string, SessionCatalogEntry[]> {
  const grouped = new Map<string, SessionCatalogEntry[]>();
  for (const entry of entries) {
    grouped.set(entry.sessionId, [...(grouped.get(entry.sessionId) ?? []), entry]);
  }
  return grouped;
}

function emptySummary(enabled: boolean, dryRun: boolean): SessionRetentionSummary {
  return {
    enabled,
    dryRun,
    scannedFiles: 0,
    storedBytes: 0,
    remainingBytes: 0,
    softLimitExceeded: false,
    activeKept: 0,
    archivedKept: 0,
    orphanKept: 0,
    filesDeleted: 0,
    catalogEntriesDeleted: 0,
    staleCatalogWouldDelete: 0,
    staleCatalogDeleted: 0,
    bytesReclaimed: 0,
    wouldDelete: { 'active-expired': 0, 'archived-expired': 0, 'orphan-expired': 0 },
    warnings: 0,
  };
}
