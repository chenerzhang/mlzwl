import { createHash, randomUUID } from 'node:crypto';
import { intEnv } from '../config/env.js';
import { TRAE_FUNCTIONS, TraeFunction, TraeRealm } from '../config/realm.js';
import { TraeSession } from '../auth/credential.js';
import { fetchWithRetry } from './retry.js';

export const TRAE_BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param';
export const TRAE_MODELS_PATH = '/api/ide/v1/get_detail_param';
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat';
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';

export type TraeModelConfig = {
  id: string;
  object: 'model';
  created: number;
  owned_by: 'trae';
  permission: unknown[];
  root: string;
  parent: null;
  metadata: {
    realm: TraeRealm;
    config_name: string;
    model_name: string;
    display_name: string;
    functions: TraeFunction[];
    is_default: boolean;
    max_tokens?: number;
    prompt_max_tokens?: number;
    /** Total input and output context for this concrete backend variant. */
    context_window_tokens?: number;
    /** Concrete upstream backend selected by this catalog row. */
    backend_variant?: 'standard' | 'max';
    hot?: number | null;
    model_load?: number | null;
    model_load_percent?: number | null;
    quota?: unknown;
    supported_reasoning_levels?: unknown[];
    default_reasoning_level?: string | null;
    /** Upstream `display_config.multimodal`: whether user image input is accepted. */
    multimodal?: boolean;
    /** Whether images returned by tools are accepted as follow-up input. */
    tool_response_multimodal?: boolean;
    /** Present on entries discovered via the SOLO remote merge path. */
    solo_source?: 'solo_remote' | 'solo_preset';
  };
};

export type FetchLike = typeof fetch;

export function traeChatUrl(session: TraeSession): string {
  return `${session.dataBaseUrl}${TRAE_CHAT_PATH}`;
}

export function upstreamHeaders(session: TraeSession, accept = 'text/event-stream'): Record<string, string> {
  return {
    authorization: `Cloud-IDE-JWT ${session.token}`,
    'x-cloudide-token': session.token,
    'x-ide-token': session.token,
    ...(session.uid ? { 'x-uid': session.uid } : {}),
    'x-app-id': TRAE_APP_ID,
    'x-device-id': session.deviceId,
    'x-machine-id': session.machineId,
    'x-request-id': randomUUID(),
    'x-app-version': session.appVersion,
    'x-app-version-code': session.versionCode,
    'x-ide-version': session.appVersion,
    'x-ide-version-code': session.versionCode,
    'x-ide-version-type': session.quality,
    accept,
    'content-type': 'application/json',
    'user-agent': `Trae/${session.appVersion}`,
  };
}

export function modelCacheKey(session: TraeSession): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        realm: session.realm,
        uid: session.uid || 'anonymous',
        host: session.dataBaseUrl,
        version: session.appVersion,
        functions: TRAE_FUNCTIONS,
      }),
    )
    .digest('hex')
    .slice(0, 24);
}

