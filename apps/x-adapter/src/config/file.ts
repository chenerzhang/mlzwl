import fs from 'node:fs';
import path from 'node:path';
import { dataDir, env, expandHome } from './env.js';

export type XAdapterConfig = {
  model_visibility?: {
    hidden?: string[];
  };
  provider_visibility?: {
    hidden?: string[];
  };
};

export function xAdapterConfigPath(): string {
  return path.resolve(expandHome(env('X_ADAPTER_CONFIG_PATH', path.join(dataDir(), 'config.json'))));
}

export function readXAdapterConfig(configPath = xAdapterConfigPath()): XAdapterConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as XAdapterConfig) : null;
  } catch {
    return null;
  }
}

export function writeXAdapterConfig(config: XAdapterConfig, configPath = xAdapterConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
    fs.chmodSync(configPath, 0o600);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup: the rename path has already consumed the file,
      // while write/rename errors remain the authoritative failure.
    }
  }
}
