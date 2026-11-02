import { TraeRealm } from '../config/realm.js';
import { TraeModelConfig } from '../upstream/trae-client.js';
import { SoloRemoteModel } from '../upstream/solo-client.js';
import { SoloAgentPreset } from '../upstream/vscdb.js';

/**
 * SOLO remote catalog merge policy (verified 2026-10-15):
 * - `GET /models` is the authoritative SOLO source.
 * - The official Trae client's local `solo_agent` presets (vscdb) supplement
 *   it with models that are callable on the remote API but absent from
 *   `/models`, and carry the context-window metadata.
 * - When a SOLO name collides with an IDE-discovered `config_name`, the
 *   existing entry gains `solo_agent_remote` as its preferred function so the
 *   shared routing loop tries the SOLO remote path first and falls back to the
 *   IDE `llm_utils_chat` functions on mismatch.
 */

export function mergeSoloRemoteCatalog(
  realm: TraeRealm,
  ideModels: TraeModelConfig[],
  remoteModels: SoloRemoteModel[],
  presets: SoloAgentPreset[],
): TraeModelConfig[] {
  const presetByName = new Map(presets.map((preset) => [preset.configName, preset]));
  const merged = ideModels.map((model) => structuredClone(model));
  const byConfigName = new Map(merged.map((model) => [model.metadata.config_name, model]));

  const seen = new Set<string>();
  for (const remote of remoteModels) {
    seen.add(remote.name);
    applySoloEntry(
      realm,
      merged,
      byConfigName,
      remote.name,
      remote.displayName,
      presetByName.get(remote.name),
      'solo_remote',
    );
  }
  for (const preset of presets) {
    if (seen.has(preset.configName)) {
      continue;
    }
    applySoloEntry(realm, merged, byConfigName, preset.configName, preset.displayName, preset, 'solo_preset');
  }
  return merged;
}

function applySoloEntry(
  realm: TraeRealm,
  merged: TraeModelConfig[],
  byConfigName: Map<string, TraeModelConfig>,
  name: string,
  displayName: string,
  preset: SoloAgentPreset | undefined,
  source: 'solo_remote' | 'solo_preset',
): void {
  const existing = byConfigName.get(name);
  if (existing) {
    if (!existing.metadata.functions.includes('solo_agent_remote')) {
      existing.metadata.functions.unshift('solo_agent_remote');
    }
    existing.metadata.solo_source = source;
    existing.metadata.prompt_max_tokens ??= preset?.maxInputTokens;
    existing.metadata.max_tokens ??= preset?.maxOutputTokens;
    return;
  }
  const model: TraeModelConfig = {
    id: `${realm}-${name}`,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'trae',
    permission: [],
    root: `${realm}-${name}`,
    parent: null,
    metadata: {
      realm,
      config_name: name,
      model_name: name,
      display_name: displayName || name,
      functions: ['solo_agent_remote'],
      is_default: false,
      max_tokens: preset?.maxOutputTokens,
      prompt_max_tokens: preset?.maxInputTokens,
      hot: null,
      model_load: null,
      model_load_percent: null,
      quota: null,
      supported_reasoning_levels: [],
      default_reasoning_level: null,
      solo_source: source,
    },
  };
  merged.push(model);
  byConfigName.set(name, model);
}
