import {
  ModelDiscoveryResult,
  ProviderAdapter,
  ProviderId,
  ProviderModel,
  ProviderRealmStatus,
  PublicModel,
} from '../models/types.js';
import { redactSensitiveText } from '../logging/jsonl.js';
import { resolveTraeInputModalities } from '../models/modality.js';
import { CanonicalRequest, CanonicalResult, CanonicalStreamEvent } from '../protocol/canonical.js';
import { bindCanonicalToolCalls } from '../protocol/tools.js';
import { readDoubaoCredential } from './doubao/auth/doubao-cookie.js';
import { clearModelCache as clearDoubaoModelCache, getDoubaoModelCatalog } from './doubao/models/catalog.js';
import { prepareDoubaoRequest } from './doubao/request.js';
import { runDoubaoChat, streamDoubaoChat } from './doubao/upstream/chat.js';
import { readTraeCredential } from './trae/auth/credential.js';
import { resolveTraeSession } from './trae/auth/oauth.js';
import { TRAE_REALMS, TraeRealm } from './trae/config/realm.js';
import {
  clearModelCache as clearTraeModelCache,
  getModelCatalogResult as getTraeModelCatalogResult,
} from './trae/models/catalog.js';
import { runTraeChat, streamTraeChat } from './trae/upstream/chat.js';

export type ExecutableProviderAdapter = ProviderAdapter & {
  execute(request: CanonicalRequest, model: PublicModel, signal?: AbortSignal): AsyncGenerator<CanonicalStreamEvent>;
  run(request: CanonicalRequest, model: PublicModel, signal?: AbortSignal): Promise<CanonicalResult>;
};

export function createProviderAdapters(): ExecutableProviderAdapter[] {
  return [createTraeAdapter(), createDoubaoAdapter()];
}

export function clearProviderModelCaches(provider?: ProviderId): void {
  if (!provider || provider === 'trae') {
    clearTraeModelCache();
  }
  if (!provider || provider === 'doubao') {
    clearDoubaoModelCache();
  }
}

function createTraeAdapter(): ExecutableProviderAdapter {
  return {
    id: 'trae',
    displayName: 'Trae',
    async discoverModels(): Promise<ModelDiscoveryResult> {
      const attempts = await Promise.allSettled(
        TRAE_REALMS.map(async (realm) => {
          const configured = traeRealmConfigured(realm);
          if (!configured) {
            return { realm, configured, models: [], fromCache: false };
          }
          const session = await resolveTraeSession(realm);
          if (!session) {
            return { realm, configured, models: [], fromCache: false };
          }
          return { realm, configured, ...(await getTraeModelCatalogResult(session)) };
        }),
      );
      const realmStatuses: ProviderRealmStatus[] = [];
      const models: ProviderModel[] = [];
      for (let index = 0; index < attempts.length; index += 1) {
        const realm = TRAE_REALMS[index];
        const attempt = attempts[index];
        if (attempt.status === 'rejected') {
          realmStatuses.push({
            realm,
            configured: traeRealmConfigured(realm),
            available: false,
            modelCount: 0,
            fromCache: false,
            lastError: boundedError(attempt.reason),
          });
          continue;
        }
        models.push(...toTraeProviderModels(attempt.value.models));
        const available = attempt.value.models.length > 0;
        realmStatuses.push({
          realm,
          configured: attempt.value.configured,
          available,
          modelCount: attempt.value.models.length,
          fromCache: attempt.value.fromCache,
          ...(!available && attempt.value.configured
            ? {
                lastError: {
                  code: 'trae_model_catalog_empty',
                  message: `Trae ${realm} returned no discoverable models and has no valid cached catalog.`,
                },
              }
            : {}),
        });
      }
      return {
        provider: 'trae',
        displayName: 'Trae',
        models,
        available: realmStatuses.some((status) => status.available),
        realms: realmStatuses,
      };
    },
    async *execute(request, model, signal) {
      rejectHostedSearch(request);
      const realm = modelRealm(model);
      const session = await resolveTraeSession(realm);
      if (!session) {
        throw missingTraeCredential(realm);
      }
      yield* withPublicModel(
        streamTraeChat(session, requestForModel(request, model), fetch, signal),
        model.id,
        request.tools,
      );
    },
    async run(request, model, signal) {
      rejectHostedSearch(request);
      const realm = modelRealm(model);
      const session = await resolveTraeSession(realm);
      if (!session) {
        throw missingTraeCredential(realm);
      }
      return withPublicResult(
        await runTraeChat(session, requestForModel(request, model), fetch, signal),
        model.id,
        request.tools,
      );
    },
  };
}

function traeRealmConfigured(realm: TraeRealm): boolean {
  try {
    return readTraeCredential(realm) !== null;
  } catch {
    // A present but unreadable/malformed credential is configured and failed.
    // Keep that failure bounded to this realm instead of rejecting Trae as a
    // whole and hiding a healthy sibling realm.
    return true;
  }
}

