import type { ProviderModel } from './types.js';

/** Raw Codex-dialect model entry as `GET /v1/models` returns it. */
export type DiscoveryModel = {
  slug: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelLoad?: number;
  reasoningLevels: string[];
  inputModalities: ('text' | 'image')[];
  provider?: string;
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Model load is a percentage that may legitimately be 0, so zero is kept. */
function optionalPercent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const levels = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.effort !== 'string' || !entry.effort) {
      return [];
    }
    return [entry.effort];
  });
  return [...new Set(levels)];
}

/**
 * Only advertise image input when x-adapter declares it. magpie hands an
 * undeclared capability nothing, and x-adapter rejects images for text-only
 * models with HTTP 400.
 */
function parseInputModalities(value: unknown): ('text' | 'image')[] {
  if (!Array.isArray(value)) {
    return ['text'];
  }
  const modalities = value.filter((entry): entry is 'text' | 'image' => entry === 'text' || entry === 'image');
  return modalities.includes('text') ? modalities : ['text', ...modalities];
}

export function parseDiscoveryModel(value: unknown): DiscoveryModel | undefined {
  if (!isRecord(value) || typeof value.slug !== 'string' || !value.slug) {
    return undefined;
  }
  return {
    slug: value.slug,
    displayName: typeof value.display_name === 'string' && value.display_name ? value.display_name : value.slug,
    contextWindow: optionalPositiveNumber(value.context_window ?? value.max_context_window),
    maxOutputTokens: optionalPositiveNumber(value.max_output_tokens),
    modelLoad: optionalPercent(value.model_load_percent ?? value.model_load ?? value.hot),
    reasoningLevels: parseReasoningLevels(value.supported_reasoning_levels),
    inputModalities: parseInputModalities(value.input_modalities),
    provider: typeof value.provider === 'string' ? value.provider : undefined,
  };
}

/**
 * Parse a `/v1/models` payload, or `undefined` when it is not one.
 *
 * An empty array is a real answer: x-adapter returns HTTP 200 with no models
 * when every model or provider is hidden, and HTTP 503 only when no provider
 * is usable. The caller must be able to tell those apart, so a malformed
 * payload is reported as `undefined` rather than as an empty list.
 */
export function parseDiscoveryModels(payload: unknown): DiscoveryModel[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    return undefined;
  }
  const models = payload.models
    .map(parseDiscoveryModel)
    .filter((model): model is DiscoveryModel => model !== undefined);
  return [...new Map(models.map((model) => [model.slug, model])).values()];
}

/**
 * Keep the model load readable in magpie's picker without changing the ID.
 * magpie shows the name, and x-adapter already publishes the same figure to
 * Pi, so the two clients stay consistent.
 */
export function providerModelName(model: DiscoveryModel): string {
  return model.modelLoad === undefined
    ? model.displayName
    : `${model.displayName} · Model load: ${Math.round(model.modelLoad)}%`;
}

export function toProviderModel(model: DiscoveryModel): ProviderModel {
  const levels = model.reasoningLevels;
  const inputs = model.inputModalities;
  const images = inputs.includes('image');
  return {
    id: model.slug,
    name: providerModelName(model),
    limit: {
      context: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      output: model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    },
    reasoning: levels.length > 0,
    // magpie turns the keys into the reasoning levels it offers, so only
    // levels x-adapter actually forwards become pickable.
    variants: levels.length > 0 ? Object.fromEntries(levels.map((level) => [level, {}])) : {},
    capabilities: {
      reasoning: levels.length > 0,
      toolcall: true,
      attachment: images,
      input: {
        text: inputs.includes('text'),
        image: images,
        audio: false,
        video: false,
        pdf: false,
      },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
  };
}
