import { randomUUID } from 'node:crypto';
import { TraeSession } from '../auth/credential.js';
import { resolveSoloToken } from '../auth/solo-token.js';
import {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResult,
  CanonicalStreamEvent,
  CanonicalTool,
} from '../../../protocol/canonical.js';
import { resolveModel, getModelCatalog } from '../models/catalog.js';
import { TraeChatWatchdog, traeChatTimeouts } from './watchdog.js';
import { parseSseStream, jsonFromSseData } from './sse.js';
import type { FetchLike } from './solo-client.js';
import { ToolCallStreamParser, renderToolsSystemPrompt, toolTranscriptFromMessages } from './solo-prompt-tools.js';

/**
 * Trae SOLO work-tier chat adapter (`llm_utils_chat` + `solo_work_lite`).
 *
 * The work pool is reachable only with a SOLO-identity token (OAuth client
 * `en1oxy7wnw8j9n`); IDE tokens are rejected with 4120. The upstream call is
 * camouflaged as the TRAE SOLO desktop client (device brand 83DG / Windows /
 * ide 3.5.51) and the request body is minimal — extra fields such as
 * `agent_type` or `device_id` make the gateway answer 4023 "model is unknown".
 * Tools have no native transport on this pool, so the canonical tool catalog
 * is injected as a prompt protocol and `<toolcall>` blocks in the model text
 * are parsed back into canonical tool-call events.
 */

const SOLO_WORK_FUNCTION = 'solo_work_lite';
const SOLO_IDE_VERSION = '3.5.51';
const SOLO_IDE_VERSION_CODE = '20260910';

export type SoloWorkAuth = { token: string; deviceId: string; uid: string };

function unsupportedTools(message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = 'unsupported_tools';
  return error;
}

function requiresToolCall(request: CanonicalRequest): boolean {
  return (
    request.tool_choice === 'required' || (request.tool_choice !== undefined && typeof request.tool_choice === 'object')
  );
}

/** Prompt-simulated tool policy: transcripts continue as text; forced tool selection stays unsupported. */
export function prepareSoloWorkRequest(request: CanonicalRequest): CanonicalRequest {
  if (requiresToolCall(request)) {
    throw unsupportedTools('Trae SOLO work does not support required or explicitly selected tool calls.');
  }
  return request;
}

export function soloWorkHeaders(auth: SoloWorkAuth, requestId: string): Record<string, string> {
  const traceId = randomUUID().replace(/-/g, '');
  return {
    'content-type': 'application/json',
    authorization: `Cloud-IDE-JWT ${auth.token}`,
    'x-cloudide-token': auth.token,
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-app-version': 'default',
    'x-ide-version-code': SOLO_IDE_VERSION_CODE,
    'x-app-version-code': SOLO_IDE_VERSION_CODE,
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'x-device-brand': '83DG',
    'x-device-cpu': 'Intel',
    'x-device-id': auth.deviceId,
    'x-machine-id': '',
    'x-os-version': 'Windows 11 Pro',
    'x-device-type': 'windows',
    'x-ide-version': SOLO_IDE_VERSION,
    'x-ide-version-type': 'stable',
    'request-traffic-type': 'prod',
    'x-uid': auth.uid,
    accept: 'text/event-stream',
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
  };
}

/**
 * Build the `llm_utils_chat` body for the work pool. Messages flatten into
 * text-block arrays: the tool protocol is injected into the leading system
 * turn and tool-call history renders as `<toolcall>` / `<tool_result>` text.
 */
export function buildSoloWorkBody(
  configName: string,
  messages: CanonicalMessage[],
  tools: CanonicalTool[] | undefined,
): Record<string, unknown> {
  const directive = tools?.length ? renderToolsSystemPrompt(tools) : '';
  const prepared = directive ? prependSystemDirective(messages, directive) : stripToolHistory(messages);
  const traeMessages = prepared.map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }));
  return {
    messages: traeMessages,
    function: SOLO_WORK_FUNCTION,
    stream: true,
    config_name: configName,
    model: configName,
  };
}

function prependSystemDirective(messages: CanonicalMessage[], directive: string): { role: string; content: string }[] {
  const transcript = toolTranscriptFromMessages(messages);
  const merged = transcript ? `${directive}\n\n${transcript}` : directive;
  return [{ role: 'system', content: merged }];
}

function stripToolHistory(messages: CanonicalMessage[]): { role: string; content: string }[] {
  const transcript = toolTranscriptFromMessages(messages);
  if (!transcript) {
    return [{ role: 'user', content: '' }];
  }
  return [{ role: 'user', content: transcript }];
}

async function resolveSoloWorkAuth(
  session: TraeSession,
  fetchImpl: FetchLike,
  forceRefresh = false,
): Promise<SoloWorkAuth> {
  const record = await resolveSoloToken(session.realm, fetchImpl, forceRefresh);
  if (!record) {
    const error = new Error(
      'Trae SOLO work requires a SOLO-identity token. Complete a SOLO OAuth login (client en1oxy7wnw8j9n) and store it at the solo-token path first.',
    );
    (error as NodeJS.ErrnoException).code = 'missing_solo_token';
    throw error;
  }
  return { token: record.token, deviceId: record.deviceId ?? '', uid: session.uid ?? '' };
}

