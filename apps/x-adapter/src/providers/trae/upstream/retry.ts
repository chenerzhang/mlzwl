import { intEnv } from '../config/env.js';

export type RetryOptions = {
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: (attempt: number, response?: Response, error?: unknown) => number;
  sleep?: (ms: number) => Promise<void>;
};

export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (
    typeof code === 'string' &&
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT',
    ].includes(code.toUpperCase())
  ) {
    return true;
  }
  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    /fetch failed|network|socket|connect|connection reset/i.test(error.message)
  );
}

function retryAfterMs(response?: Response): number | undefined {
  const value = response?.headers.get('retry-after');
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}

export function defaultRetryDelayMs(attempt: number, response?: Response): number {
  return retryAfterMs(response) ?? Math.min(3000, 500 * 2 ** Math.max(0, attempt - 1));
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // best effort before retrying
  }
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? intEnv('X_ADAPTER_TRAE_RETRY_MAX', 2);
  const delay = options.retryDelayMs ?? defaultRetryDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
        return response;
      }
      lastError = undefined;
      await drain(response);
      await sleep(delay(attempt + 1, response));
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted || !isRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }
      await sleep(delay(attempt + 1, undefined, error));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
