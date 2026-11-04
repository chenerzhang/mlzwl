/** Minimal shapes of the OpenCode v1 plugin contract that magpie loads. */

export type ChatHeadersInput = {
  sessionID?: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  provider?: unknown;
  message?: unknown;
};

export type ChatHeadersOutput = { headers: Record<string, string> };

export type ProviderAuth = {
  type?: string;
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

export type GetAuth = () => Promise<ProviderAuth | undefined>;

export type ProviderModel = {
  id: string;
  name?: string;
  limit?: { context?: number; input?: number; output?: number };
  reasoning?: boolean;
  variants?: Record<string, unknown>;
  capabilities?: {
    reasoning?: boolean;
    toolcall?: boolean;
    attachment?: boolean;
    input?: Record<string, boolean>;
    output?: Record<string, boolean>;
  };
  [key: string]: unknown;
};

export type ProviderInfo = {
  id: string;
  name?: string;
  models: Record<string, ProviderModel>;
  [key: string]: unknown;
};

export type ProviderConfig = {
  provider?: Record<string, unknown>;
  [key: string]: unknown;
};

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type LoaderOptions = {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
};

export type PluginHooks = {
  config?: (config: ProviderConfig) => Promise<void> | void;
  auth?: {
    provider: string;
    methods: Array<Record<string, unknown>>;
    loader: (getAuth: GetAuth, provider?: ProviderInfo) => Promise<LoaderOptions> | LoaderOptions;
  };
  'chat.headers'?: (input: ChatHeadersInput, output: ChatHeadersOutput) => Promise<void> | void;
  provider?: {
    id: string;
    models: (provider: ProviderInfo, options?: { auth?: ProviderAuth }) => Promise<Record<string, ProviderModel>>;
  };
};

export type PluginFactory = () => Promise<PluginHooks> | PluginHooks;
