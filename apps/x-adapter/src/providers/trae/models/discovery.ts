import { TraeModelConfig } from '../upstream/trae-client.js';

export const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function publicModelAliases(model: TraeModelConfig): string[] {
  return [
    model.id,
    `${model.metadata.realm}-${model.metadata.config_name}`,
    `${model.metadata.realm}-${model.metadata.model_name}`,
  ].filter(
    (item, index, entries): item is string =>
      typeof item === 'string' && item.length > 0 && entries.indexOf(item) === index,
  );
}
