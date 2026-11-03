import http2 from 'node:http2';
import os from 'node:os';
import { randomInt, randomUUID } from 'node:crypto';
import { Ajv2020, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import {
  CanonicalRequest,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalToolChoice,
} from '../../../protocol/canonical.js';
import { DoubaoCredential } from '../auth/doubao-cookie.js';
import { boolEnv, doubaoTimeoutSignal, intEnv } from '../config/env.js';
import { FetchLike, doubaoHeaders, doubaoHttpError, doubaoUrl, jsonResponse } from './client.js';
import { parseSseStream } from './sse.js';

const BRIDGE_NAME = 'X Adapter Bridge';
const CONNECTOR_PREFIX = 'mcp__x_adapter_bridge__';
const WAIT_TOOL_NAME = 'x_adapter_wait';
const TOOL_STREAM_HEARTBEAT_MS = 15_000;
const TOOL_STREAM_RECONNECT_MS = 1_000;
const TOOL_STREAM_MAX_ATTEMPTS = 3;
const BUILTIN_TOOL_NAMES = new Set([
  'Bash',
  'TaskOutput',
  'TaskStop',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'FileBatchUpload',
]);
const BUILTIN_IGNORED_ARGUMENTS: Record<string, string[]> = {
  Read: ['thumbnail_size'],
  Bash: ['sandbox_permissions', 'justification'],
};
const WAIT_TOOL = {
  name: WAIT_TOOL_NAME,
  description:
    'Only call this after a client tool result says it is still running. Wait for that operation and return its result.',
  inputSchema: JSON.stringify({ type: 'object', properties: {} }),
};
const schemaValidator = new Ajv2020({
  strictSchema: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allowUnionTypes: true,
});
const addFormats = formatsModule as unknown as (validator: Ajv2020) => void;
addFormats(schemaValidator);
const compiledSchemas = new WeakMap<Record<string, unknown>, ValidateFunction>();

export type DoubaoToolRuntime = {
  deviceId: string;
  deviceName: string;
  sandboxId: string;
  sandboxEnvId: string;
  clientEnvId: string;
  connectorId?: string;
  tools: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  builtin: boolean;
  instructions: string;
  localConnectors: Array<{
    connectorId: string;
    mcpToolsList: Array<{ name: string; description: string; inputSchema: string }>;
  }>;
};

export type DoubaoRemoteToolCall = {
  id: string;
  name: string;
  input: unknown;
  sandboxId: string;
  conversationId?: string;
};

export type DoubaoToolEnvelope = {
  tool_call?: DoubaoRemoteToolCall;
  sandbox_id?: string;
  heartbeat?: unknown;
};

type Connector = { id: string; enabled: boolean };

function providerError(message: string, code = 'doubao_tool_bridge_error', status?: number): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  if (status !== undefined) {
    Object.assign(error, { status });
  }
  return error;
}

function clientTools(request: CanonicalRequest): CanonicalTool[] {
  return (request.tools ?? []).filter((tool) => !tool.hosted);
}

function toolsEnabled(request: CanonicalRequest): boolean {
  return request.tool_choice !== 'none' && clientTools(request).length > 0;
}

function requestedToolName(choice: CanonicalToolChoice | undefined): string | undefined {
  return typeof choice === 'object' ? choice.function.name : undefined;
}

export function assertDoubaoToolRequest(request: CanonicalRequest): void {
  const tools = clientTools(request);
  const selected = requestedToolName(request.tool_choice);
  if (request.tool_choice === 'required' && tools.length === 0) {
    throw providerError('Doubao Work requires at least one client tool when tool_choice is required.', 'invalid_input');
  }
  if (selected && !tools.some((tool) => tool.function.name === selected)) {
    throw providerError(`Doubao Work selected tool is not declared: ${selected}`, 'invalid_input');
  }
  if (toolsEnabled(request)) {
    for (const tool of tools) {
      compileJsonSchema(tool.function.parameters, tool.function.name);
    }
  }
  for (const message of request.messages) {
    if (message.role === 'tool' && !message.tool_call_id) {
      throw providerError('Doubao Work tool results require tool_call_id.', 'invalid_input');
    }
  }
}