export async function fetchModelConfigs(
  session: TraeSession,
  fetchImpl: FetchLike = fetch,
): Promise<TraeModelConfig[]> {
  const timeoutMs = intEnv('X_ADAPTER_TRAE_MODEL_TIMEOUT_MS', 30_000);
  const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  let groups: Partial<Record<TraeFunction, unknown[]>> | null = null;
  try {
    const response = await fetchWithRetry(
      `${session.dataBaseUrl}${TRAE_BATCH_MODELS_PATH}`,
      {
        method: 'POST',
        headers: upstreamHeaders(session, 'application/json'),
        body: JSON.stringify({
          functions: TRAE_FUNCTIONS,
          agent_type: '',
          current_config_info: { config_name: '', is_custom_model: false },
          mode_type: 0,
          access_type: 0,
          ab_force_vids: '',
          ab_autotest_advanced_mode: 0,
          show_custom_model: true,
        }),
        signal,
      },
      { fetchImpl },
    );
    const payload = await jsonResponse(response, 'batch_get_detail_param');
    if (response.ok) {
      groups = parseBatchGroups(payload);
    } else if (response.status === 401 || response.status === 403) {
      throw upstreamHttpError(response.status, 'batch_get_detail_param');
    }
  } catch (error) {
    if (isAuthenticationError(error)) {
      throw error;
    }
    groups = null;
  }

  if (!groups) {
    groups = {};
    const attempts = await Promise.allSettled(
      TRAE_FUNCTIONS.map(async (fn) => {
        const response = await fetchWithRetry(
          `${session.dataBaseUrl}${TRAE_MODELS_PATH}`,
          {
            method: 'POST',
            headers: upstreamHeaders(session, 'application/json'),
            body: JSON.stringify({
              function: fn,
              config_names: null,
              need_prompt: false,
              current_config_info: null,
              poly_prompt: true,
              mode_type: null,
              agent_type: null,
            }),
            signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
          },
          { fetchImpl },
        );
        const payload = await jsonResponse(response, 'get_detail_param');
        if (!response.ok) {
          throw upstreamHttpError(response.status, 'get_detail_param');
        }
        return { fn, entries: modelEntries(payload) };
      }),
    );
    const authenticationFailure = attempts.find(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === 'rejected' && isAuthenticationError(attempt.reason),
    );
    if (authenticationFailure) {
      throw authenticationFailure.reason;
    }
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled' && attempt.value.entries.length) {
        groups[attempt.value.fn] = attempt.value.entries;
      }
    }
    if (!Object.keys(groups).length && attempts.every((attempt) => attempt.status === 'rejected')) {
      throw attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected')!.reason;
    }
  }

  return mergeModelGroups(session.realm, groups);
}

function parseBatchGroups(payload: unknown): Partial<Record<TraeFunction, unknown[]>> | null {
  const root = asObject(payload);
  const data = asObject(root.data);
  const values = Array.isArray(root.function_configs)
    ? root.function_configs
    : Array.isArray(data.function_configs)
      ? data.function_configs
      : [];
  const groups: Partial<Record<TraeFunction, unknown[]>> = {};
  for (const raw of values) {
    const group = asObject(raw);
    const fn = typeof group.function === 'string' ? group.function : '';
    if (!isTraeFunction(fn) || !Array.isArray(group.config_info_list)) {
      continue;
    }
    const usable = group.config_info_list.filter(isUsableModelEntry);
    if (usable.length) {
      groups[fn] = [...(groups[fn] ?? []), ...usable];
    }
  }
  return Object.keys(groups).length ? groups : null;
}

function isUsableModelEntry(value: unknown): boolean {
  const entry = asObject(value);
  return Boolean(
    stringValue(entry.config_name) && entry.config_switch !== false && entry.is_invisible_to_user !== true,
  );
}

function modelEntries(payload: unknown): unknown[] {
  const root = asObject(payload);
  const data = asObject(root.data);
  return Array.isArray(root.config_info_list)
    ? root.config_info_list
    : Array.isArray(data.config_info_list)
      ? data.config_info_list
      : [];
}

export function mergeModelGroups(
  realm: TraeRealm,
  groups: Partial<Record<TraeFunction, unknown[]>>,
): TraeModelConfig[] {
  const collected = new Map<string, CollectedModelEntry>();
  for (const fn of TRAE_FUNCTIONS) {
    for (const raw of groups[fn] ?? []) {
      const entry = asObject(raw);
      const configName = stringValue(entry.config_name);
      if (!configName || entry.config_switch === false || entry.is_invisible_to_user === true) {
        continue;
      }
      collectModelEntry(collected, realm, fn, configName, entry);
    }
  }
  const created = Math.floor(Date.now() / 1000);
  return [...collected.values()].flatMap((entry) => expandModelVariants(realm, created, entry));
}

