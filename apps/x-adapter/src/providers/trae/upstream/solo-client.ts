import { env, intEnv } from '../config/env.js';
import { TraeRegion } from '../config/realm.js';
import { TraeSession } from '../auth/credential.js';
import { fetchWithRetry } from './retry.js';

/**
 * Web SOLO remote catalog (`core-normal.trae.ai/api/remote/v1/models`).
 *
 * GET /models returns the authoritative SOLO model catalog for the account.
 * The web client identity (`X-Trae-Client-Type: web` + `work.trae.ai` origin)
 * is mandatory: the backend rejects calls whose origin does not match the JWT
 * session origin with a bare 401, even with a fresh token. The former
 * chat_sessions conversational transport lived here as well; it was removed
 * after the work-tier (`solo_work_lite`) route replaced it — see
 * solo-work-chat.ts and docs/verification.md for the evidence.
 */

export const SOLO_REMOTE_BASE_URL = 'https://core-normal.trae.ai/api/remote/v1';
const DEFAULT_WEB_ORIGIN = 'https://work.trae.ai';
const WEB_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export type SoloRemoteModel = {
  /** Bare upstream model name accepted as the chat `config_name`/`model`. */
  name: string;
  displayName: string;
  /** SOLO remote function group the catalog listed the model under. */
  functionName: string;
};

export type FetchLike = typeof fetch;

export function soloRemoteBaseUrl(): string {
  return env('X_ADAPTER_TRAE_SOLO_REMOTE_BASE_URL', SOLO_REMOTE_BASE_URL).replace(/\/+$/, '');
}

function soloRemoteHeaders(session: TraeSession): Record<string, string> {
  return {
    authorization: `Cloud-IDE-JWT ${session.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    'x-trae-client-type': 'web',
    'x-preferenced-language': 'en',
    'x-user-region': soloUserRegion(session.region),
    origin: DEFAULT_WEB_ORIGIN,
    referer: `${DEFAULT_WEB_ORIGIN}/`,
    'user-agent': WEB_USER_AGENT,
  };
}

function soloUserRegion(region: TraeRegion): string {
  return region === 'sg' ? 'SG' : 'US';
}

export async function fetchSoloRemoteModels(
  session: TraeSession,
  fetchImpl: FetchLike = fetch,
): Promise<SoloRemoteModel[]> {
  const timeoutMs = intEnv('X_ADAPTER_TRAE_MODEL_TIMEOUT_MS', 30_000);
  const response = await fetchWithRetry(
    `${soloRemoteBaseUrl()}/models`,
    { headers: soloRemoteHeaders(session), signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined },
    { fetchImpl },
  );
  if (!response.ok) {
    const error = new Error(`Trae SOLO remote models returned HTTP ${response.status}.`);
    (error as NodeJS.ErrnoException).code = 'upstream_http_error';
    throw error;
  }
  const payload = await response.json().catch(() => null);
  return parseSoloRemoteModels(payload);
}

export function parseSoloRemoteModels(payload: unknown): SoloRemoteModel[] {
  const root = payload as { data?: { list?: Array<{ function?: unknown; models?: unknown }> } } | null;
  const groups = root?.data?.list;
  if (!Array.isArray(groups)) {
    return [];
  }
  const models: SoloRemoteModel[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    const functionName = typeof group?.function === 'string' ? group.function : '';
    const entries = Array.isArray(group?.models) ? (group.models as Record<string, unknown>[]) : [];
    for (const entry of entries) {
      const name = typeof entry?.name === 'string' ? entry.name : '';
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      models.push({
        name,
        displayName: typeof entry?.display_name === 'string' ? entry.display_name : name,
        functionName,
      });
    }
  }
  return models;
}
