import { readXAdapterConfig, writeXAdapterConfig } from '../config/file.js';
import { PROVIDER_IDS, ProviderId, PublicModel } from './types.js';

const DEFAULT_HIDDEN_PROVIDERS: readonly ProviderId[] = [];

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function readHiddenModels(): string[] {
  const hidden = readXAdapterConfig()?.model_visibility?.hidden;
  return Array.isArray(hidden)
    ? sortedUnique(hidden.filter((value): value is string => typeof value === 'string'))
    : [];
}

export function writeHiddenModels(hidden: string[]): string[] {
  const next = sortedUnique(hidden);
  const config = readXAdapterConfig() ?? {};
  writeXAdapterConfig({ ...config, model_visibility: { ...(config.model_visibility ?? {}), hidden: next } });
  return next;
}

export function readHiddenProviders(): ProviderId[] {
  const hidden = readXAdapterConfig()?.provider_visibility?.hidden;
  if (!Array.isArray(hidden)) {
    return [...DEFAULT_HIDDEN_PROVIDERS];
  }
  const selected = new Set(hidden.filter((value): value is string => typeof value === 'string').map(normalized));
  return PROVIDER_IDS.filter((provider) => selected.has(provider));
}

export function writeHiddenProviders(hidden: string[]): ProviderId[] {
  const selected = new Set(hidden.map(normalized));
  const next = PROVIDER_IDS.filter((provider) => selected.has(provider));
  const config = readXAdapterConfig() ?? {};
  writeXAdapterConfig({ ...config, provider_visibility: { ...(config.provider_visibility ?? {}), hidden: next } });
  return next;
}

export function isModelHidden(model: PublicModel, hidden = readHiddenModels()): boolean {
  return hidden.some((item) => normalized(item) === normalized(model.id));
}

export function isProviderHidden(provider: ProviderId, hidden = readHiddenProviders()): boolean {
  return hidden.includes(provider);
}

export function filterVisibleModels(
  models: PublicModel[],
  hiddenModels = readHiddenModels(),
  hiddenProviders = readHiddenProviders(),
): PublicModel[] {
  return models.filter(
    (model) => !isModelHidden(model, hiddenModels) && !isProviderHidden(model.provider, hiddenProviders),
  );
}

export type VisibleModel = PublicModel & { hidden?: boolean };

export function annotateModelVisibility(
  models: PublicModel[],
  hiddenModels = readHiddenModels(),
  hiddenProviders = readHiddenProviders(),
): VisibleModel[] {
  return models.map((model) => ({
    ...model,
    hidden: isModelHidden(model, hiddenModels) || isProviderHidden(model.provider, hiddenProviders),
  }));
}

function displayName(model: PublicModel): string {
  return `${model.id}  ${model.displayName || model.upstreamId}`;
}

/** Visible row count for the interactive selector; the catalog remains scrollable. */
export const HIDE_PROMPT_PAGE_SIZE = 10;

function choiceName(model: PublicModel, hidden: boolean): string {
  const details = [
    `provider=${model.provider}`,
    typeof model.modelLoad === 'number' ? `load=${model.modelLoad}` : '',
    model.defaultReasoningLevel ? `reasoning=${model.defaultReasoningLevel}` : '',
  ].filter(Boolean);
  return `${displayName(model)}${details.length ? `  (${details.join(', ')})` : ''}${hidden ? '  [hidden]' : ''}`;
}

/**
 * Inquirer checkbox has bounded, non-wrapping viewport navigation: pageSize
 * limits the visible rows while ArrowUp/ArrowDown stop at the first/last item.
 * This keeps large unified catalogs readable without cycling back to the top.
 */
export async function promptHiddenModels(models: PublicModel[]): Promise<{ saved: boolean; hidden: string[] }> {
  const currentHidden = readHiddenModels();
  if (!models.length) {
    return { saved: false, hidden: currentHidden };
  }
  try {
    const { checkbox } = await import('@inquirer/prompts');
    const selected = (await checkbox({
      message: 'Select models to hide (↑/↓ stops at the first/last model)',
      pageSize: HIDE_PROMPT_PAGE_SIZE,
      loop: false,
      choices: models.map((model) => ({
        name: choiceName(model, isModelHidden(model, currentHidden)),
        value: model.id,
        checked: isModelHidden(model, currentHidden),
      })),
    })) as string[];
    return { saved: true, hidden: writeHiddenModels(selected) };
  } catch (error) {
    if (isPromptCancellation(error)) {
      return { saved: false, hidden: currentHidden };
    }
    throw error;
  }
}

type ProviderChoice = { id: ProviderId; displayName: string };

export async function promptHiddenProviders(
  providers: readonly ProviderChoice[],
): Promise<{ saved: boolean; hidden: ProviderId[] }> {
  const currentHidden = readHiddenProviders();
  if (!providers.length) {
    return { saved: false, hidden: currentHidden };
  }
  try {
    const { checkbox } = await import('@inquirer/prompts');
    const selected = (await checkbox({
      message: 'Select providers to hide from model lists',
      pageSize: PROVIDER_IDS.length,
      loop: false,
      choices: providers.map((provider) => ({
        name: `${provider.displayName} (${provider.id})${isProviderHidden(provider.id, currentHidden) ? '  [hidden]' : ''}`,
        value: provider.id,
        checked: isProviderHidden(provider.id, currentHidden),
      })),
    })) as string[];
    return { saved: true, hidden: writeHiddenProviders(selected) };
  } catch (error) {
    if (isPromptCancellation(error)) {
      return { saved: false, hidden: currentHidden };
    }
    throw error;
  }
}

function isPromptCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ExitPromptError' || error.name === 'AbortPromptError' || error.message.includes('force closed'))
  );
}