type CollectedModelEntry = {
  realm: TraeRealm;
  configName: string;
  functions: TraeFunction[];
  isDefault: boolean;
  displayName: string;
  /** `entry.quota` / `entry.quota_info`. */
  entryQuota: unknown;
  /** `display_config` quota; the detail-level value is only a last resort. */
  displayQuota: unknown;
  hot: number | null;
  multimodal?: boolean;
  toolResponseMultimodal?: boolean;
  baseDetail?: Record<string, unknown>;
  maxDetail?: Record<string, unknown>;
  devContextWindow?: number;
  maxContextWindow?: number;
  maxMode: boolean;
  /** Entry-level reasoning declaration; a detail-level value only fills the gap. */
  reasoningLevels: unknown[];
  defaultReasoningLevel: string | null;
};

/**
 * An entry can be advertised once per Trae function. Keep the first observation
 * for scalar display fields, merge the function list, and prefer the explicit
 * `__dev` detail over an unnamed row for the standard backend.
 */
function collectModelEntry(
  collected: Map<string, CollectedModelEntry>,
  realm: TraeRealm,
  fn: TraeFunction,
  configName: string,
  entry: Record<string, unknown>,
): void {
  const display = asObject(entry.display_config);
  const contextWindows = asObject(entry.context_window_tokens);
  const details = (Array.isArray(entry.model_detail_list) ? entry.model_detail_list : []).map(asObject);
  const existing = collected.get(configName);
  const target: CollectedModelEntry = existing ?? {
    realm,
    configName,
    functions: [],
    isDefault: Boolean(entry.is_default),
    displayName:
      stringValue(display.display_name) ||
      stringValue(entry.display_name) ||
      stringValue(entry.display_model_name) ||
      configName,
    entryQuota: entry.quota ?? entry.quota_info,
    displayQuota: display.quota ?? display.quota_info,
    hot: finiteNumber(asObject(display.hot_info).hot) ?? null,
    multimodal: booleanValue(display.multimodal),
    toolResponseMultimodal: booleanValue(display.tool_response_multimodal),
    maxMode: display.max_mode === true,
    reasoningLevels: Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [],
    defaultReasoningLevel: stringValue(entry.default_reasoning_level) || null,
  };
  if (!target.functions.includes(fn)) {
    target.functions.push(fn);
  }
  const devDetail = details.find(isStandardDetail);
  const standardDetail =
    devDetail ?? details.find((detail) => Boolean(asString(detail.model_name)) && !isMaxDetail(detail));
  const baseDetail = standardDetail ?? details.find((detail) => Boolean(asString(detail.model_name)));
  const maxDetail = details.find(isMaxDetail);
  target.baseDetail ??= baseDetail;
  target.maxDetail ??= maxDetail;
  target.devContextWindow ??= finiteNumber(contextWindows.dev);
  target.maxContextWindow ??= finiteNumber(contextWindows.max);
  collected.set(configName, target);
}

/**
 * Emit the standard backend plus, only when the upstream advertises every
 * Max-mode contract field, a second exact-routable `-max` variant.
 */
