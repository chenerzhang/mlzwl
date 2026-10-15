import os from 'node:os';
import path from 'node:path';
import { dataDir as adapterDataDir } from '../../../config/env.js';

export function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export function intEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function expandHome(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function dataDir(): string {
  return path.resolve(expandHome(env('X_ADAPTER_TRAE_DATA_DIR', path.join(adapterDataDir(), 'trae'))));
}

export function cacheDir(): string {
  return path.join(dataDir(), 'cache');
}