export async function* streamTraeSoloWorkChat(
  session: TraeSession,
  request: CanonicalRequest,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalStreamEvent> {
  const prepared = prepareSoloWorkRequest(request);
  const catalog = await getModelCatalog(session, fetchImpl);
  const selected = resolveModel(catalog, prepared.model);
  if (!selected.metadata.functions.includes('solo_agent_remote')) {
    const error = new Error(`Trae model ${prepared.model} was not discovered for the SOLO work function.`);
    (error as NodeJS.ErrnoException).code = 'trae_function_mismatch';
    throw error;
  }
  if (selected.metadata.realm !== session.realm) {
    const error = new Error(`Trae model ${prepared.model} does not belong to the ${session.realm} realm.`);
    (error as NodeJS.ErrnoException).code = 'model_realm_mismatch';
    throw error;
  }
  const auth = await resolveSoloWorkAuth(session, fetchImpl);
  const requestId = randomUUID();
  const body = buildSoloWorkBody(selected.metadata.config_name, prepared.messages, prepared.tools);

  const watchdog = new TraeChatWatchdog(signal, traeChatTimeouts());
  const parser = new ToolCallStreamParser();
  let started = false;
  const emit = function* (event: CanonicalStreamEvent): Generator<CanonicalStreamEvent> {
    if (!started && (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_call_delta')) {
      started = true;
      yield { type: 'start', model: selected.id };
    }
    if (event.type === 'text') {
      for (const parsed of parser.push(event.delta)) {
        if (parsed.type === 'text') {
          yield { type: 'text', delta: parsed.delta };
        } else {
          yield { type: 'tool_call_delta', tool_calls: parsed.tool_calls };
        }
      }
      return;
    }
    yield event;
  };
  const flushParser = function* (): Generator<CanonicalStreamEvent> {
    for (const parsed of parser.flush()) {
      if (parsed.type === 'text') {
        yield { type: 'text', delta: parsed.delta };
      } else {
        yield { type: 'tool_call_delta', tool_calls: parsed.tool_calls };
      }
    }
  };

  try {
    const response = await fetchImpl(`${session.dataBaseUrl}/api/agent/v3/llm_utils_chat`, {
      method: 'POST',
      headers: soloWorkHeaders(auth, requestId),
      body: JSON.stringify(body),
      signal: watchdog.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await boundedText(response);
      throw soloWorkHttpError(response.status, detail);
    }
    for await (const sse of parseSseStream(response.body)) {
      watchdog.noteUpstreamSseEvent();
      const payload = jsonFromSseData(sse.data);
      const name = normalizedEvent(sse.event, payload);
      if (name === 'output') {
        const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
        const text = typeof record.response === 'string' ? record.response : '';
        const reasoning = typeof record.reasoning_content === 'string' ? record.reasoning_content : '';
        if (reasoning) {
          yield* emit({ type: 'reasoning', delta: reasoning });
        }
        if (text) {
          yield* emit({ type: 'text', delta: text });
        }
      } else if (name === 'token_usage') {
        yield* emit({ type: 'usage', usage: usageFrom(payload as Record<string, unknown>) });
      } else if (name === 'done') {
        yield* flushParser();
        const finishReason = parser.toolCalls.length ? 'tool_calls' : 'stop';
        yield { type: 'done', finish_reason: finishReason };
        return;
      } else if (name === 'error') {
        throw soloWorkStreamError(payload as Record<string, unknown>);
      }
    }
    yield* flushParser();
    yield { type: 'done', finish_reason: parser.toolCalls.length ? 'tool_calls' : 'stop' };
  } finally {
    watchdog.dispose();
  }
}

export async function runTraeSoloWorkChat(
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
  const toolCalls: CanonicalResult['tool_calls'] = [];
  for await (const event of streamTraeSoloWorkChat(session, request, fetchImpl, signal)) {
    if (event.type === 'start') {
      model = event.model;
    } else if (event.type === 'text') {
      text += event.delta;
    } else if (event.type === 'reasoning') {
      reasoning += event.delta;
    } else if (event.type === 'tool_call_delta') {
      toolCalls.push(...event.tool_calls);
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'done') {
      finishReason = event.finish_reason;
    }
  }
  return { model, text, reasoning, tool_calls: toolCalls, finish_reason: finishReason, usage };
}

function normalizedEvent(event: string, payload: unknown): string {
  const source = String(
    event || (payload as Record<string, unknown>)?.event || (payload as Record<string, unknown>)?.type || 'message',
  );
  return source
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
  };
}

function soloWorkStreamError(payload: Record<string, unknown>): Error {
  const nested =
    payload.error && typeof payload.error === 'object' ? (payload.error as Record<string, unknown>) : payload;
  const code = nested.code;
  const message =
    typeof nested.message === 'string' && nested.message ? nested.message : 'Trae SOLO work stream failed.';
  const error = new Error(`Trae SOLO work error ${code ?? 'unknown'}: ${message}`);
  (error as NodeJS.ErrnoException).code = 'upstream_response_error';
  (error as { businessCode?: unknown }).businessCode = code;
  return error;
}

function soloWorkHttpError(status: number, detail: string): Error {
  const error = new Error(`Trae SOLO work chat returned HTTP ${status}.${detail ? ` ${detail}` : ''}`);
  (error as NodeJS.ErrnoException).code =
    status === 401 || status === 403 ? 'trae_auth_rejected' : 'upstream_http_error';
  return error;
}

async function boundedText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}
