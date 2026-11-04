import { baseUrl, clientToken, ensureDaemon, readHealth } from './daemon.js';
import { parseDiscoveryModels, toProviderModel } from './discovery.js';
import type {
  ChatHeadersInput,
  ChatHeadersOutput,
  GetAuth,
  LoaderOptions,
  PluginHooks,
  ProviderAuth,
  ProviderConfig,
  ProviderInfo,
  ProviderModel,
} from './types.js';

const PROVIDER_ID = 'x-adapter';
const DISCOVERY_USER_AGENT = 'codex-cli';
const DISCOVERY_TIMEOUT_MS = 15_000;
const MODEL_CACHE_TTL_MS = 30_000;

type CachedModels = { at: number; token: string; models: ProviderModel[] };

function accountToken(auth: ProviderAuth | undefined, fallbackToken: string): string {
  // The daemon compares its token byte for byte, so trim nothing here.
  return auth?.key && auth.key.length > 0 ? auth.key : fallbackToken;
}

function providerBase(base: URL): string {
  return `${base.origin}/v1`;
}

async function requestModels(base: URL, token: string): Promise<Response> {
  try {
    return await fetch(`${base.origin}/v1/models`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': DISCOVERY_USER_AGENT,
        Authorization: `Bearer ${token}`,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Unable to request the x-adapter model catalogue.');
  }
}

async function readModelsPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('x-adapter /v1/models returned invalid JSON.');
  }
}

async function verifyClientToken(base: URL, token: string): Promise<void> {
  const response = await requestModels(base, token);
  // Nothing reads this body, so release the socket instead of leaving the
  // response half-consumed.
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'x-adapter rejected the client token. Set X_ADAPTER_CLIENT_TOKEN to the daemon token and sign in again.',
    );
  }
  if (response.status >= 300 && response.status < 400) {
    // `redirect: 'manual'` means a redirect was answered, not followed. That is
    // not this gateway's own answer, so it proves nothing about the token.
    throw new Error('x-adapter /v1/models answered a redirect; refusing to treat it as a verified gateway.');
  }
  // x-adapter runs its client-token check on every /v1/ request before routing,
  // so any other status proves the token was accepted. An upstream 5xx or a
  // model-catalogue problem is not a credential failure and must not block a
  // sign-in the user cannot fix by changing the token.
}

async function discover(base: URL, token: string): Promise<ProviderModel[]> {
  const response = await requestModels(base, token);
  if (!response.ok) {
    // 503 is x-adapter's "no provider is usable right now", which is a failure
    // worth keeping the previous list for.
    throw new Error(`x-adapter /v1/models answered HTTP ${response.status}`);
  }
  const models = parseDiscoveryModels(await readModelsPayload(response));
  if (models === undefined) {
    throw new Error('x-adapter /v1/models did not return a models array');
  }
  // HTTP 200 with an empty list is a valid answer: the user hid every model or
  // provider. Reporting it as a failure would leave magpie showing models the
  // gateway no longer offers.
  return models.map(toProviderModel);
}

/**
 * List the gateway's models for one account.
 *
 * A failure is thrown rather than answered with the list magpie handed over.
 * magpie only treats a fallback as "keep what you had" when its own request
 * failed; handing back the unchanged object without making one would be read as
 * a successful empty catalogue and clear the picker. Throwing keeps the
 * previous list and shows the reason.
 */
function createModelLister(base: URL, fallbackToken: string): NonNullable<PluginHooks['provider']>['models'] {
  // Each factory captures one gateway origin. Cache only the latest account's
  // catalogue so another gateway or credential cannot reuse it.
  let cache: CachedModels | undefined;
  return async (provider: ProviderInfo, options): Promise<Record<string, ProviderModel>> => {
    const auth = options?.auth;
    if (!auth) {
      return provider.models;
    }
    const token = accountToken(auth, fallbackToken);
    if (cache?.token === token && Date.now() - cache.at < MODEL_CACHE_TTL_MS) {
      return Object.fromEntries(cache.models.map((model) => [model.id, model]));
    }
    await ensureDaemon(base);
    const models = await discover(base, token);
    cache = { at: Date.now(), token, models };
    return Object.fromEntries(models.map((model) => [model.id, model]));
  };
}

