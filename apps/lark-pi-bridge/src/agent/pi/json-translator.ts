import { log } from '../../core/logger.js';
import type { AgentEvent } from '../types.js';

export type PiFinishReason = 'failed' | 'interrupted' | 'timeout';
export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

const IGNORED_EVENTS = new Set([
  'agent_start',
  'turn_start',
  'turn_end',
  'message_start',
  'queue_update',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'tool_execution_update',
  'session_info_changed',
  'thinking_level_changed',
  'entry_appended',
  'bash_execution_update',
]);
const IGNORED_ASSISTANT_EVENTS = new Set([
  'start',
  'text_start',
  'text_end',
  'thinking_start',
  'thinking_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  'error',
]);

/**
 * `agent_end` is deliberately non-terminal. Pi emits it for each agent pass;
 * automatic retry/continuation can follow. Normal completion is emitted only
 * for `agent_settled`. The adapter preflight confirms that boundary against
 * the selected Pi binary with an isolated loopback capability probe.
 */
export class PiJsonTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private messageFailure: { message: string; terminationReason: 'failed' | 'interrupted' } | undefined;
  private toolOutputs = new Map<string, BoundedToolOutput>();
  private drift: ProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  /** RPC mode obtains the session id from get_state instead of a stream header. */
  primeSession(sessionId: string): void {
    if (!sessionId || this.sessionId) {
      throw this.sequenceError('duplicate-or-empty-primed-session');
    }
    this.sessionId = sessionId;
  }

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal) {
      throw new PiProtocolSequenceError('Pi emitted an event after the terminal boundary');
    }
    const event = record(raw);
    if (!event || typeof event.type !== 'string') {
      throw this.sequenceError('non-object-event');
    }
    if (event.type !== 'session' && !this.sessionId) {
      throw this.sequenceError(`${event.type}-before-session`);
    }
    switch (event.type) {
      case 'session':
        return this.session(event);
      case 'message_update':
        return this.messageUpdate(event);
      case 'tool_execution_start':
        return this.toolStart(event);
      case 'tool_execution_update':
        return this.toolUpdate(event);
      case 'tool_execution_end':
        return this.toolEnd(event);
      case 'message_end':
        return this.messageEnd(event);
      case 'agent_end':
        return [];
      case 'agent_settled':
        return this.done();
      case 'extension_error':
        log.warn('pi-json', 'extension-error', { message: truncate(string(event.error) ?? '', 500) });
        return [];
      default:
        if (IGNORED_EVENTS.has(event.type)) {
          return [];
        }
        return this.unknown(event.type);
    }
  }

  finish(reason: PiFinishReason = 'failed'): AgentEvent[] {
    if (this.terminal) {
      return [];
    }
    if (reason === 'interrupted' || reason === 'timeout') {
      this.terminal = true;
      return [{ type: 'done', sessionId: this.sessionId, terminationReason: reason }];
    }
    this.terminal = true;
    if (this.messageFailure) {
      return [{ type: 'error', ...this.messageFailure }];
    }
    return [
      {
        type: 'error',
        message: 'Pi stream ended before the required agent_settled completion boundary',
        terminationReason: 'failed',
      },
    ];
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }
  terminalEmitted(): boolean {
    return this.terminal;
  }

  private done(): AgentEvent[] {
    if (this.toolOutputs.size > 0) {
      throw this.sequenceError('agent-settled-with-active-tool');
    }
    if (this.messageFailure) {
      this.terminal = true;
      return [{ type: 'error', ...this.messageFailure }];
    }
    if (!this.sessionId) {
      throw this.sequenceError('agent-settled-before-session');
    }
    this.terminal = true;
    return [{ type: 'done', sessionId: this.sessionId, terminationReason: 'normal' }];
  }
  private session(raw: Record<string, unknown>): AgentEvent[] {
    const id = string(raw.id);
    if (!id) {
      throw this.sequenceError('session-without-id');
    }
    if (this.sessionId) {
      throw this.sequenceError('duplicate-session');
    }
    this.sessionId = id;
    return [{ type: 'system', sessionId: id, cwd: string(raw.cwd) }];
  }
  private messageUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const event = record(raw.assistantMessageEvent);
    if (!event || typeof event.type !== 'string') {
      throw this.sequenceError('message-update-without-assistant-event');
    }
    if (event.type === 'text_delta') {
      return string(event.delta) ? [{ type: 'text', delta: string(event.delta)! }] : [];
    }
    if (event.type === 'thinking_delta') {
      return string(event.delta) ? [{ type: 'thinking', delta: string(event.delta)! }] : [];
    }
    return IGNORED_ASSISTANT_EVENTS.has(event.type) ? [] : this.unknown(`message_update.${event.type}`);
  }
  private toolStart(raw: Record<string, unknown>): AgentEvent[] {
    const id = string(raw.toolCallId),
      name = string(raw.toolName);
    if (!id || !name) {
      throw this.sequenceError('tool-start-without-id-or-name');
    }
    if (this.toolOutputs.has(id)) {
      throw this.sequenceError('duplicate-tool-start');
    }
    this.toolOutputs.set(id, new BoundedToolOutput());
    return [{ type: 'tool_use', id, name, input: raw.args }];
  }
  private toolUpdate(raw: Record<string, unknown>): AgentEvent[] {
    const id = string(raw.toolCallId);
    if (!id) {
      throw this.sequenceError('tool-update-without-id');
    }
    const output = this.toolOutputs.get(id);
    if (!output) {
      throw this.sequenceError('tool-update-before-start');
    }
    output.replace(toolText(record(raw.partialResult)) || string(raw.output) || '');
    return [];
  }
  private toolEnd(raw: Record<string, unknown>): AgentEvent[] {
    const id = string(raw.toolCallId);
    if (!id) {
      throw this.sequenceError('tool-end-without-id');
    }
    const output = this.toolOutputs.get(id);
    if (!output) {
      throw this.sequenceError('tool-end-before-start');
    }
    output.replace(toolText(record(raw.result)));
    this.toolOutputs.delete(id);
    return [{ type: 'tool_result', id, output: output.text(), isError: raw.isError === true }];
  }
  private messageEnd(raw: Record<string, unknown>): AgentEvent[] {
    const message = record(raw.message);
    if (!message || message.role !== 'assistant') {
      return [];
    }
    const stopReason = string(message.stopReason);
    if (stopReason === 'error' || stopReason === 'aborted') {
      // Pi may emit message_end(error) before an automatic retry. Preserve the
      // error and terminalize only if the process subsequently settles/exits.
      this.messageFailure = {
        message: truncate(string(message.errorMessage) ?? `Pi request ${stopReason}`, 4096),
        terminationReason: stopReason === 'aborted' ? 'interrupted' : 'failed',
      };
      return [];
    }
    this.messageFailure = undefined;
    const usage = record(message.usage) ?? record(raw.usage);
    if (!usage) {
      return [];
    }
    const cost = record(usage.cost);
    return [
      {
        type: 'usage',
        inputTokens: number(usage.input),
        outputTokens: number(usage.output),
        cachedInputTokens: number(usage.cacheRead),
        reasoningOutputTokens: number(usage.reasoning),
        costUsd: number(cost?.total),
      },
    ];
  }
  private unknown(eventType: string): never {
    this.drift.unknownEvents++;
    log.warn('pi-json', 'protocol-drift-unknown-event', { eventType });
    throw new PiProtocolSequenceError(`Unknown Pi JSON protocol event: ${eventType}`);
  }
  private anomaly(reason: string): AgentEvent[] {
    this.drift.anomalies++;
    log.warn('pi-json', 'protocol-drift-anomaly', { reason });
    return [];
  }
  private sequenceError(reason: string): PiProtocolSequenceError {
    this.anomaly(reason);
    return new PiProtocolSequenceError(`Invalid Pi JSON protocol sequence: ${reason}`);
  }
}

export class PiProtocolSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiProtocolSequenceError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function toolText(result: Record<string, unknown> | undefined): string {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return '';
  }
  return truncate(
    content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          Boolean(record(block)) &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text)
      .join(''),
    16_384,
  );
}
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

class BoundedToolOutput {
  private value = '';
  replace(value: string): void {
    this.value = truncate(value, 16_384);
  }
  text(): string {
    return this.value;
  }
}
