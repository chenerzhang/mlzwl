import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isAgentThinkingLevel, type AgentThinkingLevel } from '../agent/types.js';
import { isAccessMode, type AccessMode } from '../config/permissions.js';
import { parseSelectedModel } from '../config/pi-models.js';
import { withFileMutationLock } from '../runtime/file-mutation.js';

export interface ScopeSettings {
  scopeId: string;
  workspaceAlias?: string;
  idleTimeoutMinutes?: number;
  accessMode?: AccessMode;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  updatedAt: number;
}

/** Per-chat, profile-local selection state. It contains aliases and numbers, never secrets or prompts. */
export class ScopeSettingsStore {
  private valuesByScope = new Map<string, ScopeSettings>();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    this.valuesByScope = await readSettings(this.path);
  }

  /** Reread on every ingress so local changes are immediately visible. */
  async getLatest(scopeId: string): Promise<ScopeSettings | undefined> {
    this.valuesByScope = await readSettings(this.path);
    return this.get(scopeId);
  }

  get(scopeId: string): ScopeSettings | undefined {
    const value = this.valuesByScope.get(scopeId);
    return value ? { ...value } : undefined;
  }

  async update(
    scopeId: string,
    patch: Pick<ScopeSettings, 'workspaceAlias' | 'idleTimeoutMinutes' | 'accessMode' | 'model' | 'thinkingLevel'>,
  ): Promise<ScopeSettings> {
    return withFileMutationLock(this.path, async () => {
      const latest = await readSettings(this.path);
      const current = latest.get(scopeId);
      const next: ScopeSettings = {
        scopeId,
        ...(current?.workspaceAlias ? { workspaceAlias: current.workspaceAlias } : {}),
        ...(current?.idleTimeoutMinutes ? { idleTimeoutMinutes: current.idleTimeoutMinutes } : {}),
        ...(current?.accessMode ? { accessMode: current.accessMode } : {}),
        ...(current?.model ? { model: current.model } : {}),
        ...(current?.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {}),
        ...patch,
        updatedAt: nextTimestamp(current?.updatedAt),
      };
      if (!next.workspaceAlias) {
        delete next.workspaceAlias;
      }
      if (!validTimeout(next.idleTimeoutMinutes)) {
        delete next.idleTimeoutMinutes;
      }
      if (!isAccessMode(next.accessMode)) {
        delete next.accessMode;
      }
      if (!next.model || !parseSelectedModel(next.model)) {
        delete next.model;
      }
      if (!isAgentThinkingLevel(next.thinkingLevel)) {
        delete next.thinkingLevel;
      }
      latest.set(scopeId, next);
      await persistSettings(this.path, latest);
      this.valuesByScope = latest;
      return { ...next };
    });
  }
}

async function readSettings(path: string): Promise<Map<string, ScopeSettings>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error('scope settings must be an array');
    }
    const settings = new Map<string, ScopeSettings>();
    for (const value of raw) {
      const parsed = parseScopeSettings(value);
      if (!parsed) {
        throw new Error('scope settings contain an invalid entry');
      }
      const existing = settings.get(parsed.scopeId);
      if (!existing || existing.updatedAt <= parsed.updatedAt) {
        settings.set(parsed.scopeId, parsed);
      }
    }
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
}

async function persistSettings(path: string, settings: Map<string, ScopeSettings>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify([...settings.values()], null, 2)}\n`);
    await file.sync();
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  } finally {
    await file.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
}

function parseScopeSettings(value: unknown): ScopeSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<ScopeSettings>;
  if (
    typeof raw.scopeId !== 'string' ||
    !raw.scopeId ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isFinite(raw.updatedAt)
  ) {
    return undefined;
  }
  return {
    scopeId: raw.scopeId,
    ...(typeof raw.workspaceAlias === 'string' && raw.workspaceAlias ? { workspaceAlias: raw.workspaceAlias } : {}),
    ...(validTimeout(raw.idleTimeoutMinutes) ? { idleTimeoutMinutes: raw.idleTimeoutMinutes } : {}),
    ...(isAccessMode(raw.accessMode) ? { accessMode: raw.accessMode } : {}),
    ...(typeof raw.model === 'string' && parseSelectedModel(raw.model) ? { model: raw.model } : {}),
    ...(isAgentThinkingLevel(raw.thinkingLevel) ? { thinkingLevel: raw.thinkingLevel } : {}),
    updatedAt: raw.updatedAt,
  };
}

function validTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 60;
}

function nextTimestamp(previous?: number): number {
  return Math.max(Date.now(), (previous ?? 0) + 1);
}
