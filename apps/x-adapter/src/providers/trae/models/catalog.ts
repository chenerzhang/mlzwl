import fs from 'node:fs';
import { TraeSession } from '../auth/credential.js';
import { cacheDir, intEnv } from '../config/env.js';
import { readModelCache, writeModelCache } from '../state/persistent.js';
import { FetchLike, TraeModelConfig, fetchModelConfigs, modelCacheKey } from '../upstream/trae-client.js';
import { publicModelAliases } from './discovery.js';

const cache = new Map<string, { models: TraeModelConfig[]; expiresAt: number }>();

export type TraeModelCatalogResult = { models: TraeModelConfig[]; fromCache: boolean };

export function clearModelCache(realm?: TraeSession['realm']): void {
  if (realm) {
    for (const [key, value] of cache) {
      if (value.models.every((model) => model.metadata.realm === realm)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
  try {
    fs.rmSync(realm ? `${cacheDir()}/${realm}` : cacheDir(), { recursive: true, force: true });
  } catch {
    // Model refresh is best effort; a later catalog read can overwrite stale entries.
  }
}

export async function getModelCatalog(session: TraeSession, fetchImpl: FetchLike = fetch): Promise<TraeModelConfig[]> {
  return (await getModelCatalogResult(session, fetchImpl)).models;
}

export async function getModelCatalogResult(
  session: TraeSession,
  fetchImpl: FetchLike = fetch,
): Promise<TraeModelCatalogResult> {
  const key = modelCacheKey(session);
  const ttl = intEnv('X_ADAPTER_TRAE_MODEL_CACHE_TTL_MS', 60_000);
  const now = Date.now();
  const cached = cache.get(key);
  if (ttl > 0 && cached && cached.expiresAt > now) {
    return { models: cached.models, fromCache: true };
  }
  const diskCached = readModelCache(session, ttl);
  if (diskCached) {
    cache.set(key, { models: diskCached, expiresAt: ttl > 0 ? now + ttl : 0 });
    return { models: diskCached, fromCache: true };
  }
  const models = await fetchModelConfigs(session, fetchImpl);
  cache.set(key, { models, expiresAt: ttl > 0 ? now + ttl : 0 });
  writeModelCache(session, models);
  return { models, fromCache: false };
}

export function resolveModel(models: TraeModelConfig[], requested: string): TraeModelConfig {
  const model = requested.trim();
  const selected = models.find((item) => publicModelAliases(item).includes(model));
  if (!selected) {
    const error = new Error(`Trae model ${requested} is not present in the active realm catalog.`);
    (error as NodeJS.ErrnoException).code = 'model_not_found';
    throw error;
  }
  return selected;
}