function createDoubaoAdapter(): ExecutableProviderAdapter {
  return {
    id: 'doubao',
    displayName: 'Doubao Work',
    async discoverModels(): Promise<ModelDiscoveryResult> {
      const credential = readDoubaoCredential();
      if (!credential) {
        throw missingCredential('doubao');
      }
      const models = await getDoubaoModelCatalog(credential);
      return {
        provider: 'doubao',
        displayName: 'Doubao Work',
        models: models.map((model) => ({
          upstreamId: model.id,
          configName: model.modelItemKey,
          modelName: model.displayName,
          displayName: model.displayName,
          maxInputTokens: model.maxInputTokens,
          maxOutputTokens: model.maxOutputTokens,
          supportedReasoningLevels: model.supportedReasoningLevels,
          defaultReasoningLevel: model.defaultReasoningLevel,
          // Doubao Work rejects non-text content before contacting upstream.
          inputModalities: ['text'],
          metadata: { model_item_key: model.modelItemKey, upstream_provider_id: model.providerId || null },
        })),
      };
    },
    async *execute(request, model, signal) {
      const prepared = prepareDoubaoRequest(requestForModel(request, model));
      const credential = readDoubaoCredential();
      if (!credential) {
        throw missingCredential('doubao');
      }
      yield* withPublicModel(streamDoubaoChat(credential, prepared, fetch, signal), model.id, request.tools);
    },
    async run(request, model, signal) {
      const prepared = prepareDoubaoRequest(requestForModel(request, model));
      const credential = readDoubaoCredential();
      if (!credential) {
        throw missingCredential('doubao');
      }
      return withPublicResult(await runDoubaoChat(credential, prepared, fetch, signal), model.id, request.tools);
    },
  };
}

function rejectHostedSearch(request: CanonicalRequest): void {
  if ((request.tools ?? []).some((tool) => tool.hosted === true)) {
    const error = new Error('Trae hosted web search is not supported by the verified Global/CN Agent protocol.');
    (error as NodeJS.ErrnoException).code = 'unsupported_hosted_search';
    throw error;
  }
}

function modelRealm(model: PublicModel): TraeRealm {
  const realm = model.metadata?.realm;
  if (realm === 'global' || realm === 'cn') {
    return realm;
  }
  const error = new Error(`Trae model ${model.id} is missing its realm binding.`);
  (error as NodeJS.ErrnoException).code = 'model_not_found';
  throw error;
}

function missingTraeCredential(realm: TraeRealm): Error {
  const error = new Error(`Trae ${realm} is not signed in. Run \`x-adapter trae login --realm ${realm}\`.`);
  (error as NodeJS.ErrnoException).code = 'missing_trae_credentials';
  return error;
}

function missingCredential(provider: ProviderId): Error {
  const error = new Error(`${provider} credentials are unavailable. Configure or log in to that provider, then retry.`);
  (error as NodeJS.ErrnoException).code = `missing_${provider}_credentials`;
  return error;
}

type ProviderCatalogModel = {
  id: string;
  metadata: {
    realm: TraeRealm;
    config_name: string;
    model_name: string;
    display_name: string;
    functions: string[];
    is_default: boolean;
    prompt_max_tokens?: number;
    max_tokens?: number;
    model_load?: number | null;
    hot?: number | null;
    quota?: unknown;
    supported_reasoning_levels?: unknown[];
    default_reasoning_level?: string | null;
    multimodal?: boolean;
    tool_response_multimodal?: boolean;
  };
};

function toTraeProviderModels(models: ProviderCatalogModel[]): ProviderModel[] {
  return models.map((model) => ({
    upstreamId: model.id,
    configName: model.metadata.config_name,
    modelName: model.metadata.model_name,
    displayName: `${model.metadata.realm === 'global' ? 'Global' : 'CN'} ${model.metadata.display_name}`,
    isDefault: model.metadata.is_default,
    maxInputTokens: model.metadata.prompt_max_tokens,
    maxOutputTokens: model.metadata.max_tokens,
    modelLoad: model.metadata.model_load ?? model.metadata.hot ?? null,
    quota: model.metadata.quota,
    supportedReasoningLevels: (model.metadata.supported_reasoning_levels ?? []).flatMap((level) =>
      typeof level === 'string' ? [level] : [],
    ),
    defaultReasoningLevel: model.metadata.default_reasoning_level,
    inputModalities: resolveTraeInputModalities(model.metadata.config_name, model.metadata.multimodal),
    metadata: { ...model.metadata },
  }));
}

function requestForModel(request: CanonicalRequest, model: PublicModel): CanonicalRequest {
  return { ...request, model: model.upstreamId };
}

async function* withPublicModel(
  events: AsyncIterable<CanonicalStreamEvent>,
  publicModelId: string,
  tools?: CanonicalRequest['tools'],
): AsyncGenerator<CanonicalStreamEvent> {
  for await (const event of events) {
    if (event.type === 'start') {
      yield { ...event, model: publicModelId };
    } else if (event.type === 'tool_call_delta') {
      yield { ...event, tool_calls: bindCanonicalToolCalls(event.tool_calls, tools) };
    } else {
      yield event;
    }
  }
}

function withPublicResult(
  result: CanonicalResult,
  publicModelId: string,
  tools?: CanonicalRequest['tools'],
): CanonicalResult {
  return { ...result, model: publicModelId, tool_calls: bindCanonicalToolCalls(result.tool_calls, tools) };
}

function boundedError(error: unknown): { code: string; message: string } {
  const candidate = error as NodeJS.ErrnoException;
  return {
    code: candidate?.code || 'realm_discovery_failed',
    message: sanitizeBoundedMessage(error instanceof Error ? error.message : 'Trae realm discovery failed.'),
  };
}

function sanitizeBoundedMessage(message: string): string {
  return redactSensitiveText(message)
    .replace(/https?:\/\/[^\s]+/gi, '<redacted-url>')
    .slice(0, 300);
}
