import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MAX_ROOTS = 4;
const DEFAULT_MAX_ENTRIES = 10_000;
const MAX_HEADER_BYTES = 64 * 1024;
// Pi stores sessions either directly in a configured directory or one project
// directory below the default root. Do not descend into session-side artifacts.
const MAX_DEPTH = 1;

// Bridge handoff accepts only Pi's generated complete UUID text shape. The
// located JSONL header must still equal the requested text exactly.
export const PI_SESSION_ID_PATTERN = /^[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$/;

export type HandoffLocatorFailure =
  'invalid-id' | 'unsupported-platform' | 'untrusted-root' | 'scan-limit' | 'not-found' | 'duplicate' | 'uncertain';

export class HandoffLocatorError extends Error {
  constructor(readonly failure: HandoffLocatorFailure) {
    super(`handoff locator failed: ${failure}`);
    this.name = 'HandoffLocatorError';
  }
}

export interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
}

export interface LocatedHandoffSession {
  id: string;
  path: string;
  cwdRealpath: string;
  identity: FileIdentity;
}

export interface HandoffLocatorOptions {
  maxEntries?: number;
  platform?: NodeJS.Platform;
}

export interface SessionDirectorySnapshot {
  canonicalRoot: string;
  files: ReadonlyMap<string, FileIdentity>;
  sessionIds: ReadonlySet<string>;
}

export function isExactPiSessionId(value: string): boolean {
  return PI_SESSION_ID_PATTERN.test(value);
}

export function safeCwdDirectoryName(canonicalCwd: string): string {
  const candidate = basename(canonicalCwd);
  return isSafeCwdDirectoryName(candidate) ? candidate : '已验证';
}

export function isSafeCwdDirectoryName(value: string): boolean {
  if (!value || value === '.' || value === '..' || value.length > 255 || value.includes('/') || value.includes('\\')) {
    return false;
  }
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export async function trustedPiSessionRoots(profileSessionDir: string): Promise<string[]> {
  const userAgentDir = join(homedir(), '.pi', 'agent');
  const candidates = [join(userAgentDir, 'sessions'), await userConfiguredSessionDir(userAgentDir), profileSessionDir];
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (candidate && isAbsolute(candidate)) {
      const normalized = resolve(candidate);
      if (!roots.includes(normalized)) {
        roots.push(normalized);
      }
    }
  }
  return roots.slice(0, MAX_ROOTS);
}

export async function locateHandoffSession(
  exactId: string,
  roots: readonly string[],
  options: HandoffLocatorOptions = {},
): Promise<LocatedHandoffSession> {
  assertSupported(exactId, options);
  const budget = scanBudget(options);
  const matches: LocatedHandoffSession[] = [];
  const visitedCanonicalRoots = new Set<string>();
  for (const configuredRoot of roots.slice(0, MAX_ROOTS)) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await stableDirectory(configuredRoot, undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw asLocatorError(error, 'uncertain');
    }
    if (visitedCanonicalRoots.has(canonicalRoot)) {
      continue;
    }
    visitedCanonicalRoots.add(canonicalRoot);
    await walk(configuredRoot, canonicalRoot, 0, budget, async (path, name) => {
      const header = await inspectSessionFile(path, name, exactId);
      if (header.id === exactId) {
        matches.push(header);
      }
    });
  }
  if (!matches.length) {
    throw new HandoffLocatorError('not-found');
  }
  if (matches.length !== 1) {
    throw new HandoffLocatorError('duplicate');
  }
  return matches[0]!;
}

/** Snapshot all ordinary profile JSONL identities before invoking Pi fork. */
export async function snapshotProfileSessionDirectory(
  profileSessionDir: string,
  options: HandoffLocatorOptions = {},
): Promise<SessionDirectorySnapshot> {
  assertSupported('00000000-0000-0000-0000-000000000000', options);
  const budget = scanBudget(options);
  const canonicalRoot = await stableDirectory(profileSessionDir, undefined).catch((error) => {
    throw asLocatorError(error, 'uncertain');
  });
  const files = new Map<string, FileIdentity>();
  const sessionIds = new Set<string>();
  await walk(profileSessionDir, canonicalRoot, 0, budget, async (path, name) => {
    const session = await inspectSessionFile(path, name);
    files.set(path, session.identity);
    sessionIds.add(session.id);
  });
  return { canonicalRoot, files, sessionIds };
}

