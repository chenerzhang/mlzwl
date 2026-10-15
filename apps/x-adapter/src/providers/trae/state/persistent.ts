import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../config/env.js';
import { TraeSession } from '../auth/credential.js';
import { TraeModelConfig, modelCacheKey } from '../upstream/trae-client.js';

export function modelCachePath(session: TraeSession): string {
  return path.join(cacheDir(), session.realm, `${modelCacheKey(session)}.models.json`);
}

export function readModelCache(session: TraeSession, ttlMs: number): TraeModelConfig[] | undefined {
  try {
    const file = modelCachePath(session);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { updatedAt: number; models: TraeModelConfig[] };
    if (!Array.isArray(parsed.models) || parsed.models.some((model) => model?.metadata?.realm !== session.realm)) {
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

export function writeModelCache(session: TraeSession, models: TraeModelConfig[]): void {
  try {
    const file = modelCachePath(session);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ updatedAt: Date.now(), models }, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    // Model cache persistence is best effort and contains no credentials.
  }
}
