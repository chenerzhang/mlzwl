import type { ProviderModel } from './types.js';

/** Raw Codex-dialect model entry as `GET /v1/models` returns it. */
export type DiscoveryModel = {
  slug: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningLevels: string[];
  inputModalities: ('text' | 'image')[];
  provider?: string;
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** The provider prefix x-adapter puts in front of a resolved display name. */
const PROVIDER_LABELS: Record<string, string> = {
  trae: 'Trae',
  doubao: 'Doubao Work',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Reasoning levels reach the plugin in two shapes: the Codex dialect's
 * `[{ effort, description }]` objects, and a bare string array that an older
 * x-adapter release emits when an upstream metadata key overwrites the dialect
 * field. Accept both, because reading a string array as "no levels" removes the
 * reasoning picker from magpie while the gateway still forwards effort.
 */
function parseReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const levels = value.flatMap((entry) => {
    if (typeof entry === 'string') {
      return entry ? [entry] : [];
    }
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
 * Keep magpie's picker readable and unambiguous.
 *
 * The model load figure belongs to the gateway's metadata, not to the name a
 * user picks a model by. magpie renders the name as the whole row label, so
 * appending `· Model load: N%` pushes the provider distinction off the row and
 * truncates it.
 *
 * The provider prefix marks where a model comes from: Trae and Doubao Work are
 * separate providers, and magpie lists their models in one flat picker. Inside
 * Trae, the realm segment the gateway already puts in the name (`Global`, `CN`)
 * is what tells two routes with the same upstream name apart.
 *
 * A gateway that predates the prefix fix still sends the bare upstream name, so
 * add the prefix here when it is missing. That keeps the provider visible in
 * either upgrade order; the rest of the name still comes from the gateway, so a
 * gateway that omits the realm segment cannot have it restored here.
 */
export function providerModelName(model: DiscoveryModel): string {
  const label = model.provider ? PROVIDER_LABELS[model.provider] : undefined;
  if (!label || model.displayName.startsWith(`${label} `)) {
    return model.displayName;
  }
  return `${label} ${model.displayName}`;
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