export async function validateProfileForkSession(
  sessionId: string,
  profileSessionDir: string,
  expectedCwdRealpath: string,
  before: SessionDirectorySnapshot,
  options?: HandoffLocatorOptions,
): Promise<LocatedHandoffSession> {
  if (before.sessionIds.has(sessionId)) {
    throw new HandoffLocatorError('uncertain');
  }
  const fork = await locateHandoffSession(sessionId, [profileSessionDir], options);
  if (fork.cwdRealpath !== expectedCwdRealpath || before.files.has(fork.path)) {
    throw new HandoffLocatorError('uncertain');
  }
  const currentRoot = await stableDirectory(profileSessionDir, undefined).catch((error) => {
    throw asLocatorError(error, 'uncertain');
  });
  if (currentRoot !== before.canonicalRoot) {
    throw new HandoffLocatorError('uncertain');
  }
  return fork;
}

export async function currentFileIdentity(path: string): Promise<FileIdentity> {
  try {
    const value = await lstat(path);
    if (value.isSymbolicLink() || !value.isFile()) {
      throw new HandoffLocatorError('uncertain');
    }
    return identity(value);
  } catch (error) {
    throw asLocatorError(error, 'uncertain');
  }
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** Remove only a proven fork via a profile-local retention-style tombstone. */
export async function removeOwnedForkSession(fork: LocatedHandoffSession, profileSessionDir: string): Promise<void> {
  const canonicalRoot = await stableDirectory(profileSessionDir, undefined);
  const canonicalParent = await realpath(dirname(fork.path));
  if (!contained(canonicalRoot, canonicalParent)) {
    throw new HandoffLocatorError('uncertain');
  }
  const current = await currentFileIdentity(fork.path);
  if (!sameFileIdentity(fork.identity, current)) {
    throw new HandoffLocatorError('uncertain');
  }
  const tombstone = join(dirname(fork.path), `.${basename(fork.path)}.rollback-${randomUUID()}.tombstone`);
  await rename(fork.path, tombstone);
  try {
    const moved = await currentFileIdentity(tombstone);
    if (!sameFileIdentity(fork.identity, moved)) {
      await restoreTombstone(tombstone, fork.path);
      throw new HandoffLocatorError('uncertain');
    }
    await rm(tombstone);
  } catch (error) {
    await restoreTombstone(tombstone, fork.path);
    throw asLocatorError(error, 'uncertain');
  }
}

async function userConfiguredSessionDir(userAgentDir: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(userAgentDir, 'settings.json'), 'utf8')) as { sessionDir?: unknown };
    if (typeof raw.sessionDir !== 'string' || !raw.sessionDir.trim()) {
      return undefined;
    }
    const expanded = raw.sessionDir.startsWith('~/') ? join(homedir(), raw.sessionDir.slice(2)) : raw.sessionDir;
    return isAbsolute(expanded) ? expanded : resolve(userAgentDir, expanded);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new HandoffLocatorError('uncertain');
  }
}

async function walk(
  directory: string,
  canonicalRoot: string,
  depth: number,
  budget: { visited: number; maxEntries: number },
  visit: (path: string, name: string) => Promise<void>,
): Promise<void> {
  let descriptor;
  let iterator;
  try {
    const beforeCanonical = await stableDirectory(directory, canonicalRoot);
    descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await descriptor.stat();
    if (!opened.isDirectory()) {
      throw new HandoffLocatorError('uncertain');
    }
    iterator = await opendir(directory);
    const pathAfterOpen = await lstat(directory);
    if (
      pathAfterOpen.isSymbolicLink() ||
      !pathAfterOpen.isDirectory() ||
      pathAfterOpen.dev !== opened.dev ||
      pathAfterOpen.ino !== opened.ino ||
      (await realpath(directory)) !== beforeCanonical
    ) {
      throw new HandoffLocatorError('uncertain');
    }
    for await (const entry of iterator) {
      await assertDirectoryStillBound(directory, beforeCanonical, opened.dev, opened.ino);
      budget.visited += 1;
      if (budget.visited > budget.maxEntries) {
        throw new HandoffLocatorError('scan-limit');
      }
      const path = join(directory, entry.name);
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) {
        throw new HandoffLocatorError('uncertain');
      }
      if (entryStat.isDirectory() && depth < MAX_DEPTH) {
        await walk(path, canonicalRoot, depth + 1, budget, visit);
      } else if (entryStat.isFile() && entry.name.endsWith('.jsonl')) {
        await visit(path, entry.name);
      }
    }
    await assertDirectoryStillBound(directory, beforeCanonical, opened.dev, opened.ino);
    const finalOpened = await descriptor.stat();
    if (finalOpened.dev !== opened.dev || finalOpened.ino !== opened.ino || !finalOpened.isDirectory()) {
      throw new HandoffLocatorError('uncertain');
    }
  } catch (error) {
    throw asLocatorError(error, 'uncertain');
  } finally {
    await iterator?.close().catch(() => {});
    await descriptor?.close().catch(() => {});
  }
}

