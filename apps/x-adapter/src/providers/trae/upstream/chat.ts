import { randomUUID } from 'node:crypto';
import { resolveTraeSession } from '../auth/oauth.js';
import { TraeSession } from '../auth/credential.js';
import { intEnv } from '../config/env.js';
import { TraeFunction } from '../config/realm.js';
import {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResult,
  CanonicalStreamEvent,
  upstreamCacheUsage,
  withoutToolOutputAttachment,
} from '../../../protocol/canonical.js';
import {
  ToolNameMapper,
  applyToolChoice,
  canonicalToolsToTrae,
  mergeToolCallDeltas,
  normalizeToolCallChunks,
} from '../../../protocol/tools.js';
import { getModelCatalog, resolveModel } from '../models/catalog.js';
import { streamTraeSoloWorkChat } from './solo-work-chat.js';
import { FetchLike, TraeModelConfig, traeChatUrl, upstreamHeaders } from './trae-client.js';
import { jsonFromSseData, parseSseStream, parseSseText } from './sse.js';
import { TraeChatWatchdog, traeChatTimeouts } from './watchdog.js';

function traeMessages(messages: CanonicalMessage[], mapper: ToolNameMapper): unknown[] {
  return messages.map((message) => {
    const cleanMessage = withoutToolOutputAttachment(message);
    const base: Record<string, unknown> = { role: cleanMessage.role, content: cleanMessage.content };
    if (message.name) {
      base.name = mapper.toUpstream(message.name);
    }
    if (message.tool_call_id) {
      base.tool_call_id = message.tool_call_id;
    }
    if (message.tool_calls?.length) {
      base.tool_calls = message.tool_calls.map((toolCall, index) => ({
        index,
        id: toolCall.id,
        type: 'function',
        function_call: {
          name: mapper.toUpstream(toolCall.function.name),
          arguments: toolCall.function.arguments,
        },
      }));
    }
    return base;
  });
}

export async function buildTraeBody(
  session: TraeSession,
  request: CanonicalRequest,
  fn: TraeFunction,
  fetchImpl: FetchLike = fetch,
): Promise<{ model: TraeModelConfig; body: Record<string, unknown>; mapper: ToolNameMapper }> {
  const catalog = await getModelCatalog(session, fetchImpl);
  const model = resolveModel(catalog, request.model);
  if (!model.metadata.functions.includes(fn)) {
    const error = new Error(`Trae model ${request.model} was not discovered for function ${fn}.`);
    (error as NodeJS.ErrnoException).code = 'trae_function_mismatch';
    throw error;
  }
  const mapper = new ToolNameMapper();
  const body: Record<string, unknown> = {
    messages: traeMessages(request.messages, mapper),
    function: fn,
    config_name: model.metadata.config_name,
    model: model.metadata.config_name,
    model_name: model.metadata.model_name,
    stream: true,
    request_id: randomUUID(),
    session_id: request.session_id || request.previous_response_id || randomUUID(),
    max_tokens: request.max_tokens ?? model.metadata.max_tokens ?? 32768,
    parallel_tool_calls: true,
  };
  if (request.reasoning_effort) {
    body.reasoning_effort = request.reasoning_effort;
  }
  const tools = canonicalToolsToTrae(applyToolChoice(request.tools, request.tool_choice), mapper);
  if (tools) {
    body.tools = tools;
    if (request.tool_choice) {
      body.tool_choice = mapper.mapToolChoice(request.tool_choice);
    }
  }
  return { model, body, mapper };
}

