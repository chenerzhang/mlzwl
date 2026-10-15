import path from 'node:path';
import { dataDir as xAdapterDataDir, env, expandHome, intEnv } from '../../../config/env.js';

export { env, intEnv } from '../../../config/env.js';

export function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())) {
    return false;
  }
  return fallback;
}

export function doubaoBaseUrl(): string {
  return env('DOUBAO_BASE_URL', 'https://www.doubao.com').replace(/\/+$/, '');
}

export function doubaoDataDir(): string {
  return path.resolve(expandHome(env('X_ADAPTER_DOUBAO_DATA_DIR', path.join(xAdapterDataDir(), 'doubao-work'))));
}

export function doubaoCacheDir(): string {
  return path.resolve(expandHome(env('X_ADAPTER_DOUBAO_CACHE_DIR', path.join(xAdapterDataDir(), 'cache', 'doubao'))));
}

export function defaultDoubaoModel(): string {
  return env('X_ADAPTER_DOUBAO_MODEL', 'work-auto');
}

export function doubaoTimeoutSignal(clientSignal?: AbortSignal): AbortSignal | undefined {
  const timeoutMs = intEnv('X_ADAPTER_DOUBAO_TIMEOUT_MS', 180_000);
  if (timeoutMs <= 0) {
    return clientSignal;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!clientSignal) {
    return timeout;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([clientSignal, timeout]);
  }
  return timeout;
}
