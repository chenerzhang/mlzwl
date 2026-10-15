import fs from 'node:fs';
import path from 'node:path';
import { DoubaoCredential, credentialHash } from '../auth/doubao-cookie.js';
import { doubaoCacheDir, intEnv } from '../config/env.js';
import { FetchLike } from '../upstream/client.js';
import { DoubaoModel, fetchDoubaoModels, staticDoubaoModels } from '../upstream/protocol.js';

const memory = new Map<string, { models: DoubaoModel[]; expiresAt: number }>();

export function clearModelCache(): void {
  memory.clear();
  fs.rmSync(doubaoCacheDir(), { recursive: true, force: true });
}

export async function getDoubaoModelCatalog(
  credential: DoubaoCredential,
  fetchImpl: FetchLike = fetch,
): Promise<DoubaoModel[]> {
  if (credential.source === 'mock') {
    return staticDoubaoModels();
  }
  const key = credentialHash(credential);
  const ttlMs = intEnv('X_ADAPTER_DOUBAO_MODEL_CACHE_TTL_MS', 60_000);
  const now = Date.now();
  const cached = memory.get(key);
  if (ttlMs > 0 && cached && cached.expiresAt > now) {
    return cached.models;
  }
  const disk = readDiskCache(key, ttlMs);
  if (disk) {
    memory.set(key, { models: disk, expiresAt: now + ttlMs });
    return disk;
  }
  const models = await fetchDoubaoModels(credential, fetchImpl);
  memory.set(key, { models, expiresAt: ttlMs > 0 ? now + ttlMs : 0 });
  writeDiskCache(key, models);
  return models;
}

export function resolveDoubaoModel(models: DoubaoModel[], requested: string | undefined): DoubaoModel {
  const normalized = (requested || 'work-auto').trim();
  const stripped = normalized.startsWith('doubao-') ? normalized.slice('doubao-'.length) : normalized;
  const matched = models.find((model) => model.id === stripped || model.modelItemKey === stripped);
  if (matched) {
    return matched;
  }
  const error = new Error(`Unknown Doubao Work model: ${requested || normalized}`);
  (error as NodeJS.ErrnoException).code = 'model_not_found';
  throw error;
}

function cachePath(key: string): string {
  return path.join(doubaoCacheDir(), `${key}.models.json`);
}

function readDiskCache(key: string, ttlMs: number): DoubaoModel[] | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(key), 'utf8')) as { updatedAt: number; models: DoubaoModel[] };
    if (!Array.isArray(parsed.models)) {
      return undefined;
    }
    if (ttlMs > 0 && Date.now() - Number(parsed.updatedAt) > ttlMs) {
      return undefined;
    }
    return parsed.models;
  } catch {
    return undefined;
  }
}

function writeDiskCache(key: string, models: DoubaoModel[]): void {
  try {
    const file = cachePath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), models }, null, 2), { mode: 0o600 });
  } catch {
    // best effort
  }
}