export function resultFromSseText(text: string, model: string): CanonicalResult {
  let output = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const toolChunks: unknown[] = [];
  let sawDone = false;
  for (const event of parseSseText(text)) {
    const payload = jsonFromSseData(event.data);
    if (normalizedEvent(event.event, payload) === 'output') {
      const outputError = embeddedOutputError(payload);
      if (outputError) {
        throw outputError;
      }
      if (typeof payload.response === 'string') {
        output += payload.response;
      }
      if (!payload.response && typeof payload.reasoning_content === 'string') {
        reasoning += payload.reasoning_content;
      }
      if (payload.tool_calls !== undefined) {
        toolChunks.push(payload.tool_calls);
      }
    } else if (normalizedEvent(event.event, payload) === 'error') {
      throw sseError(payload);
    } else if (normalizedEvent(event.event, payload) === 'token_usage') {
      usage = usageFrom(payload);
    } else if (normalizedEvent(event.event, payload) === 'done') {
      sawDone = true;
      finishReason = typeof payload.finish_reason === 'string' ? payload.finish_reason : finishReason;
    }
  }
  if (!sawDone) {
    throw incompleteStreamError('Trae');
  }
  return {
    model,
    text: output,
    reasoning,
    tool_calls: mergeToolCallDeltas(toolChunks),
    finish_reason: finishReason,
    usage,
  };
}

export function eventToCanonical(
  event: string,
  payload: Record<string, unknown>,
  model: string,
  mapper = new ToolNameMapper(),
): CanonicalStreamEvent | null {
  const name = normalizedEvent(event, payload);
  if (name === 'output') {
    const outputError = embeddedOutputError(payload);
    if (outputError) {
      throw outputError;
    }
    if (typeof payload.response === 'string' && payload.response) {
      return { type: 'text', delta: payload.response };
    }
    if (typeof payload.reasoning_content === 'string' && payload.reasoning_content) {
      return { type: 'reasoning', delta: payload.reasoning_content };
    }
    if (payload.tool_calls !== undefined) {
      return {
        type: 'tool_call_delta',
        tool_calls: mapper.restoreToolCalls(normalizeToolCallChunks(payload.tool_calls)),
      };
    }
    return null;
  }
  if (name === 'token_usage') {
    return { type: 'usage', usage: usageFrom(payload) };
  }
  if (name === 'done') {
    return { type: 'done', finish_reason: typeof payload.finish_reason === 'string' ? payload.finish_reason : 'stop' };
  }
  if (name === 'progress_notice' || name === 'metadata' || name === 'timing_cost' || name === 'request_wait_in_queue') {
    return { type: 'progress', event: name, data: payload };
  }
  if (name === 'error') {
    throw sseError(payload);
  }
  return { type: 'progress', event: name || event, data: { ...payload, model } };
}

type UpstreamChatError = Error & { code?: string; status?: number; businessCode?: string };

const DEFAULT_CHAT_MAX_OUTPUT_BYTES = 1_048_576;

export type TraeChatOutputLimits = {
  maxOutputEvents: number;
  maxOutputBytes: number;
};

/**
 * `llm_utils_chat` does not reliably enforce request-level `max_tokens`.
 * Treat that value as a conservative ceiling on content delta events, not as
 * a token counter, and retain an independent serialized-output byte cap.
 */
export function traeChatOutputLimits(upstreamMaxTokens: number): TraeChatOutputLimits {
  const requestEventLimit =
    Number.isSafeInteger(upstreamMaxTokens) && upstreamMaxTokens > 0 ? upstreamMaxTokens : Number.MAX_SAFE_INTEGER;
  const configuredEventLimit = intEnv('X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS', 0);
  const configuredByteLimit = intEnv('X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES', DEFAULT_CHAT_MAX_OUTPUT_BYTES);
  return {
    maxOutputEvents: configuredEventLimit > 0 ? Math.min(requestEventLimit, configuredEventLimit) : requestEventLimit,
    maxOutputBytes: configuredByteLimit > 0 ? configuredByteLimit : DEFAULT_CHAT_MAX_OUTPUT_BYTES,
  };
}