async function stableDirectory(path: string, canonicalRoot: string | undefined): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new HandoffLocatorError('uncertain');
  }
  const canonical = await realpath(path);
  if (canonicalRoot && !contained(canonicalRoot, canonical)) {
    throw new HandoffLocatorError('untrusted-root');
  }
  await assertDirectoryStillBound(path, canonical, before.dev, before.ino);
  return canonical;
}

async function assertDirectoryStillBound(
  path: string,
  expectedCanonical: string,
  expectedDev: number | bigint,
  expectedIno: number | bigint,
): Promise<void> {
  const current = await lstat(path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== expectedDev ||
    current.ino !== expectedIno ||
    (await realpath(path)) !== expectedCanonical
  ) {
    throw new HandoffLocatorError('uncertain');
  }
}

async function inspectSessionFile(path: string, name: string, expectedId?: string): Promise<LocatedHandoffSession> {
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
      throw new HandoffLocatorError('uncertain');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new HandoffLocatorError('uncertain');
      }
      const buffer = Buffer.alloc(Math.min(opened.size, MAX_HEADER_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0 || (newline === buffer.length - 1 && opened.size > MAX_HEADER_BYTES)) {
        throw new HandoffLocatorError('uncertain');
      }
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
      } catch {
        throw new HandoffLocatorError('uncertain');
      }
      if (
        value.type !== 'session' ||
        (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
        typeof value.id !== 'string' ||
        !isExactPiSessionId(value.id) ||
        typeof value.cwd !== 'string' ||
        !isAbsolute(value.cwd)
      ) {
        throw new HandoffLocatorError('uncertain');
      }
      // Non-matching but structurally valid headers need not resolve a stale
      // cwd; only the exact requested source must prove its cwd still exists.
      let cwdRealpath = value.cwd;
      if (!expectedId || value.id === expectedId) {
        cwdRealpath = await realpath(value.cwd);
        const cwdStat = await lstat(cwdRealpath);
        if (!cwdStat.isDirectory()) {
          throw new HandoffLocatorError('uncertain');
        }
      }
      const after = await handle.stat();
      if (!sameFileIdentity(identity(opened), identity(after))) {
        throw new HandoffLocatorError('uncertain');
      }
      return { id: value.id, path, cwdRealpath, identity: identity(opened) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw asLocatorError(error, 'uncertain');
  }
}

function assertSupported(id: string, options: HandoffLocatorOptions): void {
  if (!isExactPiSessionId(id)) {
    throw new HandoffLocatorError('invalid-id');
  }
  if ((options.platform ?? process.platform) === 'win32') {
    throw new HandoffLocatorError('unsupported-platform');
  }
}

function scanBudget(options: HandoffLocatorOptions): { visited: number; maxEntries: number } {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new HandoffLocatorError('scan-limit');
  }
  return { visited: 0, maxEntries };
}

function identity(value: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number }): FileIdentity {
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs };
}

async function restoreTombstone(tombstone: string, original: string): Promise<void> {
  try {
    await lstat(original);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rename(tombstone, original).catch(() => {});
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

function asLocatorError(error: unknown, fallback: HandoffLocatorFailure): HandoffLocatorError {
  return error instanceof HandoffLocatorError ? error : new HandoffLocatorError(fallback);
}
