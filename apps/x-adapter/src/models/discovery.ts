import { claudeModelId } from './model-id.js';
import { acceptsImages } from './modality.js';
import { InputModality, PublicModel } from './types.js';

const DEFAULT_REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Absent capability declarations stay text-only. */
function inputModalities(model: PublicModel): InputModality[] {
  return model.inputModalities ?? ['text'];
}

function reasoningLevels(model: PublicModel): string[] {
  const levels = model.supportedReasoningLevels?.filter(Boolean) ?? [];
  return levels.length ? levels : DEFAULT_REASONING_LEVELS;
}

function modelLoad(model: PublicModel): number | null {
  return typeof model.modelLoad === 'number' && Number.isFinite(model.modelLoad) ? model.modelLoad : null;
}

function displayName(model: PublicModel): string {
  return `${providerDisplayName(model.provider)} ${model.displayName || model.upstreamId}`;
}

function providerDisplayName(provider: PublicModel['provider']): string {
  return provider === 'trae' ? 'Trae' : 'Doubao Work';
}

export function openAiModelsResponse(models: PublicModel[]) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.provider,
      root: model.id,
      parent: null,
      metadata: {
        provider: model.provider,
        upstream_id: model.upstreamId,
        config_name: model.configName,
        model_name: model.modelName,
        display_name: model.displayName,
        is_default: Boolean(model.isDefault),
        max_tokens: model.maxOutputTokens,
        prompt_max_tokens: model.maxInputTokens,
        model_load: modelLoad(model),
        model_load_percent: modelLoad(model),
        hot: modelLoad(model),
        quota: model.quota ?? null,
        ...model.metadata,
        // The enforced gateway verdict must not be shadowed by provider metadata.
        input_modalities: inputModalities(model),
      },
    })),
  };
}

export function codexModelsResponse(models: PublicModel[]) {
  return {
    models: models.map((model, index) => ({
      slug: model.id,
      display_name: displayName(model),
      default_reasoning_level: model.defaultReasoningLevel ?? 'medium',
      supported_reasoning_levels: reasoningLevels(model).map((effort) => ({
        effort,
        description: `${effort} reasoning effort`,
      })),
      ...(typeof model.maxInputTokens === 'number'
        ? {
            context_window: model.maxInputTokens,
            max_context_window: model.maxInputTokens,
            effective_context_window_percent: 95,
          }
        : {}),
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      is_default: Boolean(model.isDefault),
      priority: -1000 + index,
      base_instructions: 'You are Codex, a coding agent.',
      supports_reasoning_summaries: true,
      support_verbosity: false,
      apply_patch_tool_type: 'freeform',
      truncation_policy: { mode: 'bytes', limit: 10000 },
      supports_parallel_tool_calls: false,
      experimental_supported_tools: [],
      provider: model.provider,
      upstream_id: model.upstreamId,
      hot: modelLoad(model),
      model_load: modelLoad(model),
      model_load_percent: modelLoad(model),
      quota: model.quota ?? null,
      ...model.metadata,
      // The enforced gateway verdict must not be shadowed by provider metadata.
      supports_image_detail_original: acceptsImages(inputModalities(model)),
      input_modalities: inputModalities(model),
    })),
  };
}

export function claudeModelsResponse(models: PublicModel[]) {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: claudeModelId(model),
      type: 'model',
      display_name: displayName(model),
      max_input_tokens: model.maxInputTokens,
      max_tokens: model.maxOutputTokens,
      capabilities: {
        thinking: { supported: false, types: { adaptive: { supported: false }, enabled: { supported: false } } },
        effort: Object.fromEntries([
          ['supported', reasoningLevels(model).length > 0],
          ...['none', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => [
            effort,
            { supported: reasoningLevels(model).includes(effort) },
          ]),
        ]),
        image_input: { supported: acceptsImages(inputModalities(model)) },
      },
      provider: model.provider,
      upstream_id: model.upstreamId,
      is_default: Boolean(model.isDefault),
      hot: modelLoad(model),
      model_load: modelLoad(model),
      model_load_percent: modelLoad(model),
      quota: model.quota ?? null,
      ...model.metadata,
      // The enforced gateway verdict must not be shadowed by provider metadata.
      input_modalities: inputModalities(model),
    })),
  };
}

export function discoveryKind(userAgent = ''): 'codex' | 'claude' | 'openai' {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes('codex')) {
    return 'codex';
  }
  if (normalized.includes('claude')) {
    return 'claude';
  }
  return 'openai';
}

export function modelDiscoveryResponse(models: PublicModel[], userAgent = '') {
  const kind = discoveryKind(userAgent);
  if (kind === 'codex') {
    return codexModelsResponse(models);
  }
  if (kind === 'claude') {
    return claudeModelsResponse(models);
  }
  return openAiModelsResponse(models);
}
