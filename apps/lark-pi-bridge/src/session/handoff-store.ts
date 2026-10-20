import { readFile } from 'node:fs/promises';
import { writePrivateAtomicFile, type AtomicFileHooks } from '../runtime/atomic-json-file.js';
import { withFileMutationLock } from '../runtime/file-mutation.js';
import { isExactPiSessionId, isSafeCwdDirectoryName } from './handoff.js';

export interface HandoffBinding {
  scopeId: string;
  chatId: string;
  threadId: string;
  sourceSessionId: string;
  cwdSafeName: string;
  forkSessionId: string;
  cwdRealpath: string;
  updatedAt: number;
}

export class HandoffBindingStore {
  private bindings = new Map<string, HandoffBinding>();
  constructor(
    private readonly path: string,
    private readonly hooks?: AtomicFileHooks,
  ) {}

  async load(): Promise<void> {
    this.bindings = await readBindings(this.path);
  }

  async getLatest(scopeId: string): Promise<HandoffBinding | undefined> {
    this.bindings = await readBindings(this.path);
    const value = this.bindings.get(scopeId);
    return value ? { ...value } : undefined;
  }

  get(scopeId: string): HandoffBinding | undefined {
    const value = this.bindings.get(scopeId);
    return value ? { ...value } : undefined;
  }

  async set(value: Omit<HandoffBinding, 'updatedAt'>): Promise<HandoffBinding> {
    return withFileMutationLock(this.path, async () => {
      const latest = await readBindings(this.path);
      const next = { ...value, updatedAt: Math.max(Date.now(), (latest.get(value.scopeId)?.updatedAt ?? 0) + 1) };
      latest.set(value.scopeId, next);
      await persist(this.path, latest, this.hooks);
      this.bindings = latest;
      return { ...next };
    });
  }

  async restore(scopeId: string, value: HandoffBinding | undefined): Promise<void> {
    await withFileMutationLock(this.path, async () => {
      const latest = await readBindings(this.path);
      if (value) {
        latest.set(scopeId, { ...value });
      } else {
        latest.delete(scopeId);
      }
      await persist(this.path, latest, this.hooks);
      this.bindings = latest;
    });
  }

  async delete(scopeId: string): Promise<HandoffBinding | undefined> {
    return withFileMutationLock(this.path, async () => {
      const latest = await readBindings(this.path);
      const previous = latest.get(scopeId);
      if (previous) {
        latest.delete(scopeId);
        await persist(this.path, latest, this.hooks);
      }
      this.bindings = latest;
      return previous ? { ...previous } : undefined;
    });
  }
}

async function readBindings(path: string): Promise<Map<string, HandoffBinding>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error('handoff bindings must be an array');
    }
    const result = new Map<string, HandoffBinding>();
    for (const value of raw) {
      const parsed = parse(value);
      if (!parsed) {
        throw new Error('handoff bindings contain an invalid entry');
      }
      const current = result.get(parsed.scopeId);
      if (!current || current.updatedAt <= parsed.updatedAt) {
        result.set(parsed.scopeId, parsed);
      }
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
}

async function persist(path: string, values: Map<string, HandoffBinding>, hooks?: AtomicFileHooks): Promise<void> {
  await writePrivateAtomicFile(path, `${JSON.stringify([...values.values()], null, 2)}\n`, hooks);
}

function parse(value: unknown): HandoffBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<HandoffBinding>;
  if (
    typeof raw.scopeId !== 'string' ||
    typeof raw.chatId !== 'string' ||
    typeof raw.threadId !== 'string' ||
    raw.scopeId !== `${raw.chatId}:${raw.threadId}` ||
    !isExactPiSessionId(raw.sourceSessionId ?? '') ||
    typeof raw.cwdSafeName !== 'string' ||
    !isSafeCwdDirectoryName(raw.cwdSafeName) ||
    !isExactPiSessionId(raw.forkSessionId ?? '') ||
    typeof raw.cwdRealpath !== 'string' ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isFinite(raw.updatedAt)
  ) {
    return undefined;
  }
  return raw as HandoffBinding;
}
