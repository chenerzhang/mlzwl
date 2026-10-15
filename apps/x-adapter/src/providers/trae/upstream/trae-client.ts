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
    hot?: number | null;
    model_load?: number | null;
    model_load_percent?: number | null;
    quota?: unknown;
    supported_reasoning_levels?: unknown[];
    default_reasoning_level?: string | null;
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
  const byId = new Map<string, TraeModelConfig>();
  const created = Math.floor(Date.now() / 1000);
  for (const fn of TRAE_FUNCTIONS) {
    for (const raw of groups[fn] ?? []) {
      const entry = asObject(raw);
      const configName = stringValue(entry.config_name);
      if (!configName || entry.config_switch === false || entry.is_invisible_to_user === true) {
        continue;
      }
      const details = Array.isArray(entry.model_detail_list) ? entry.model_detail_list : [];
      const detail = asObject(details[0]);
      const modelName = stringValue(detail.model_name) || stringValue(entry.model_name) || configName;
      const display = asObject(entry.display_config);
      const displayName =
        stringValue(display.display_name) ||
        stringValue(entry.display_name) ||
        stringValue(entry.display_model_name) ||
        configName;
      const hotInfo = asObject(display.hot_info);
      const load = finiteNumber(hotInfo.hot) ?? null;
      const reasoningLevels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
      const existing = byId.get(configName);
      if (existing) {
        if (!existing.metadata.functions.includes(fn)) {
          existing.metadata.functions.push(fn);
        }
        if (!existing.metadata.model_name.endsWith('__dev') && modelName.endsWith('__dev')) {
          existing.metadata.model_name = modelName;
        }
        continue;
      }
      byId.set(configName, {
        id: `${realm}-${configName}`,
        object: 'model',
        created,
        owned_by: 'trae',
        permission: [],
        root: `${realm}-${configName}`,
        parent: null,
        metadata: {
          realm,
          config_name: configName,
          model_name: modelName,
          display_name: displayName,
          functions: [fn],
          is_default: Boolean(entry.is_default),
          max_tokens: finiteNumber(detail.max_tokens),
          prompt_max_tokens: finiteNumber(detail.prompt_max_tokens),
          hot: load,
          model_load: load,
          model_load_percent: load,
          quota: entry.quota ?? entry.quota_info ?? display.quota ?? display.quota_info ?? null,
          supported_reasoning_levels: reasoningLevels,
          default_reasoning_level: stringValue(entry.default_reasoning_level) || null,
        },
      });
    }
  }
  return [...byId.values()];
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

function isTraeFunction(value: string): value is TraeFunction {
  return (TRAE_FUNCTIONS as readonly string[]).includes(value);
}
