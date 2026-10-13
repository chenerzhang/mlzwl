import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppPaths } from './app-paths.js';
import {
  inspectPiModelConfiguration,
  inspectUserPiModelConfiguration,
  type PiModelConfigurationStatus,
} from './pi-models.js';
import type { PiConfigScope, ProfileConfig } from './profile-schema.js';

export interface EffectivePiPaths {
  scope: PiConfigScope;
  configDir: string;
  sessionDir: string;
  bridgeSystemPromptFile: string;
}

/**
 * Resolve the Pi configuration source separately from bridge-owned session and
 * prompt files. User scope reads ordinary Pi configuration but never moves
 * bridge state into that shared directory.
 */
export function resolveEffectivePiPaths(profile: ProfileConfig, paths: AppPaths): EffectivePiPaths {
  return {
    scope: profile.preferences.piConfigScope,
    configDir: profile.preferences.piConfigScope === 'user' ? join(homedir(), '.pi', 'agent') : paths.profilePiAgentDir,
    sessionDir: paths.piSessionDir,
    bridgeSystemPromptFile: paths.bridgeSystemPromptFile,
  };
}

export function effectiveProfileModel(profile: ProfileConfig): string | undefined {
  return profile.preferences.piConfigScope === 'profile' ? profile.preferences.model : undefined;
}

export async function inspectEffectivePiModelConfiguration(
  profile: ProfileConfig,
  paths: AppPaths,
): Promise<PiModelConfigurationStatus> {
  const effective = resolveEffectivePiPaths(profile, paths);
  return effective.scope === 'user'
    ? inspectUserPiModelConfiguration(effective.configDir)
    : inspectPiModelConfiguration(effective.configDir, profile.preferences.model);
}
