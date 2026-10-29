import path from 'node:path';
import { dataDir as xAdapterDataDir, env, expandHome, intEnv } from '../../../config/env.js';

export { env, intEnv } from '../../../config/env.js';

export function boolEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())) {
    return false;
  }
  return fallback;
}

export function doubaoBaseUrl(): string {
  return env('DOUBAO_BASE_URL', 'https://www.doubao.com').replace(/\/+$/, '');
}

export function doubaoDataDir(): string {
  return path.resolve(expandHome(env('X_ADAPTER_DOUBAO_DATA_DIR', path.join(xAdapterDataDir(), 'doubao-work'))));
}

export function doubaoCacheDir(): string {
  return path.resolve(expandHome(env('X_ADAPTER_DOUBAO_CACHE_DIR', path.join(xAdapterDataDir(), 'cache', 'doubao'))));
}

export function defaultDoubaoModel(): string {
  return env('X_ADAPTER_DOUBAO_MODEL', 'work-auto');
}

/** Total cap for short, non-streaming Doubao calls (model list, conversation sync). */
export function doubaoTimeoutSignal(clientSignal?: AbortSignal): AbortSignal | undefined {
  const timeoutMs = intEnv('X_ADAPTER_DOUBAO_TIMEOUT_MS', 180_000);
  if (timeoutMs <= 0) {
    return clientSignal;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!clientSignal) {
    return timeout;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([clientSignal, timeout]);
  }
  return timeout;
}

/**
 * Inactivity budget for a completion stream. A multi-step Doubao turn can stream
 * for several minutes on one connection, so a fixed total timeout kills healthy
 * long turns. The watchdog re-arms only when the projector reports real progress
 * (answer text, reasoning, or a server-side tool activity block); bare SSE
 * keep-alives must not refresh it, so a genuinely stalled turn still fails.
 */
export function doubaoStreamIdleTimeoutMs(): number {
  return intEnv('X_ADAPTER_DOUBAO_IDLE_TIMEOUT_MS', 180_000);
}

export type DoubaoStreamWatchdog = {
  signal: AbortSignal;
  /** Re-arm the inactivity timer after observable agent progress. */
  arm: () => void;
  /** Release the timer without aborting (stream settled normally). */
  dispose: () => void;
  /** True when the abort came from this watchdog rather than the caller. */
  tripped: () => boolean;
};

/**
 * Combine the caller signal with a re-armable inactivity timer. Unlike
 * `AbortSignal.timeout`, the timer restarts on progress instead of expiring at a
 * fixed total elapsed time.
 */
export function createDoubaoStreamWatchdog(clientSignal?: AbortSignal): DoubaoStreamWatchdog {
  const controller = new AbortController();
  const idleMs = doubaoStreamIdleTimeoutMs();
  let tripped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const dispose = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const arm = (): void => {
    dispose();
    if (idleMs <= 0 || controller.signal.aborted) {
      return;
    }
    timer = setTimeout(() => {
      tripped = true;
      controller.abort();
    }, idleMs);
    timer.unref?.();
  };
  const forwardAbort = (): void => controller.abort();

  if (clientSignal) {
    if (clientSignal.aborted) {
      forwardAbort();
    } else {
      clientSignal.addEventListener('abort', forwardAbort, { once: true });
    }
  }
  arm();

  return {
    signal: controller.signal,
    arm,
    dispose: () => {
      dispose();
      clientSignal?.removeEventListener('abort', forwardAbort);
    },
    tripped: () => tripped,
  };
}
