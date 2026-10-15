import { randomUUID } from 'node:crypto';
import { DoubaoCredential } from '../auth/doubao-cookie.js';
import { doubaoBaseUrl } from '../config/env.js';

export type FetchLike = typeof fetch;

export const DOUBAO_BOT_ID = '7338286299411103781';
export const DOUBAO_CONVERSATION_TYPE = 3;

export function doubaoQuery(credential: DoubaoCredential): string {
  const query = new URLSearchParams(credential.commonQuery);
  const observedWebId = query.get('device_id') || query.get('web_id') || query.get('tea_uuid');
  query.set('aid', query.get('aid') || '497858');
  if (observedWebId) {
    query.set('device_id', query.get('device_id') || observedWebId);
    query.set('tea_uuid', query.get('tea_uuid') || observedWebId);
    query.set('web_id', query.get('web_id') || observedWebId);
  }
  query.set('device_platform', query.get('device_platform') || 'web');
  query.set('doubao_device_platform', query.get('doubao_device_platform') || 'web');
  query.set('language', query.get('language') || 'zh');
  query.set('real_aid', query.get('real_aid') || '497858');
  query.set('region', query.get('region') || 'CN');
  query.set('samantha_web', query.get('samantha_web') || '1');
  query.set('sys_region', query.get('sys_region') || 'CN');
  query.set('use-olympus-account', query.get('use-olympus-account') || '1');
  query.set('version_code', query.get('version_code') || '20800');
  query.set('web_platform', query.get('web_platform') || 'browser');
  query.set('web_tab_id', randomUUID());
  return query.toString();
}

export function doubaoUrl(pathname: string, credential: DoubaoCredential, query = true): string {
  const url = new URL(pathname, `${doubaoBaseUrl()}/`);
  if (query) {
    url.search = doubaoQuery(credential);
  }
  return url.toString();
}

export function doubaoHeaders(
  credential: DoubaoCredential,
  options: { accept?: string; contentType?: string; refererConversationId?: string; agw?: string } = {},
): Record<string, string> {
  const referer = options.refererConversationId
    ? `${doubaoBaseUrl()}/chat/${options.refererConversationId}`
    : `${doubaoBaseUrl()}/chat/`;
  return {
    Accept: options.accept ?? 'application/json, text/plain, */*',
    'Content-Type': options.contentType ?? 'application/json; encoding=utf-8',
    Cookie: credential.cookie,
    Origin: doubaoBaseUrl(),
    Referer: referer,
    'User-Agent': credential.userAgent,
    'agw-js-conv': options.agw ?? 'str',
  };
}

export function uuid(): string {
  return randomUUID();
}

export function doubaoHttpError(response: Response, action: string): Error {
  const credentialFailure = response.status === 401 || response.status === 403;
  const error = new Error(
    credentialFailure
      ? 'Doubao Work credentials are invalid or expired. Run `x-adapter doubao login`.'
      : `${action} HTTP ${response.status}.`,
  );
  (error as NodeJS.ErrnoException).code = credentialFailure ? 'invalid_doubao_credentials' : 'upstream_http_error';
  Object.assign(error, { status: response.status });
  return error;
}

export async function jsonResponse(response: Response, action: string): Promise<Record<string, any>> {
  if (!response.ok) {
    throw doubaoHttpError(response, action);
  }
  const payload = (await response.json().catch(() => null)) as Record<string, any> | null;
  if (!payload) {
    const error = new Error(`${action} returned invalid JSON.`);
    (error as NodeJS.ErrnoException).code = 'upstream_invalid_response';
    throw error;
  }
  const code = Number(payload.status_code ?? payload.code ?? 0);
  if (Number.isFinite(code) && code !== 0) {
    const error = new Error(
      `${action} failed (${code}): ${String(payload.status_desc ?? payload.msg ?? 'unknown error')}`,
    );
    (error as NodeJS.ErrnoException).code = 'upstream_response_error';
    Object.assign(error, { statusCode: code });
    throw error;
  }
  return payload;
}
