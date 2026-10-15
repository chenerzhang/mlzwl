export const PROVIDER_IDS = ['trae', 'doubao'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type ModelLoad = number | null;

export type ProviderModel = {
  /** Stable provider-local identifier exposed through the unified public model ID. */
  upstreamId: string;
  configName: string;
  modelName: string;
  displayName: string;
  isDefault?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  modelLoad?: ModelLoad;
  quota?: unknown;
  supportedReasoningLevels?: string[];
  defaultReasoningLevel?: string | null;
  metadata?: Record<string, unknown>;
};

export type PublicModel = ProviderModel & {
  /** Globally unique x-adapter model ID, such as trae-global-<upstream-id>. */
  id: string;
  provider: ProviderId;
};

export type ProviderRealmStatus = {
  realm: string;
  configured: boolean;
  available: boolean;
  modelCount: number;
  fromCache: boolean;
  lastError?: { code: string; message: string };
};

export type ProviderStatus = {
  provider: ProviderId;
  displayName: string;
  available: boolean;
  modelCount: number;
  fromCache: boolean;
  realms?: ProviderRealmStatus[];
  lastError?: { code: string; message: string };
};

export type ModelDiscoveryResult = {
  provider: ProviderId;
  displayName: string;
  models: ProviderModel[];
  available?: boolean;
  fromCache?: boolean;
  realms?: ProviderRealmStatus[];
};

export type ProviderAdapter = {
  readonly id: ProviderId;
  readonly displayName: string;
  discoverModels(): Promise<ModelDiscoveryResult>;
};