export async function createDoubaoToolRuntime(
  credential: DoubaoCredential,
  request: CanonicalRequest,
  fetchImpl: FetchLike = fetch,
): Promise<DoubaoToolRuntime> {
  assertDoubaoToolRequest(request);
  const tools = clientTools(request);
  const enabled = toolsEnabled(request);
  const connectorId = enabled ? (await ensureDoubaoBridge(credential, fetchImpl, false)).id : undefined;
  const deviceId = credential.commonQuery.device_id || credential.commonQuery.tea_uuid || credential.commonQuery.web_id;
  if (enabled && !deviceId) {
    throw providerError(
      'Doubao Work tool bridge requires the browser device id. Run `x-adapter doubao login` again.',
      'invalid_doubao_credentials',
      401,
    );
  }
  const selected = requestedToolName(request.tool_choice);
  const available = selected ? tools.filter((tool) => tool.function.name === selected) : tools;
  const builtin = boolEnv('X_ADAPTER_DOUBAO_BUILTIN_TOOL_BRIDGE', true);
  return {
    deviceId: deviceId || `7${Array.from({ length: 18 }, () => randomInt(10)).join('')}`,
    deviceName: `x-adapter-${os.hostname()}`,
    sandboxId: `sandbox-${randomUUID()}`,
    sandboxEnvId: randomUUID(),
    clientEnvId: randomUUID(),
    connectorId,
    tools,
    toolChoice: request.tool_choice,
    builtin,
    instructions: toolInstructions(available, builtin, request.tool_choice),
    localConnectors:
      connectorId && available.length
        ? [
            {
              connectorId,
              mcpToolsList: [
                ...available.map((tool) => ({
                  name: tool.function.name,
                  description: tool.function.description ?? '',
                  inputSchema: JSON.stringify(tool.function.parameters),
                })),
                WAIT_TOOL,
              ],
            },
          ]
        : [],
  };
}

function toolInstructions(tools: CanonicalTool[], builtin: boolean, choice: CanonicalToolChoice | undefined): string {
  if (!tools.length) {
    return ['# x-adapter tool policy', 'Do not use tools or tool search in this turn. Answer with text only.'].join(
      '\n\n',
    );
  }
  const names = tools.map((tool) => tool.function.name);
  const selected = requestedToolName(choice);
  const choiceText = selected
    ? `You must call the client tool ${selected} before giving the final answer. Do not answer with text only.`
    : choice === 'required'
      ? 'You must call at least one available client tool before giving the final answer. Do not answer with text only.'
      : '';
  const direct = builtin ? names.filter((name) => BUILTIN_TOOL_NAMES.has(name)) : [];
  const directText = direct.length
    ? `These built-in tools can be called directly and will be executed by the client: ${direct.join(', ')}.`
    : 'Do not call Doubao built-in local tools.';
  return [
    '# x-adapter tool policy',
    `Client tools available in this turn: ${names.join(', ')}.`,
    choiceText,
    `Use ${CONNECTOR_PREFIX}<tool-name> for client tools. Load a client tool by searching for its exact name if necessary.`,
    directText,
    'Call one client tool at a time. Wait for its result before calling another client tool.',
    'If a result says the client tool is still running, call the bridge wait tool. Do not repeat an operation that may already have changed state.',
    'If a tool call is rejected by the client or user, report it. Do not retry through another tool or execution location.',
  ].join('\n\n');
}

export function doubaoSystemPrompt(request: CanonicalRequest, runtime: DoubaoToolRuntime): string {
  const system = request.messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .flatMap((message) => message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])))
    .filter(Boolean)
    .join('\n\n');
  return [runtime.instructions, system ? `# Client instructions\n\n${system}` : ''].filter(Boolean).join('\n\n');
}