function isAbortError(error: unknown, signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true || (error as { name?: unknown } | null)?.name === 'AbortError';
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Forward the request to the local gateway.
 *
 * The fetch refuses any URL outside this gateway's `/v1`, so a wrong base
 * cannot turn the plugin into a proxy for another host. Redirects are not
 * followed for the same reason.
 */
function gatewayFetch(base: URL, fallbackToken: string): LoaderOptions['fetch'] {
  const origin = base.origin;
  const prefix = `${origin}/v1/`;
  return async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return jsonError(400, 'x-adapter plugin received an invalid request URL.');
    }
    if (url.username || url.password || url.origin !== origin || !url.href.startsWith(prefix)) {
      return jsonError(400, 'x-adapter plugin only forwards credential-free URLs under the configured gateway /v1/.');
    }
    const headers = new Headers(init?.headers);
    // magpie sends the account's key in the Anthropic header because this
    // provider's npm is @ai-sdk/anthropic. x-adapter guards its data plane
    // with `Authorization: Bearer`, and reads nothing else as an upstream
    // credential.
    const key = headers.get('x-api-key')?.trim() || fallbackToken;
    headers.delete('x-api-key');
    if (key && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${key}`);
    }
    try {
      return await fetch(url.href, { ...init, headers, redirect: 'manual' });
    } catch (error) {
      // A cancelled request is the caller's own decision: keep it an
      // AbortError so cancellation stays distinguishable from a gateway fault.
      if (isAbortError(error, init?.signal)) {
        throw error;
      }
      throw new Error('Unable to forward the request to the x-adapter gateway.', { cause: error });
    }
  };
}

async function authorize(
  base: URL,
  token: string,
): Promise<{ type: 'success'; key: string } | { type: 'failed'; error: string }> {
  try {
    await ensureDaemon(base);
    await readHealth(base);
    await verifyClientToken(base, token);
    return { type: 'success', key: token };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      type: 'failed',
      error:
        `${reason}\n\n` +
        'Start the gateway with `x-adapter start`, or set X_ADAPTER_BASE_URL to the gateway this computer runs.',
    };
  }
}

export const XAdapterPlugin = async (): Promise<PluginHooks> => {
  // A configured but unusable X_ADAPTER_BASE_URL throws here, so magpie reports
  // the plugin as not loaded instead of quietly sending requests elsewhere.
  const base = baseUrl();
  const token = clientToken();
  return {
    config: async (config: ProviderConfig) => {
      config.provider ??= {};
      const providers = config.provider as Record<string, Record<string, unknown>>;
      providers[PROVIDER_ID] ??= {
        name: 'x-adapter',
        // magpie converts every agent's protocol to Anthropic Messages for
        // this provider, and x-adapter serves that endpoint itself.
        npm: '@ai-sdk/anthropic',
        api: providerBase(base),
        models: {},
      };
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: 'api',
          label: 'Use the local x-adapter gateway',
          // Nothing is typed: the plugin asks the gateway whether it runs,
          // and starts it once when it does not.
          keyless: true,
          authorize: () => authorize(base, token),
        },
      ],
      loader: async (getAuth: GetAuth): Promise<LoaderOptions> => {
        const key = accountToken(await getAuth(), token);
        return {
          baseURL: providerBase(base),
          apiKey: key,
          headers: { 'User-Agent': DISCOVERY_USER_AGENT },
          fetch: gatewayFetch(base, key),
        };
      },
    },
    'chat.headers': async (input: ChatHeadersInput, output: ChatHeadersOutput) => {
      if (!input.sessionID) {
        return;
      }
      // x-adapter keys its Doubao tool bridge by session. A stable value per
      // conversation lets the bridge find the same upstream turn again.
      output.headers['x-session-id'] = String(input.sessionID);
    },
    provider: {
      id: PROVIDER_ID,
      models: createModelLister(base, token),
    },
  };
};
