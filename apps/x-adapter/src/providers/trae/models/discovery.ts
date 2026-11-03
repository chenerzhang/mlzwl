import { TraeModelConfig } from '../upstream/trae-client.js';

export const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Routing aliases for one catalog row.
 *
 * A Standard/Max pair shares one upstream `config_name`, so the bare
 * `<realm>-<config_name>` alias must only belong to the variant whose own ID is
 * exactly that value. Otherwise the Max row would also claim the Standard ID
 * and make routing order-dependent.
 */
export function publicModelAliases(model: TraeModelConfig): string[] {
  const { realm, config_name: configName, model_name: modelName } = model.metadata;
  const baseAlias = `${realm}-${configName}`;
  return [model.id, ...(model.id === baseAlias ? [baseAlias] : []), `${realm}-${modelName}`].filter(
    (item, index, entries): item is string =>
      typeof item === 'string' && item.length > 0 && entries.indexOf(item) === index,
  );
}