export function doubaoPromptMessages(request: CanonicalRequest, reusedSession: boolean): string {
  const messages = request.messages.filter((message) => message.role !== 'system' && message.role !== 'developer');
  if (reusedSession) {
    const last = messages.at(-1);
    if (last?.role === 'user') {
      const text = last.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return messages
    .map((message) => {
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      if (message.role === 'tool') {
        return text ? `[tool_result id=${JSON.stringify(message.tool_call_id ?? '')}]\n${text}` : '';
      }
      const calls = (message.tool_calls ?? [])
        .map(
          (call) =>
            `[tool_use id=${JSON.stringify(call.id)} name=${JSON.stringify(call.function.name)}] ${call.function.arguments}`,
        )
        .join('\n');
      return [text, calls].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

export function routeDoubaoToolCall(
  envelope: DoubaoToolEnvelope,
  runtime: DoubaoToolRuntime,
): CanonicalToolCall | { wait: true } {
  const call = envelope.tool_call;
  if (!call || !call.id || !call.name) {
    throw providerError('Doubao Work sent an invalid tool call.', 'upstream_invalid_response');
  }
  const sandboxId = envelope.sandbox_id || call.sandboxId;
  if (sandboxId && sandboxId !== runtime.sandboxId) {
    throw providerError('Doubao Work tool call belongs to a different sandbox.', 'upstream_invalid_response');
  }
  if (call.name === 'connector.call') {
    const input = objectValue(call.input);
    if (input.connector_id !== runtime.connectorId || typeof input.remote_tool_name !== 'string') {
      throw providerError('Doubao Work sent a tool call for an unknown connector.', 'upstream_invalid_response');
    }
    if (input.remote_tool_name === WAIT_TOOL_NAME) {
      return { wait: true };
    }
    const tool = runtime.tools.find((candidate) => candidate.function.name === input.remote_tool_name);
    const argumentsValue = parseConnectorArguments(input);
    validateToolUse(tool, argumentsValue, runtime.toolChoice);
    return canonicalToolCall(call.id, tool!, argumentsValue);
  }
  if (!runtime.builtin || !BUILTIN_TOOL_NAMES.has(call.name)) {
    throw providerError(`Doubao Work requested unavailable built-in tool: ${call.name}`, 'unsupported_tools');
  }
  const tool = runtime.tools.find((candidate) => candidate.function.name === call.name);
  let argumentsValue = parseArguments(call.input);
  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    const ignored = new Set(BUILTIN_IGNORED_ARGUMENTS[call.name] ?? []);
    argumentsValue = Object.fromEntries(
      Object.entries(argumentsValue as Record<string, unknown>).filter(([key]) => !ignored.has(key)),
    );
  }
  validateToolUse(tool, argumentsValue, runtime.toolChoice);
  return canonicalToolCall(call.id, tool!, argumentsValue);
}

function canonicalToolCall(id: string, tool: CanonicalTool, input: unknown): CanonicalToolCall {
  let argumentsText: string;
  if (tool.client_type === 'custom') {
    const object = objectValue(input);
    argumentsText = JSON.stringify({ input: typeof object.input === 'string' ? object.input : String(input ?? '') });
  } else {
    argumentsText = JSON.stringify(input ?? {});
  }
  return {
    id,
    type: 'function',
    client_type: tool.client_type,
    namespace: tool.namespace,
    function: { name: tool.function.name, arguments: argumentsText },
  };
}

function validateToolUse(
  tool: CanonicalTool | undefined,
  input: unknown,
  choice: CanonicalToolChoice | undefined,
): void {
  if (!tool) {
    throw providerError('Doubao Work requested a tool that is not declared in this turn.', 'unsupported_tools');
  }
  const selected = requestedToolName(choice);
  if (choice === 'none' || (selected && selected !== tool.function.name)) {
    throw providerError('Doubao Work requested a tool disallowed by tool_choice.', 'unsupported_tools');
  }
  if (!matchesJsonSchema(tool.function.parameters, input)) {
    throw providerError('Doubao Work tool arguments do not match the client schema.', 'invalid_input');
  }
}

function parseConnectorArguments(input: Record<string, unknown>): unknown {
  if (typeof input.raw_arguments === 'string') {
    try {
      return JSON.parse(input.raw_arguments);
    } catch {
      // Fall through to the already decoded arguments value.
    }
  }
  return parseArguments(input.arguments);
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function matchesJsonSchema(schema: Record<string, unknown>, value: unknown): boolean {
  return compileJsonSchema(schema)(value) as boolean;
}

function compileJsonSchema(schema: Record<string, unknown>, toolName?: string): ValidateFunction {
  const cached = compiledSchemas.get(schema);
  if (cached) {
    return cached;
  }
  try {
    const validate = schemaValidator.compile(schema);
    if ('$async' in validate && validate.$async === true) {
      throw providerError('Asynchronous JSON Schema validation is not supported.', 'invalid_input');
    }
    compiledSchemas.set(schema, validate);
    return validate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'invalid_input') {
      throw error;
    }
    const detail = schemaCompileError(error);
    const subject = toolName ? ` for tool ${toolName}` : '';
    throw providerError(`Doubao Work cannot safely validate the client schema${subject}: ${detail}`, 'invalid_input');
  }
}

function schemaCompileError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const errors = (error as { errors?: ErrorObject[] } | undefined)?.errors;
  return errors?.[0]?.message ?? 'invalid or unsupported JSON Schema';
}

export function doubaoRemoteToolResult(
  call: Pick<DoubaoRemoteToolCall, 'id' | 'name' | 'input'>,
  text: string,
  isError = false,
): Record<string, unknown> {
  const content = [{ type: 'text', text }];
  if (call.name === 'connector.call') {
    return {
      id: call.id,
      name: call.name,
      raw_result: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content, isError } }),
      tool_input: typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {}),
    };
  }
  return { id: call.id, name: call.name, content, isError };
}

