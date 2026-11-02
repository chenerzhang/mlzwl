import { intEnv } from '../config/env.js';

/**
 * Shared watchdog for Trae upstream chat streams. Both the IDE
 * `llm_utils_chat` SSE and the Web SOLO remote agent event stream reuse it so
 * client aborts, first-event stalls, idle gaps, and max durations abort the
 * underlying fetch with a typed, diagnostic-carrying error.
 */

const DEFAULT_CHAT_MAX_DURATION_MS = 600_000;
const DEFAULT_CHAT_FIRST_EVENT_TIMEOUT_MS = 120_000;
const DEFAULT_CHAT_IDLE_TIMEOUT_MS = 90_000;
const MIN_CHAT_MAX_DURATION_MS = 1;

export type TraeChatAbortSource = 'client_abort' | 'first_event_timeout' | 'idle_timeout' | 'max_duration_timeout';

export type TraeChatTimeouts = {
  maxDurationMs: number;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
};

export type TraeChatTimeoutDiagnostics = {
  abort_source: TraeChatAbortSource;
  configured_max_duration_ms: number;
  configured_first_event_timeout_ms: number;
  configured_idle_timeout_ms: number;
  first_upstream_event_ms?: number;
  last_upstream_event_ms?: number;
  upstream_idle_ms: number;
  upstream_sse_event_count: number;
};

type TraeChatAbortError = Error & {
  code: string;
  timeout_diagnostics: TraeChatTimeoutDiagnostics;
};

export function traeChatTimeouts(): TraeChatTimeouts {
  const legacyMaxDurationMs = intEnv('X_ADAPTER_TRAE_CHAT_TIMEOUT_MS', DEFAULT_CHAT_MAX_DURATION_MS);
  const configuredMaxDurationMs = intEnv('X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS', legacyMaxDurationMs);
  return {
    maxDurationMs:
      configuredMaxDurationMs >= MIN_CHAT_MAX_DURATION_MS ? configuredMaxDurationMs : DEFAULT_CHAT_MAX_DURATION_MS,
    firstEventTimeoutMs: intEnv('X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS', DEFAULT_CHAT_FIRST_EVENT_TIMEOUT_MS),
    idleTimeoutMs: intEnv('X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS', DEFAULT_CHAT_IDLE_TIMEOUT_MS),
  };
}

function enabledOptionalTimeout(timeoutMs: number): boolean {
  return timeoutMs > 0;
}

function timeoutCode(source: TraeChatAbortSource): string {
  switch (source) {
    case 'first_event_timeout':
      return 'trae_chat_first_event_timeout';
    case 'idle_timeout':
      return 'trae_chat_idle_timeout';
    case 'max_duration_timeout':
      return 'trae_chat_max_duration_timeout';
    case 'client_abort':
      return 'client_abort';
  }
}

function timeoutMessage(source: TraeChatAbortSource, timeouts: TraeChatTimeouts): string {
  switch (source) {
    case 'first_event_timeout':
      return `Trae upstream did not produce an SSE event within ${timeouts.firstEventTimeoutMs}ms.`;
    case 'idle_timeout':
      return `Trae upstream produced no SSE event for ${timeouts.idleTimeoutMs}ms.`;
    case 'max_duration_timeout':
      return `Trae upstream exceeded the ${timeouts.maxDurationMs}ms maximum duration.`;
    case 'client_abort':
      return 'Trae upstream request was aborted by the client.';
  }
}

export class TraeChatWatchdog {
  readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private readonly onClientAbort = () => this.abort('client_abort');
  private firstEventAt: number | undefined;
  private lastEventAt: number | undefined;
  private upstreamSseEventCount = 0;
  private maxDurationTimer: ReturnType<typeof setTimeout> | undefined;
  private firstEventTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private abortedError: TraeChatAbortError | undefined;
  private disposed = false;

  constructor(
    private readonly clientSignal: AbortSignal | undefined,
    private readonly timeouts: TraeChatTimeouts,
  ) {
    this.maxDurationTimer = setTimeout(() => this.abort('max_duration_timeout'), timeouts.maxDurationMs);
    if (enabledOptionalTimeout(timeouts.firstEventTimeoutMs)) {
      this.firstEventTimer = setTimeout(() => this.abort('first_event_timeout'), timeouts.firstEventTimeoutMs);
    }
    if (clientSignal?.aborted) {
      this.abort('client_abort');
    } else {
      clientSignal?.addEventListener('abort', this.onClientAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get error(): TraeChatAbortError | undefined {
    return this.abortedError;
  }

  noteUpstreamSseEvent(): void {
    if (this.controller.signal.aborted) {
      return;
    }
    const now = Date.now();
    this.upstreamSseEventCount += 1;
    if (this.firstEventAt === undefined) {
      this.firstEventAt = now;
      this.clearTimer('firstEventTimer');
    }
    this.lastEventAt = now;
    this.clearTimer('idleTimer');
    if (enabledOptionalTimeout(this.timeouts.idleTimeoutMs)) {
      this.idleTimer = setTimeout(() => this.abort('idle_timeout'), this.timeouts.idleTimeoutMs);
    }
  }

  cancelUpstreamForOutputLimit(): void {
    if (!this.controller.signal.aborted) {
      const error = new Error('Trae upstream exceeded the gateway textual output limit.');
      (error as NodeJS.ErrnoException).code = 'trae_chat_output_limit';
      this.controller.abort(error);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer('maxDurationTimer');
    this.clearTimer('firstEventTimer');
    this.clearTimer('idleTimer');
    this.clientSignal?.removeEventListener('abort', this.onClientAbort);
  }

  private abort(source: TraeChatAbortSource): void {
    if (this.controller.signal.aborted) {
      return;
    }
    const now = Date.now();
    const elapsed = Math.max(0, now - this.startedAt);
    const lastEventElapsed =
      this.lastEventAt === undefined ? undefined : Math.max(0, this.lastEventAt - this.startedAt);
    const error = new Error(timeoutMessage(source, this.timeouts)) as TraeChatAbortError;
    error.name = source === 'client_abort' ? 'AbortError' : 'TimeoutError';
    error.code = timeoutCode(source);
    error.timeout_diagnostics = {
      abort_source: source,
      configured_max_duration_ms: this.timeouts.maxDurationMs,
      configured_first_event_timeout_ms: this.timeouts.firstEventTimeoutMs,
      configured_idle_timeout_ms: this.timeouts.idleTimeoutMs,
      ...(this.firstEventAt === undefined
        ? {}
        : { first_upstream_event_ms: Math.max(0, this.firstEventAt - this.startedAt) }),
      ...(lastEventElapsed === undefined ? {} : { last_upstream_event_ms: lastEventElapsed }),
      upstream_idle_ms: this.lastEventAt === undefined ? elapsed : Math.max(0, now - this.lastEventAt),
      upstream_sse_event_count: this.upstreamSseEventCount,
    };
    this.abortedError = error;
    this.dispose();
    this.controller.abort(error);
  }

  private clearTimer(name: 'maxDurationTimer' | 'firstEventTimer' | 'idleTimer'): void {
    const timer = this[name];
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    this[name] = undefined;
  }
}
