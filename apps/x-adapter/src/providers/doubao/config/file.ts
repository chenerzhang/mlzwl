import fs from 'node:fs';
import path from 'node:path';
import { doubaoDataDir, env } from './env.js';
import { expandHome } from '../../../config/env.js';

export type DoubaoConnectConfig = {
  cookies?: string;
  saved_at?: string;
  user_agent?: string;
  common_query?: Record<string, string>;
};

export function doubaoConfigPath(): string {
  return path.resolve(expandHome(env('X_ADAPTER_DOUBAO_CONFIG_PATH', path.join(doubaoDataDir(), 'config.json'))));
}

export function readDoubaoConfig(configPath = doubaoConfigPath()): DoubaoConnectConfig | null {
  try {
    const stat = fs.statSync(configPath);
    if ((stat.mode & 0o077) !== 0) {
      const error = new Error(`Doubao Work config permissions are too broad: ${configPath}; expected mode 0600.`);
      (error as NodeJS.ErrnoException).code = 'insecure_doubao_config_permissions';
      throw error;
    }
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as DoubaoConnectConfig) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'insecure_doubao_config_permissions') {
      throw error;
    }
    return null;
  }
}

export function writeDoubaoConfig(config: DoubaoConnectConfig, configPath = doubaoConfigPath()): void {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
}
