import { defaultOpenAiModel } from '../config/env.js';
import { redactSensitiveText } from '../logging/jsonl.js';
import { publicModelId } from './model-id.js';
import { ModelDiscoveryResult, ProviderAdapter, ProviderId, ProviderStatus, PublicModel } from './types.js';

export type ModelCatalog = {
  models: PublicModel[];
  providerStatuses: ProviderStatus[];
};

export class ModelRegistry {
  constructor(private readonly adapters: readonly ProviderAdapter[]) {}

  async discover(): Promise<ModelCatalog> {
    const attempts = await Promise.allSettled(this.adapters.map((adapter) => adapter.discoverModels()));
    const models: PublicModel[] = [];
    const providerStatuses: ProviderStatus[] = [];
    const seenPublicIds = new Set<string>();

    for (let index = 0; index < attempts.length; index += 1) {
      const adapter = this.adapters[index];
      const attempt = attempts[index];
      if (attempt.status === 'rejected') {
        providerStatuses.push({
          provider: adapter.id,
          displayName: adapter.displayName,
          available: false,
          modelCount: 0,
          fromCache: false,
          lastError: errorSummary(attempt.reason),
        });
        continue;
      }

      const result = attempt.value;
      const providerModels = normalizeDiscoveryModels(result, seenPublicIds);
      models.push(...providerModels);
      providerStatuses.push({
        provider: adapter.id,
        displayName: adapter.displayName,
        available: result.available ?? true,
        modelCount: providerModels.length,
        fromCache: result.fromCache === true,
        realms: result.realms,
      });
    }

    return {
      models: models.sort(compareModels),
      providerStatuses,
    };
  }

  async resolve(requestedModel: string): Promise<PublicModel> {
    const catalog = await this.discover();
    const model = catalog.models.find((candidate) => candidate.id === requestedModel.trim());
    if (model) {
      return model;
    }

    const unavailable = catalog.providerStatuses.filter((status) => !status.available).map((status) => status.provider);
    const suffix = unavailable.length ? ` Unavailable providers: ${unavailable.join(', ')}.` : '';
    const error = new Error(`Unknown x-adapter model: ${requestedModel}.${suffix}`);
    (error as NodeJS.ErrnoException).code = 'model_not_found';
    throw error;
  }

  adapterFor(provider: ProviderId): ProviderAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === provider);
  }
}

function normalizeDiscoveryModels(result: ModelDiscoveryResult, seenPublicIds: Set<string>): PublicModel[] {
  return result.models.map((model) => {
    const upstreamId = model.upstreamId.trim();
    const id = publicModelId(result.provider, upstreamId);
    if (seenPublicIds.has(id)) {
      const error = new Error(`Provider ${result.provider} returned duplicate model ID: ${upstreamId}`);
      (error as NodeJS.ErrnoException).code = 'duplicate_provider_model';
      throw error;
    }
    seenPublicIds.add(id);
    return {
      ...model,
      // Upstream defaults are provider-local. The unified gateway exposes at
      // most one default, so clients never mistake a provider-local default
      // for x-adapter's cross-provider compatibility fallback.
      isDefault: id === defaultOpenAiModel(),
      upstreamId,
      id,
      provider: result.provider,
    };
  });
}

function compareModels(left: PublicModel, right: PublicModel): number {
  return left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
}

function errorSummary(error: unknown): { code: string; message: string } {
  const candidate = error as NodeJS.ErrnoException;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: candidate?.code || 'provider_discovery_failed',
    message: redactSensitiveText(message)
      .replace(/https?:\/\/[^\s]+/gi, '<redacted-url>')
      .slice(0, 300),
  };
}