function expandModelVariants(realm: TraeRealm, created: number, entry: CollectedModelEntry): TraeModelConfig[] {
  const variants: Array<{
    upstreamId: string;
    detail: Record<string, unknown>;
    variant: 'standard' | 'max';
    contextWindow?: number;
  }> = [];
  const baseDetail = entry.baseDetail;
  if (baseDetail) {
    const baseVariant = isMaxDetail(baseDetail) ? 'max' : 'standard';
    variants.push({
      upstreamId: entry.configName,
      detail: baseDetail,
      variant: baseVariant,
      contextWindow: baseVariant === 'max' ? entry.maxContextWindow : entry.devContextWindow,
    });
  }
  const maxDetail = entry.maxMode && entry.maxContextWindow !== undefined ? entry.maxDetail : undefined;
  if (maxDetail && maxDetail !== baseDetail) {
    variants.push({
      upstreamId: `${entry.configName}-max`,
      detail: maxDetail,
      variant: 'max',
      contextWindow: entry.maxContextWindow,
    });
  }
  return variants.flatMap(({ upstreamId, detail, variant, contextWindow }) => {
    const modelName = asString(detail.model_name);
    if (!modelName) {
      return [];
    }
    return [
      {
        id: `${realm}-${upstreamId}`,
        object: 'model' as const,
        created,
        owned_by: 'trae' as const,
        permission: [],
        root: `${realm}-${upstreamId}`,
        parent: null,
        metadata: {
          realm,
          config_name: entry.configName,
          model_name: modelName,
          display_name: upstreamId.endsWith('-max') ? `${entry.displayName} / Max` : entry.displayName,
          functions: [...entry.functions],
          is_default: upstreamId === entry.configName && entry.isDefault,
          max_tokens: finiteNumber(detail.max_tokens),
          prompt_max_tokens: finiteNumber(detail.prompt_max_tokens),
          context_window_tokens: contextWindow,
          backend_variant: variant,
          hot: entry.hot,
          model_load: entry.hot,
          model_load_percent: entry.hot,
          quota: entry.entryQuota ?? entry.displayQuota ?? detail.quota ?? detail.quota_info ?? null,
          supported_reasoning_levels: entry.reasoningLevels.length
            ? entry.reasoningLevels
            : detailReasoningLevels(detail),
          default_reasoning_level: entry.defaultReasoningLevel ?? detailDefaultReasoningLevel(detail),
          multimodal: entry.multimodal,
          tool_response_multimodal: entry.toolResponseMultimodal,
        },
      },
    ];
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function modelExtraConfig(detail: Record<string, unknown>): Record<string, unknown> {
  if (typeof detail.model_extra_config !== 'string') {
    return asObject(detail.model_extra_config);
  }
  if (!detail.model_extra_config) {
    return {};
  }
  try {
    return asObject(JSON.parse(detail.model_extra_config));
  } catch {
    return {};
  }
}

/** `__dev` marks the standard backend, `__max` marks the Max backend. */
function isMaxDetail(detail: Record<string, unknown>): boolean {
  return asString(detail.model_name)?.toLowerCase().endsWith('__max') === true;
}

function isStandardDetail(detail: Record<string, unknown>): boolean {
  return asString(detail.model_name)?.toLowerCase().endsWith('__dev') === true;
}

/** Detail-level reasoning config only fills the gap of a missing entry declaration. */
function detailReasoningLevels(detail: Record<string, unknown>): unknown[] {
  const configured = modelExtraConfig(detail).reasoning_effort_options;
  return Array.isArray(configured) ? configured : [];
}

function detailDefaultReasoningLevel(detail: Record<string, unknown>): string | null {
  return asString(modelExtraConfig(detail).ReasoningEffort) ?? null;
}

async function jsonResponse(response: Response, operation: string): Promise<unknown> {
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error(`Trae ${operation} returned a non-JSON response.`);
    (error as NodeJS.ErrnoException).code = 'upstream_invalid_response';
    throw error;
  }
  const root = asObject(payload);
  if (response.ok && Number(root.code ?? 0) !== 0) {
    const error = new Error(stringValue(root.message) || `Trae ${operation} failed.`);
    (error as NodeJS.ErrnoException).code = 'upstream_response_error';
    throw error;
  }
  return payload;
}

function upstreamHttpError(status: number, operation: string): Error {
  const error = new Error(`Trae ${operation} returned HTTP ${status}.`);
  (error as NodeJS.ErrnoException).code =
    status === 401 || status === 403 ? 'trae_auth_rejected' : 'upstream_http_error';
  return error;
}

function isAuthenticationError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'trae_auth_rejected';
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isTraeFunction(value: string): value is TraeFunction {
  return (TRAE_FUNCTIONS as readonly string[]).includes(value);
}