export async function uploadDoubaoRemoteToolResult(
  credential: DoubaoCredential,
  runtime: Pick<DoubaoToolRuntime, 'deviceId' | 'sandboxId'>,
  call: Pick<DoubaoRemoteToolCall, 'id' | 'name' | 'input'>,
  text: string,
  isError = false,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const request = (): Promise<Response> =>
    fetchImpl(doubaoUrl('/alice/office/tool_local/upload_tool_call_result', credential), {
      method: 'POST',
      headers: doubaoHeaders(credential),
      body: JSON.stringify({
        device_id: runtime.deviceId,
        sandbox_id: runtime.sandboxId,
        tool_result: doubaoRemoteToolResult(call, text, isError),
      }),
      signal: doubaoTimeoutSignal(),
    });
  try {
    await jsonResponse(await request(), 'Doubao tool result upload');
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status);
    if (status === 401 || status === 429) {
      throw error;
    }
    await jsonResponse(await request(), 'Doubao tool result upload retry');
  }
}

export async function* doubaoToolStream(
  credential: DoubaoCredential,
  deviceId: string,
  signal?: AbortSignal,
): AsyncGenerator<DoubaoToolEnvelope> {
  let attempts = 0;
  while (!signal?.aborted) {
    const controller = new AbortController();
    const streamSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    const armHeartbeat = (): void => {
      clearTimeout(heartbeat);
      heartbeat = setTimeout(() => controller.abort(), TOOL_STREAM_HEARTBEAT_MS);
      heartbeat.unref?.();
    };
    try {
      armHeartbeat();
      const response = await postHttp2Sse(
        doubaoUrl('/alice/office/tool_local/chunk_stream', credential),
        doubaoHeaders(credential, { accept: 'text/event-stream' }),
        { device_id: deviceId, client_attrs: {} },
        streamSignal,
      );
      if (!response.ok || !response.body) {
        throw doubaoHttpError(response, 'Doubao tool stream');
      }
      for await (const event of parseSseStream(response.body)) {
        armHeartbeat();
        let payload: unknown;
        try {
          payload = JSON.parse(event.data);
        } catch {
          throw providerError('Doubao tool stream returned invalid JSON.', 'upstream_invalid_response');
        }
        const envelope = doubaoToolEnvelope(payload);
        if (envelope.heartbeat !== undefined) {
          attempts = 0;
        }
        yield envelope;
      }
      throw providerError('Doubao tool stream ended before cancellation.', 'upstream_stream_truncated');
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      attempts += 1;
      const status = Number((error as { status?: unknown })?.status);
      if (status === 401 || status === 429 || attempts >= TOOL_STREAM_MAX_ATTEMPTS) {
        throw error;
      }
    } finally {
      clearTimeout(heartbeat);
      controller.abort();
    }
    await abortableDelay(TOOL_STREAM_RECONNECT_MS, signal);
  }
}