export async function* streamTraeChat(
  session: TraeSession,
  request: CanonicalRequest,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalStreamEvent> {
  const catalog = await getModelCatalog(session, fetchImpl);
  const selected = resolveModel(catalog, request.model);
  if (selected.metadata.realm !== session.realm) {
    const error = new Error(`Trae model ${request.model} does not belong to the ${session.realm} realm.`);
    (error as NodeJS.ErrnoException).code = 'model_realm_mismatch';
    throw error;
  }
  let authRetried = false;
  let activeSession = session;
  let lastError: unknown;
  for (let functionIndex = 0; functionIndex < selected.metadata.functions.length; functionIndex += 1) {
    const fn = selected.metadata.functions[functionIndex];
    try {
      if (fn === 'solo_agent_remote') {
        yield* streamTraeSoloWorkChat(activeSession, request, fetchImpl, signal);
      } else {
        yield* streamFunction(activeSession, request, fn, fetchImpl, signal);
      }
      return;
    } catch (error) {
      lastError = error;
      if (isAuthRejection(error) && !authRetried) {
        authRetried = true;
        const refreshed = await resolveTraeSession(session.realm, { fetchImpl, forceRefresh: true });
        if (!refreshed) {
          throw error;
        }
        activeSession = refreshed;
        functionIndex -= 1;
        continue;
      }
      if (isFunctionMismatch(error) && functionIndex + 1 < selected.metadata.functions.length) {
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Trae did not accept any discovered model function.');
}

async function* streamFunction(
  session: TraeSession,
  request: CanonicalRequest,
  fn: TraeFunction,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalStreamEvent> {
  const { model, body, mapper } = await buildTraeBody(session, request, fn, fetchImpl);
  const watchdog = new TraeChatWatchdog(signal, traeChatTimeouts());
  const outputLimits = traeChatOutputLimits(Number(body.max_tokens));
  let outputEvents = 0;
  let outputBytes = 0;
  let started = false;
  try {
    // Chat POST is deliberately not wrapped in generic retries. A network
    // failure can occur after the provider accepted the generation request.
    const response = await fetchImpl(traeChatUrl(session), {
      method: 'POST',
      headers: upstreamHeaders(session),
      body: JSON.stringify(body),
      signal: watchdog.signal,
    });
    if (!response.ok) {
      const payload = await boundedError(response);
      throw upstreamChatError(response.status, payload);
    }
    if (!response.body) {
      const error = new Error('Trae llm_utils_chat returned an empty response body.');
      (error as NodeJS.ErrnoException).code = 'upstream_invalid_response';
      throw error;
    }
    let completed = false;
    let limitFinishPending = false;
    for await (const sse of parseSseStream(response.body)) {
      watchdog.noteUpstreamSseEvent();
      let event = eventToCanonical(sse.event, jsonFromSseData(sse.data), model.id, mapper);
      if (event?.type === 'text' || event?.type === 'reasoning' || event?.type === 'tool_call_delta') {
        if (outputEvents >= outputLimits.maxOutputEvents) {
          limitFinishPending = true;
          break;
        }
        const remainingBytes = outputLimits.maxOutputBytes - outputBytes;
        const eventBytes = canonicalOutputEventBytes(event);
        if (eventBytes > remainingBytes) {
          if (event.type === 'text' || event.type === 'reasoning') {
            const delta = utf8Prefix(event.delta, Math.max(0, remainingBytes));
            if (delta) {
              event = { ...event, delta };
              outputEvents += 1;
              outputBytes += Buffer.byteLength(delta, 'utf8');
              if (!started) {
                yield { type: 'start', model: model.id };
                started = true;
              }
              yield event;
            }
          }
          limitFinishPending = true;
          break;
        }
        outputEvents += 1;
        outputBytes += eventBytes;
      }
      if (event && !started) {
        yield { type: 'start', model: model.id };
        started = true;
      }
      if (event) {
        yield event;
      }
      if (event?.type === 'done') {
        completed = true;
        break;
      }
    }
    if (limitFinishPending) {
      watchdog.cancelUpstreamForOutputLimit();
      if (!started) {
        yield { type: 'start', model: model.id };
      }
      yield { type: 'done', finish_reason: 'length' };
      completed = true;
    }
    if (!completed) {
      throw incompleteStreamError('Trae');
    }
  } catch (error) {
    const failure = watchdog.error ?? error;
    if (started && (isAuthRejection(failure) || isFunctionMismatch(failure))) {
      (failure as NodeJS.ErrnoException).code = 'upstream_stream_failed';
    }
    throw failure;
  } finally {
    watchdog.dispose();
  }
}

function canonicalOutputEventBytes(
  event: Extract<CanonicalStreamEvent, { type: 'text' | 'reasoning' | 'tool_call_delta' }>,
): number {
  return event.type === 'tool_call_delta'
    ? Buffer.byteLength(JSON.stringify(event.tool_calls), 'utf8')
    : Buffer.byteLength(event.delta, 'utf8');
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return text;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = Math.min(bytes.length, maxBytes); end > Math.max(0, maxBytes - 4); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // Back off to the preceding complete UTF-8 code point.
    }
  }
  return '';
}

function incompleteStreamError(provider: string): Error {
  const error = new Error(`${provider} upstream stream ended without a terminal event.`);
  (error as NodeJS.ErrnoException).code = 'upstream_stream_truncated';
  return error;
}

export async function runTraeChat(
  session: TraeSession,
  request: CanonicalRequest,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<CanonicalResult> {
  let model = request.model;
  let text = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const toolChunks: unknown[] = [];
  for await (const event of streamTraeChat(session, request, fetchImpl, signal)) {
    if (event.type === 'start') {
      model = event.model;
    } else if (event.type === 'text') {
      text += event.delta;
    } else if (event.type === 'reasoning') {
      reasoning += event.delta;
    } else if (event.type === 'tool_call_delta') {
      toolChunks.push(event.tool_calls);
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'done') {
      finishReason = event.finish_reason;
    }
  }
  return { model, text, reasoning, tool_calls: mergeToolCallDeltas(toolChunks), finish_reason: finishReason, usage };
}

function normalizedEvent(event: string, payload: Record<string, unknown>): string {
  return String(event || payload.event || payload.type || 'message')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_|_$/g, '');
}

function usageFrom(payload: Record<string, unknown>) {
  const input = Number(payload.prompt_tokens ?? payload.input_tokens ?? 0);
  const output = Number(payload.completion_tokens ?? payload.output_tokens ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(payload.total_tokens ?? input + output),
    ...upstreamCacheUsage(payload),
  };
}

function sseError(payload: Record<string, unknown>): Error {
  const nested =
    payload.error && typeof payload.error === 'object' ? (payload.error as Record<string, unknown>) : payload;
  const error = new Error(
    typeof nested.message === 'string'
      ? nested.message
      : typeof payload.error === 'string'
        ? payload.error
        : 'Trae upstream error',
  ) as UpstreamChatError;
  error.businessCode = String(nested.code ?? payload.code ?? '');
  error.code = isWrongFunctionError(error.businessCode, error.message)
    ? 'trae_function_mismatch'
    : 'upstream_sse_error';
  return error;
}

function embeddedOutputError(payload: Record<string, unknown>): Error | undefined {
  const code = String(payload.code ?? '');
  const message =
    typeof payload.message === 'string' ? payload.message : typeof payload.error === 'string' ? payload.error : '';
  if (!code && !message) {
    return undefined;
  }
  return sseError(payload);
}

async function boundedError(response: Response): Promise<{ code: string; message: string }> {
  const text = (await response.text()).slice(0, 2048);
  try {
    const root = JSON.parse(text) as Record<string, unknown>;
    const nested = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : root;
    return {
      code: String(nested.code ?? root.code ?? ''),
      message: String(nested.message ?? root.message ?? '').slice(0, 300),
    };
  } catch {
    return { code: '', message: '' };
  }
}

function upstreamChatError(status: number, payload: { code: string; message: string }): UpstreamChatError {
  const error = new Error(
    `Trae llm_utils_chat returned HTTP ${status}${payload.message ? `: ${payload.message}` : ''}.`,
  ) as UpstreamChatError;
  error.status = status;
  error.businessCode = payload.code;
  error.code =
    status === 401 || status === 403
      ? 'trae_auth_rejected'
      : status === 400 && isWrongFunctionError(payload.code, payload.message)
        ? 'trae_function_mismatch'
        : 'upstream_http_error';
  return error;
}

function isWrongFunctionError(code: string | undefined, message: string | undefined): boolean {
  const normalizedCode = String(code ?? '');
  if (!['4001', '4023'].includes(normalizedCode)) {
    return false;
  }
  return /function|function[_ -]?type|agent|mode|not (found|support)|unsupported/i.test(message ?? '');
}

function isAuthRejection(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'trae_auth_rejected';
}

function isFunctionMismatch(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'trae_function_mismatch';
}
