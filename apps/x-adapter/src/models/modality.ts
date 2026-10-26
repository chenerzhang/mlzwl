import { InputModality } from './types.js';

/**
 * Upstream `display_config.multimodal` is advisory. Keep the measured
 * exceptions small and fail closed when the directory omits the capability.
 * Keys are Trae's realm-local config names, lowercased.
 */
const VERIFIED_TRAE_OVERRIDES: Record<string, InputModality[]> = {
  // The upstream flag is false, but this model was verified reading images.
  'deepseek-v4.1-flash': ['text', 'image'],
  // Keep these measured text-only models closed even if the upstream flag flips.
  'deepseek-v4-pro': ['text'],
  'deepseek-v4-flash': ['text'],
};

export function resolveTraeInputModalities(
  configName: string,
  upstreamMultimodal: boolean | undefined,
): InputModality[] {
  const override = VERIFIED_TRAE_OVERRIDES[configName.trim().toLowerCase()];
  if (override) {
    return [...override];
  }
  return upstreamMultimodal === true ? ['text', 'image'] : ['text'];
}

export function acceptsImages(modalities: readonly InputModality[] | undefined): boolean {
  return modalities?.includes('image') === true;
}
