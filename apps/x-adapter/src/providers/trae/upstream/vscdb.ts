import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env.js';

/**
 * Secondary SOLO model source: the official Trae client persists its
 * `solo_agent` preset catalog in a local VS Code-style SQLite database
 * (`state.vscdb`). Models such as `gpt-6-sol` or `kimi-k3` are callable on
 * the SOLO remote API even though `GET /models` omits them, so the preset
 * list supplements the authoritative remote catalog with context-window
 * metadata attached. Everything here is best effort: a missing database,
 * unsupported Node build, or unreadable rows simply yields no presets.
 */

export type SoloAgentPreset = {
  configName: string;
  displayName: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

export function defaultVscdbPath(): string {
  const configured = env('X_ADAPTER_TRAE_VSCDB_PATH');
  if (configured) {
    return configured;
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Trae', 'User', 'globalStorage', 'state.vscdb');
}

type SqliteModule = {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
    close: () => void;
  };
};

async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    const module = (await import('node:sqlite')) as unknown as SqliteModule;
    return typeof module.DatabaseSync === 'function' ? module : null;
  } catch {
    return null;
  }
}

export async function readSoloAgentPresets(vscdbPath = defaultVscdbPath()): Promise<SoloAgentPreset[]> {
  if (!fs.existsSync(vscdbPath)) {
    return [];
  }
  const sqlite = await loadSqlite();
  if (!sqlite) {
    return [];
  }
  let database: InstanceType<SqliteModule['DatabaseSync']> | undefined;
  try {
    database = new sqlite.DatabaseSync(vscdbPath, { readOnly: true });
    const rows = database
      .prepare('select key, value from ItemTable where key like ?')
      .all('%:AI.agent.model.model_list_map');
    const presets: SoloAgentPreset[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const record = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
      const rawValue = typeof record.value === 'string' ? record.value : '';
      if (!rawValue) {
        continue;
      }
      for (const preset of parseModelListMap(rawValue)) {
        if (!seen.has(preset.configName)) {
          seen.add(preset.configName);
          presets.push(preset);
        }
      }
    }
    return presets;
  } catch {
    return [];
  } finally {
    try {
      database?.close();
    } catch {
      // best effort
    }
  }
}

export function parseModelListMap(rawValue: string): SoloAgentPreset[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return [];
  }
  const root =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const soloAgents = Array.isArray(root.solo_agent) ? root.solo_agent : [];
  const presets: SoloAgentPreset[] = [];
  for (const rawModel of soloAgents) {
    const model = rawModel && typeof rawModel === 'object' ? (rawModel as Record<string, unknown>) : {};
    if (model.is_preset !== true) {
      continue;
    }
    const configName = stringValue(model.config_name) || stringValue(model.name);
    if (!configName) {
      continue;
    }
    const features = asObject(model.features);
    const contextWindows = asObject(asObject(features.context_windows).data);
    const tokens = asObject(model.context_window_tokens);
    const dev = finiteNumber(tokens.dev) ?? finiteNumber(contextWindows.dev_context) ?? 200_000;
    const max = finiteNumber(tokens.max) ?? finiteNumber(contextWindows.max_context) ?? dev;
    presets.push({
      configName,
      displayName: stringValue(model.display_name) || configName,
      maxInputTokens: max,
      maxOutputTokens: dev,
    });
  }
  return presets;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
