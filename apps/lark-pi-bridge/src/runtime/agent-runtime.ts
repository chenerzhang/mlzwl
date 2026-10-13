import { PiAdapter } from '../agent/pi/adapter.js';
import { PiRpcAdapter } from '../agent/pi/rpc-adapter.js';
import { PiRpcFallbackAdapter } from '../agent/pi/fallback-adapter.js';
import type { AgentAdapter } from '../agent/types.js';
import type { AppPaths } from '../config/app-paths.js';
import { effectiveProfileModel, resolveEffectivePiPaths } from '../config/pi-paths.js';
import type { ProfileConfig } from '../config/profile-schema.js';

export function createRuntimeAgent(profile: ProfileConfig, paths: AppPaths, binary?: string): AgentAdapter {
  const effective = resolveEffectivePiPaths(profile, paths);
  const options = {
    binary,
    piConfigDir: effective.configDir,
    piSessionDir: effective.sessionDir,
    bridgeSystemPromptFile: effective.bridgeSystemPromptFile,
    larkChannel: {
      profile: paths.profile,
      rootDir: paths.rootDir,
    },
    stopGraceMs: profile.preferences.agentStopGraceMs,
  };
  const spawnPerTurn = new PiAdapter(options);
  if (profile.preferences.transport === 'rpc') {
    return new PiRpcFallbackAdapter(new PiRpcAdapter(options), spawnPerTurn);
  }
  return spawnPerTurn;
}

export function runtimeProfileModel(profile: ProfileConfig): string | undefined {
  return effectiveProfileModel(profile);
}
