import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 10100;
/** Default public model for model-less compatibility requests and client setup examples. */
export const DEFAULT_MODEL = 'doubao-work-auto';
export const PACKAGE_NAME = '@mlzwl/x-adapter';
export const VERSION = readPackageVersion();

function readPackageVersion(): string {
  const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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
  return path.resolve(expandHome(env('X_ADAPTER_DATA_DIR', path.join(os.homedir(), '.x-adapter'))));
}

export function runtimeDir(): string {
  return path.resolve(expandHome(env('X_ADAPTER_RUNTIME_DIR', path.join(dataDir(), 'runtime'))));
}

export function logFile(): string {
  return path.resolve(expandHome(env('X_ADAPTER_LOG_FILE', path.join(dataDir(), 'logs', 'x-adapter.jsonl'))));
}

export function host(): string {
  return env('X_ADAPTER_HOST', DEFAULT_HOST).trim() || DEFAULT_HOST;
}

export function defaultOpenAiModel(): string {
  return env('X_ADAPTER_DEFAULT_MODEL', DEFAULT_MODEL);
}

export function port(): number {
  const parsed = intEnv('X_ADAPTER_PORT', DEFAULT_PORT);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid X_ADAPTER_PORT: ${parsed}`);
  }
  return parsed;
}