function doubaoToolEnvelope(payload: unknown): DoubaoToolEnvelope {
  const item = objectValue(payload);
  const call = objectValue(item.tool_call);
  const option = objectValue(call.option);
  const sandboxId =
    typeof item.sandbox_id === 'string' ? item.sandbox_id : typeof call.sandbox_id === 'string' ? call.sandbox_id : '';
  return {
    heartbeat: item.heartbeat,
    sandbox_id: sandboxId || undefined,
    tool_call:
      typeof call.id === 'string' && typeof call.name === 'string'
        ? {
            id: call.id,
            name: call.name,
            input: call.input,
            sandboxId,
            conversationId: typeof option.conversation_id === 'string' ? option.conversation_id : undefined,
          }
        : undefined,
  };
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function ensureDoubaoBridge(
  credential: DoubaoCredential,
  fetchImpl: FetchLike = fetch,
  create = false,
): Promise<Connector> {
  const existing = await findDoubaoBridge(credential, fetchImpl);
  if (existing) {
    if (!existing.enabled) {
      throw providerError('The X Adapter Bridge connector is disabled in Doubao Work.', 'doubao_bridge_disabled', 409);
    }
    return existing;
  }
  if (!create) {
    throw providerError(
      'Doubao Work is missing the X Adapter Bridge connector. Run `x-adapter doubao login --create-bridge` once.',
      'missing_doubao_bridge',
      409,
    );
  }
  const response = await fetchImpl(doubaoUrl('/alice/office/skills/manage/connector/create_personal', credential), {
    method: 'POST',
    headers: doubaoHeaders(credential),
    body: JSON.stringify({
      name: BRIDGE_NAME,
      mcp_config: { transport_type: 3, stdio_config: { command: '/usr/bin/false', params: [], env: {} } },
    }),
    signal: doubaoTimeoutSignal(),
  });
  const payload = await jsonResponse(response, 'Doubao bridge creation');
  const connector = connectorValue(objectValue(objectValue(payload.data).connector));
  if (!connector) {
    throw providerError('Doubao bridge creation returned an unknown response.', 'upstream_invalid_response');
  }
  return connector;
}

async function findDoubaoBridge(credential: DoubaoCredential, fetchImpl: FetchLike): Promise<Connector | undefined> {
  const response = await fetchImpl(doubaoUrl('/alice/office/skills/manage/connector/list_by_user', credential), {
    method: 'POST',
    headers: doubaoHeaders(credential),
    body: JSON.stringify({ page_size: 100 }),
    signal: doubaoTimeoutSignal(),
  });
  const payload = await jsonResponse(response, 'Doubao connector list');
  const data = objectValue(payload.data);
  const items = Array.isArray(data.items) ? data.items : [];
  const matches = items
    .map((item) => objectValue(item))
    .filter((item) => item.name === BRIDGE_NAME && item.skill_type === 1)
    .flatMap((item) => {
      const connector = connectorValue(item);
      return connector ? [connector] : [];
    });
  if (!matches.length && data.has_more === true) {
    throw providerError('Doubao connector list exceeded one page.', 'upstream_invalid_response');
  }
  return matches.find((connector) => connector.enabled) ?? matches[0];
}

function connectorValue(value: Record<string, unknown>): Connector | undefined {
  return typeof value.connector_id === 'string' && value.connector_id
    ? { id: value.connector_id, enabled: value.enabled === true }
    : undefined;
}

async function postHttp2Sse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const target = new URL(url);
  const session = http2.connect(target.origin);
  const controller = new AbortController();
  const combinedSignal = signal
    ? typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, controller.signal])
      : signal
    : controller.signal;
  const requestHeaders: http2.OutgoingHttpHeaders = {
    ':method': 'POST',
    ':path': `${target.pathname}${target.search}`,
  };
  for (const [key, value] of Object.entries(headers)) {
    if (!/^(host|connection|content-length|transfer-encoding|keep-alive|upgrade|proxy-connection)$/i.test(key)) {
      requestHeaders[key.toLowerCase()] = value;
    }
  }
  return new Promise<Response>((resolve, reject) => {
    const stream = session.request(requestHeaders);
    let settled = false;
    const close = (): void => {
      controller.abort();
      stream.close(http2.constants.NGHTTP2_CANCEL);
      session.close();
    };
    const onAbort = (): void => close();
    combinedSignal.addEventListener('abort', onAbort, { once: true });
    stream.once('response', (responseHeaders) => {
      settled = true;
      const responseHeadersValue = new Headers();
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (!key.startsWith(':') && value !== undefined) {
          responseHeadersValue.set(key, Array.isArray(value) ? value.join(', ') : String(value));
        }
      }
      const responseBody = new ReadableStream<Uint8Array>({
        start(streamController) {
          stream.on('data', (chunk: Buffer) => streamController.enqueue(new Uint8Array(chunk)));
          let ended = false;
          stream.once('end', () => {
            ended = true;
            streamController.close();
          });
          stream.once('error', (error) => {
            if (!ended) {
              ended = true;
              streamController.error(error);
            }
          });
          stream.once('close', () => {
            if (!ended) {
              ended = true;
              streamController.error(providerError('Doubao HTTP/2 stream closed early.', 'upstream_stream_truncated'));
            }
            combinedSignal.removeEventListener('abort', onAbort);
            session.close();
          });
        },
        cancel() {
          close();
        },
      });
      resolve(
        new Response(responseBody, {
          status: Number(responseHeaders[':status'] ?? 502),
          headers: responseHeadersValue,
        }),
      );
    });
    stream.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      session.close();
    });
    stream.once('close', () => {
      if (!settled) {
        settled = true;
        reject(providerError('Doubao HTTP/2 closed before response headers.', 'upstream_stream_truncated'));
      }
    });
    session.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    stream.end(JSON.stringify(body));
  });
}

function objectValue(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function doubaoWaitTimeoutMs(): number {
  return positiveDuration('X_ADAPTER_DOUBAO_TOOL_WAIT_MS', 40_000);
}

export function doubaoToolLimitMs(): number {
  return positiveDuration('X_ADAPTER_DOUBAO_TOOL_LIMIT_MS', 600_000);
}

function positiveDuration(name: string, fallback: number): number {
  const value = intEnv(name, fallback);
  return value > 0 ? value : fallback;
}
