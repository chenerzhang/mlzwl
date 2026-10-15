import { intEnv } from '../config/env.js';
import { redactSensitiveText } from '../logging/jsonl.js';
import { parsePublicModelId } from '../models/model-id.js';
import { CanonicalResult, CanonicalStreamEvent, CanonicalToolCall } from './canonical.js';
import { shouldExposeRawReasoning, shouldExposeReasoningSummary } from './reasoning.js';
import { customToolInput } from './tools.js';
import { chatCompletionsDeltaChunk, chatCompletionsDoneChunk, chatCompletionsStartChunk } from './chat-completions.js';

const encoder = new TextEncoder();

function dataFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function eventFrame(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function incompleteCanonicalStreamError(): Error {
  const error = new Error('Provider stream ended without a canonical terminal event.');
  (error as NodeJS.ErrnoException).code = 'upstream_stream_truncated';
  return error;
}

function upstreamErrorCode(model: string, error?: unknown): string {
  const original = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
  if (
    original &&
    [
      'invalid_doubao_credentials',
      'invalid_input',
      'previous_response_unavailable',
      'unsupported_tools',
      'unsupported_hosted_tool',
      'unsupported_multimodal_content',
      'upstream_stream_truncated',
      'trae_chat_first_event_timeout',
      'trae_chat_idle_timeout',
      'trae_chat_max_duration_timeout',
    ].includes(original)
  ) {
    return original;
  }
  const provider = parsePublicModelId(model)?.provider;
  return provider ? `${provider}_upstream_error` : 'provider_request_failed';
}

export function heartbeatIntervalMs(): number {
  const explicit = process.env.X_ADAPTER_SSE_HEARTBEAT_INTERVAL_MS;
  if (explicit && explicit.trim()) {
    return intEnv('X_ADAPTER_SSE_HEARTBEAT_INTERVAL_MS', 30_000);
  }
  const seconds = intEnv('SSE_HEARTBEAT_INTERVAL', 30);
  return seconds > 0 ? seconds * 1000 : 0;
}

export async function* withHeartbeat(
  iterable: AsyncIterable<Uint8Array>,
  intervalMs = heartbeatIntervalMs(),
  heartbeat = ': keepalive\n\n',
): AsyncGenerator<Uint8Array> {
  if (intervalMs <= 0) {
    yield* iterable;
    return;
  }
  const iterator = iterable[Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const heartbeatReady = new Promise<{ type: 'heartbeat' }>((resolve) => {
        timer = setTimeout(() => resolve({ type: 'heartbeat' }), intervalMs);
        timer.unref?.();
      });
      const result = await Promise.race([pending.then((value) => ({ type: 'next' as const, value })), heartbeatReady]);
      if (timer) {
        clearTimeout(timer);
      }
      if (result.type === 'heartbeat') {
        yield encode(heartbeat);
        continue;
      }
      if (result.value.done) {
        return;
      }
      yield result.value.value;
      pending = iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

export function readableFromAsyncIterable(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of iterable) {
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export async function* chatCompletionsSseIterable(
  events: AsyncIterable<CanonicalStreamEvent>,
  fallbackModel: string,
  options: { id?: string } = {},
): AsyncGenerator<Uint8Array> {
  const id = options.id ?? `chatcmpl-${crypto.randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let started = false;
  let text = '';
  let reasoning = '';
  let finishReason = 'stop';
  let sawDone = false;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const toolCalls: CanonicalToolCall[] = [];

  const ensureStarted = function* (): Generator<Uint8Array> {
    if (!started) {
      started = true;
      yield encode(dataFrame(chatCompletionsStartChunk(id, created, model)));
    }
  };

  try {
    for await (const event of events) {
      if (event.type === 'start') {
        model = event.model;
        yield* ensureStarted();
      } else if (event.type === 'text') {
        yield* ensureStarted();
        text += event.delta;
        yield encode(dataFrame(chatCompletionsDeltaChunk(id, created, model, { content: event.delta })));
      } else if (event.type === 'reasoning') {
        reasoning += event.delta;
        if (shouldExposeRawReasoning()) {
          yield* ensureStarted();
          yield encode(dataFrame(chatCompletionsDeltaChunk(id, created, model, { reasoning_content: event.delta })));
        }
      } else if (event.type === 'tool_call_delta') {
        yield* ensureStarted();
        toolCalls.push(...event.tool_calls);
        yield encode(
          dataFrame(
            chatCompletionsDeltaChunk(id, created, model, {
              tool_calls: event.tool_calls.map((toolCall) => ({
                index: toolCall.index ?? 0,
                id: toolCall.id,
                type: 'function',
                function: toolCall.function,
              })),
            }),
          ),
        );
      } else if (event.type === 'web_search') {
        // Chat Completions has no native hosted-search output item. References
        // remain available in Responses while this internal lifecycle stays hidden.
      } else if (event.type === 'usage') {
        usage = event.usage;
      } else if (event.type === 'progress') {
        yield* ensureStarted();
        yield encode(`: ${event.event}\n\n`);
      } else if (event.type === 'done') {
        finishReason = event.finish_reason;
        sawDone = true;
      }
    }
    if (!sawDone) {
      throw incompleteCanonicalStreamError();
    }
    yield* ensureStarted();
    const result: CanonicalResult = {
      model,
      text,
      reasoning,
      tool_calls: toolCalls,
      finish_reason: finishReason,
      usage,
    };
    yield encode(dataFrame(chatCompletionsDoneChunk(id, created, model, result)));
    yield encode('data: [DONE]\n\n');
  } catch (error) {
    yield* ensureStarted();
    yield encode(dataFrame({ error: { code: upstreamErrorCode(model, error), message: errorMessage(error) } }));
    yield encode('data: [DONE]\n\n');
  }
}

export async function chatCompletionsSseFromEvents(
  events: AsyncIterable<CanonicalStreamEvent>,
  fallbackModel: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of chatCompletionsSseIterable(events, fallbackModel)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type MessageState = {
  responseId: string;
  messageId?: string;
  model: string;
  outputStarted: boolean;
  outputClosed: boolean;
  outputIndex?: number;
  outputText: string;
  responseText: string;
  nextOutputIndex: number;
};

type ReasoningState = {
  outputIndex: number;
  itemId: string;
  text: string;
  started: boolean;
  closed: boolean;
};

type FunctionCallState = {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  clientType: 'function' | 'custom';
  namespace?: string;
  /** Already exposed raw custom input; never expose the adapter JSON wrapper. */
  customInputEmitted: string;
  closed: boolean;
};

type WebSearchState = {
  outputIndex: number;
  itemId: string;
  call: import('./canonical.js').CanonicalWebSearchCall;
  added: boolean;
  closed: boolean;
};

type ResponsesStreamOptions = {
  responseId?: string;
  previousResponseId?: string | null;
  onComplete?: (response: Record<string, unknown>) => void;
  onFailed?: (error: { code: string; name: string; message: string }) => void;
};

function responseShell(
  responseId: string,
  model: string,
  status: string,
  previousResponseId: string | null = null,
  output: Record<string, unknown>[] = [],
) {
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output,
    previous_response_id: previousResponseId,
  };
}

function closeResponsesMessage(state: MessageState): {
  frames: string[];
  item?: Record<string, unknown>;
  outputIndex?: number;
} {
  if (!state.outputStarted || state.outputClosed || !state.messageId || state.outputIndex === undefined) {
    return { frames: [] };
  }
  state.outputClosed = true;
  const item = {
    id: state.messageId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: state.outputText }],
  };
  return {
    item,
    outputIndex: state.outputIndex,
    frames: [
      eventFrame('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: state.messageId,
        output_index: state.outputIndex,
        content_index: 0,
        text: state.outputText,
        response_id: state.responseId,
      }),
      eventFrame('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: state.messageId,
        output_index: state.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: state.outputText },
      }),
      eventFrame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item,
      }),
    ],
  };
}

function startReasoning(state: MessageState): ReasoningState {
  return {
    outputIndex: state.nextOutputIndex++,
    itemId: `rs_${crypto.randomUUID().replaceAll('-', '')}`,
    text: '',
    started: false,
    closed: false,
  };
}

function reasoningItem(reasoning: ReasoningState, status: 'in_progress' | 'completed') {
  return {
    id: reasoning.itemId,
    type: 'reasoning',
    status,
    summary: status === 'completed' ? [{ type: 'summary_text', text: reasoning.text }] : [],
  };
}

function closeResponsesReasoning(reasoning: ReasoningState | undefined): {
  frames: string[];
  item?: Record<string, unknown>;
  outputIndex?: number;
} {
  if (!reasoning?.started || reasoning.closed) {
    return { frames: [] };
  }
  reasoning.closed = true;
  const item = reasoningItem(reasoning, 'completed');
  return {
    item,
    outputIndex: reasoning.outputIndex,
    frames: [
      eventFrame('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: reasoning.itemId,
        output_index: reasoning.outputIndex,
        summary_index: 0,
        text: reasoning.text,
      }),
      eventFrame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: reasoning.outputIndex,
        item,
      }),
    ],
  };
}

function partialCustomToolInput(argumentsText: string): string {
  const leading = argumentsText.match(/^\s*/)?.[0].length ?? 0;
  if (argumentsText[leading] !== '{') {
    return argumentsText;
  }
  // Custom tools are adapted as `{ "input": "..." }`. Do not treat an
  // incomplete or malformed object as raw freeform input: it is transport
  // syntax, not client-visible content.
  const prefix = /^\s*\{\s*"input"\s*:\s*"/.exec(argumentsText);
  if (!prefix) {
    return '';
  }
  let result = '';
  for (let index = prefix[0].length; index < argumentsText.length; index += 1) {
    const character = argumentsText[index];
    if (character === '"') {
      return result;
    }
    if (character !== '\\') {
      result += character;
      continue;
    }
    const escaped = argumentsText[index + 1];
    if (!escaped) {
      break;
    }
    if (escaped === 'u') {
      const hex = argumentsText.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        break;
      }
      result += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    const escapedCharacters: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (!(escaped in escapedCharacters)) {
      break;
    }
    result += escapedCharacters[escaped];
    index += 1;
  }
  return result;
}

function closeResponsesFunctionCalls(calls: Map<number, FunctionCallState>): {
  frames: string[];
  items: Array<{ outputIndex: number; item: Record<string, unknown> }>;
} {
  const frames: string[] = [];
  const items: Array<{ outputIndex: number; item: Record<string, unknown> }> = [];
  for (const record of calls.values()) {
    if (record.closed) {
      continue;
    }
    record.closed = true;
    const rawCustomInput =
      record.clientType === 'custom'
        ? record.arguments.trimStart().startsWith('{')
          ? partialCustomToolInput(record.arguments)
          : customToolInput(record.arguments)
        : undefined;
    const item =
      record.clientType === 'custom'
        ? {
            id: record.itemId,
            type: 'custom_tool_call',
            status: 'completed',
            call_id: record.callId,
            name: record.name,
            input: rawCustomInput,
            ...(record.namespace === undefined ? {} : { namespace: record.namespace }),
          }
        : {
            id: record.itemId,
            type: 'function_call',
            status: 'completed',
            call_id: record.callId,
            name: record.name,
            arguments: record.arguments,
            ...(record.namespace === undefined ? {} : { namespace: record.namespace }),
          };
    if (record.clientType === 'custom') {
      // The function-adapter may stream an incomplete JSON `{ input: ... }`
      // wrapper. Emit raw custom input only once it is complete rather than
      // leaking wrapper fragments as a freeform program.
      const finalCustomInput = rawCustomInput ?? '';
      const remainingInput = finalCustomInput.startsWith(record.customInputEmitted)
        ? finalCustomInput.slice(record.customInputEmitted.length)
        : '';
      if (remainingInput) {
        frames.push(
          eventFrame('response.custom_tool_call_input.delta', {
            type: 'response.custom_tool_call_input.delta',
            item_id: record.itemId,
            output_index: record.outputIndex,
            delta: remainingInput,
          }),
        );
      }
      frames.push(
        eventFrame('response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done',
          item_id: record.itemId,
          output_index: record.outputIndex,
          input: finalCustomInput,
        }),
      );
    } else {
      frames.push(
        eventFrame('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: record.itemId,
          output_index: record.outputIndex,
          call_id: record.callId,
          name: record.name,
          arguments: record.arguments,
        }),
      );
    }
    frames.push(
      eventFrame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: record.outputIndex,
        item,
      }),
    );
    items.push({ outputIndex: record.outputIndex, item });
  }
  return { frames, items };
}

export async function* responsesSseIterable(
  events: AsyncIterable<CanonicalStreamEvent>,
  fallbackModel: string,
  options: ResponsesStreamOptions = {},
): AsyncGenerator<Uint8Array> {
  const state: MessageState = {
    responseId: options.responseId ?? `resp_${crypto.randomUUID().replaceAll('-', '')}`,
    model: fallbackModel,
    outputStarted: false,
    outputClosed: false,
    outputText: '',
    responseText: '',
    nextOutputIndex: 0,
  };
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let sawDone = false;
  let finishReason = 'stop';
  let hiddenReasoning = '';
  let reasoning: ReasoningState | undefined;
  const outputItems: Array<{ outputIndex: number; item: Record<string, unknown> }> = [];
  const functionCalls = new Map<number, FunctionCallState>();
  const webSearchCalls = new Map<string, WebSearchState>();

  try {
    yield encode(
      eventFrame('response.created', {
        type: 'response.created',
        response: responseShell(state.responseId, state.model, 'in_progress', options.previousResponseId ?? null),
      }),
    );
    yield encode(
      eventFrame('response.in_progress', {
        type: 'response.in_progress',
        response: responseShell(state.responseId, state.model, 'in_progress', options.previousResponseId ?? null),
      }),
    );
    for await (const current of events) {
      if (sawDone) {
        const error = new Error('Canonical stream emitted an event after its terminal done event.');
        (error as NodeJS.ErrnoException).code = 'invalid_canonical_stream';
        throw error;
      }
      if (current.type === 'start') {
        state.model = current.model;
      } else if (current.type === 'reasoning') {
        const exposeSummary = shouldExposeReasoningSummary();
        if (!exposeSummary) {
          hiddenReasoning += current.delta;
          continue;
        }
        const closedMessage = closeResponsesMessage(state);
        if (closedMessage.item && closedMessage.outputIndex !== undefined) {
          outputItems.push({ outputIndex: closedMessage.outputIndex, item: closedMessage.item });
        }
        for (const frame of closedMessage.frames) {
          yield encode(frame);
        }
        const closedCalls = closeResponsesFunctionCalls(functionCalls);
        outputItems.push(...closedCalls.items);
        for (const frame of closedCalls.frames) {
          yield encode(frame);
        }
        if (!reasoning || reasoning.closed) {
          reasoning = startReasoning(state);
        }
        if (!reasoning.started) {
          reasoning.started = true;
          yield encode(
            eventFrame('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: reasoning.outputIndex,
              item: reasoningItem(reasoning, 'in_progress'),
            }),
          );
          yield encode(
            eventFrame('response.reasoning_summary_part.added', {
              type: 'response.reasoning_summary_part.added',
              item_id: reasoning.itemId,
              output_index: reasoning.outputIndex,
              summary_index: 0,
              part: { type: 'summary_text', text: '' },
            }),
          );
        }
        reasoning.text += current.delta;
        if (exposeSummary) {
          yield encode(
            eventFrame('response.reasoning_summary_text.delta', {
              type: 'response.reasoning_summary_text.delta',
              item_id: reasoning.itemId,
              output_index: reasoning.outputIndex,
              summary_index: 0,
              delta: current.delta,
            }),
          );
        }
      } else if (current.type === 'text') {
        const closedReasoning = closeResponsesReasoning(reasoning);
        if (closedReasoning.item && closedReasoning.outputIndex !== undefined) {
          outputItems.push({ outputIndex: closedReasoning.outputIndex, item: closedReasoning.item });
        }
        for (const frame of closedReasoning.frames) {
          yield encode(frame);
        }
        const closedCalls = closeResponsesFunctionCalls(functionCalls);
        outputItems.push(...closedCalls.items);
        for (const frame of closedCalls.frames) {
          yield encode(frame);
        }
        if (!state.outputStarted || state.outputClosed) {
          state.outputStarted = true;
          state.outputClosed = false;
          state.outputIndex = state.nextOutputIndex++;
          state.messageId = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
          state.outputText = '';
          yield encode(
            eventFrame('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: state.outputIndex,
              item: { id: state.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            }),
          );
          yield encode(
            eventFrame('response.content_part.added', {
              type: 'response.content_part.added',
              item_id: state.messageId,
              output_index: state.outputIndex,
              content_index: 0,
              part: { type: 'output_text', text: '' },
            }),
          );
        }
        state.outputText += current.delta;
        state.responseText += current.delta;
        yield encode(
          eventFrame('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: state.messageId,
            output_index: state.outputIndex,
            content_index: 0,
            delta: current.delta,
            response_id: state.responseId,
          }),
        );
      } else if (current.type === 'tool_call_delta') {
        const closedReasoning = closeResponsesReasoning(reasoning);
        if (closedReasoning.item && closedReasoning.outputIndex !== undefined) {
          outputItems.push({ outputIndex: closedReasoning.outputIndex, item: closedReasoning.item });
        }
        for (const frame of closedReasoning.frames) {
          yield encode(frame);
        }
        const closed = closeResponsesMessage(state);
        if (closed.item && closed.outputIndex !== undefined) {
          outputItems.push({ outputIndex: closed.outputIndex, item: closed.item });
        }
        for (const frame of closed.frames) {
          yield encode(frame);
        }
        for (const toolCall of current.tool_calls) {
          const idx = toolCall.index ?? 0;
          let record = functionCalls.get(idx);
          if (!record) {
            const callId = toolCall.id || `call_${idx}`;
            record = {
              outputIndex: state.nextOutputIndex++,
              itemId: `${toolCall.client_type === 'custom' ? 'cc' : 'fc'}_${callId}`,
              callId,
              name: toolCall.function.name,
              arguments: '',
              clientType: toolCall.client_type ?? 'function',
              namespace: toolCall.namespace,
              customInputEmitted: '',
              closed: false,
            };
            functionCalls.set(idx, record);
            yield encode(
              eventFrame('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: record.outputIndex,
                item:
                  record.clientType === 'custom'
                    ? {
                        id: record.itemId,
                        type: 'custom_tool_call',
                        status: 'in_progress',
                        call_id: record.callId,
                        name: record.name,
                        input: '',
                        ...(record.namespace === undefined ? {} : { namespace: record.namespace }),
                      }
                    : {
                        id: record.itemId,
                        type: 'function_call',
                        status: 'in_progress',
                        call_id: record.callId,
                        name: record.name,
                        arguments: '',
                        ...(record.namespace === undefined ? {} : { namespace: record.namespace }),
                      },
              }),
            );
          }
          if (record.closed) {
            const error = new Error(`Function call index ${idx} emitted a delta after its output item closed.`);
            (error as NodeJS.ErrnoException).code = 'invalid_canonical_stream';
            throw error;
          }
          if (toolCall.function.name) {
            record.name = toolCall.function.name;
          }
          if (toolCall.client_type) {
            record.clientType = toolCall.client_type;
          }
          if (toolCall.namespace !== undefined) {
            record.namespace = toolCall.namespace;
          }
          if (toolCall.function.arguments) {
            record.arguments += toolCall.function.arguments;
            if (record.clientType === 'function') {
              yield encode(
                eventFrame('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  item_id: record.itemId,
                  output_index: record.outputIndex,
                  call_id: record.callId,
                  delta: toolCall.function.arguments,
                }),
              );
            } else {
              const rawInput = partialCustomToolInput(record.arguments);
              if (rawInput.startsWith(record.customInputEmitted)) {
                const delta = rawInput.slice(record.customInputEmitted.length);
                if (delta) {
                  record.customInputEmitted = rawInput;
                  yield encode(
                    eventFrame('response.custom_tool_call_input.delta', {
                      type: 'response.custom_tool_call_input.delta',
                      item_id: record.itemId,
                      output_index: record.outputIndex,
                      delta,
                    }),
                  );
                }
              }
            }
          }
        }
      } else if (current.type === 'web_search') {
        let search = webSearchCalls.get(current.call.id);
        if (!search) {
          search = {
            outputIndex: state.nextOutputIndex++,
            itemId: current.call.id,
            call: current.call,
            added: false,
            closed: false,
          };
          webSearchCalls.set(current.call.id, search);
        }
        if (search.closed) {
          const error = new Error(`Web search call ${current.call.id} emitted an event after completion.`);
          (error as NodeJS.ErrnoException).code = 'invalid_canonical_stream';
          throw error;
        }
        search.call = current.call;
        if (!search.added) {
          search.added = true;
          yield encode(
            eventFrame('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: search.outputIndex,
              item: { ...current.call, id: search.itemId, status: 'in_progress', results: [], references: [] },
            }),
          );
        }
        if (current.call.status !== 'in_progress') {
          search.closed = true;
          const item = { ...current.call, id: search.itemId };
          outputItems.push({ outputIndex: search.outputIndex, item });
          yield encode(
            eventFrame('response.output_item.done', {
              type: 'response.output_item.done',
              output_index: search.outputIndex,
              item,
            }),
          );
        }
      } else if (current.type === 'usage') {
        usage = current.usage;
      } else if (current.type === 'done') {
        sawDone = true;
        finishReason = current.finish_reason;
      } else if (current.type === 'progress') {
        yield encode(
          eventFrame('response.in_progress', {
            type: 'response.in_progress',
            response: responseShell(state.responseId, state.model, 'in_progress', options.previousResponseId ?? null),
            meta: { upstream_event: current.event },
          }),
        );
      }
    }
    if (!sawDone) {
      throw incompleteCanonicalStreamError();
    }
    const closedReasoning = closeResponsesReasoning(reasoning);
    if (closedReasoning.item && closedReasoning.outputIndex !== undefined) {
      outputItems.push({ outputIndex: closedReasoning.outputIndex, item: closedReasoning.item });
    }
    for (const frame of closedReasoning.frames) {
      yield encode(frame);
    }
    const closed = closeResponsesMessage(state);
    if (closed.item && closed.outputIndex !== undefined) {
      outputItems.push({ outputIndex: closed.outputIndex, item: closed.item });
    }
    for (const frame of closed.frames) {
      yield encode(frame);
    }
    const closedCalls = closeResponsesFunctionCalls(functionCalls);
    outputItems.push(...closedCalls.items);
    for (const frame of closedCalls.frames) {
      yield encode(frame);
    }
    for (const search of webSearchCalls.values()) {
      if (search.closed) {
        continue;
      }
      search.closed = true;
      const item = { ...search.call, id: search.itemId, status: 'failed' as const };
      outputItems.push({ outputIndex: search.outputIndex, item });
      yield encode(
        eventFrame('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: search.outputIndex,
          item,
        }),
      );
    }
    const reasoningText = `${hiddenReasoning}${reasoning?.text ?? ''}`;
    const exposeReasoningSummary = Boolean(reasoningText && shouldExposeReasoningSummary());
    const orderedOutputItems = outputItems
      .sort((left, right) => left.outputIndex - right.outputIndex)
      .map((entry) => entry.item);
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    const completed = {
      ...responseShell(state.responseId, state.model, status, options.previousResponseId ?? null, orderedOutputItems),
      ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output_text: state.responseText,
      usage,
      reasoning: exposeReasoningSummary ? { summary: [{ type: 'summary_text', text: reasoningText }] } : null,
    };
    options.onComplete?.(completed);
    yield encode(eventFrame(`response.${status}`, { type: `response.${status}`, response: completed }));
    yield encode('data: [DONE]\n\n');
  } catch (error) {
    const message = errorMessage(error);
    const code = upstreamErrorCode(state.model, error);
    options.onFailed?.({ code, name: error instanceof Error ? error.name : 'Error', message });
    yield encode(
      eventFrame('response.failed', {
        type: 'response.failed',
        response: {
          ...responseShell(state.responseId, state.model, 'failed', options.previousResponseId ?? null),
          error: { code, message },
        },
      }),
    );
    yield encode('data: [DONE]\n\n');
  }
}

export async function responsesSseFromEvents(
  events: AsyncIterable<CanonicalStreamEvent>,
  fallbackModel: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of responsesSseIterable(events, fallbackModel)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function* anthropicSseIterable(
  events: AsyncIterable<CanonicalStreamEvent>,
  fallbackModel: string,
  options: { id?: string } = {},
): AsyncGenerator<Uint8Array> {
  const messageId = options.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  let model = fallbackModel;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let started = false;
  let blockIndex = 0;
  let activeBlock: { index: number; type: 'text' | 'thinking' } | null = null;
  const toolBlocks = new Map<number, number>();
  let hadTool = false;
  let sawDone = false;
  let finishReason = 'stop';

  const ensureStart = function* (): Generator<Uint8Array> {
    if (!started) {
      started = true;
      yield encode(
        eventFrame('message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }
  };

  const ensureBlock = function* (type: 'text' | 'thinking'): Generator<Uint8Array> {
    if (activeBlock?.type === type) {
      return;
    }
    const previousBlock = activeBlock;
    if (previousBlock) {
      yield encode(eventFrame('content_block_stop', { type: 'content_block_stop', index: previousBlock.index }));
    }
    activeBlock = { index: blockIndex++, type };
    yield encode(
      eventFrame('content_block_start', {
        type: 'content_block_start',
        index: activeBlock.index,
        content_block: type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
      }),
    );
  };

  try {
    for await (const current of events) {
      if (current.type === 'start') {
        model = current.model;
        yield* ensureStart();
      } else if (current.type === 'text' || current.type === 'reasoning') {
        if (current.type === 'reasoning' && !shouldExposeReasoningSummary()) {
          continue;
        }
        yield* ensureStart();
        const blockType = current.type === 'reasoning' ? 'thinking' : 'text';
        yield* ensureBlock(blockType);
        yield encode(
          eventFrame('content_block_delta', {
            type: 'content_block_delta',
            index: activeBlock!.index,
            delta:
              blockType === 'thinking'
                ? { type: 'thinking_delta', thinking: current.delta }
                : { type: 'text_delta', text: current.delta },
          }),
        );
      } else if (current.type === 'tool_call_delta') {
        yield* ensureStart();
        const blockToClose = activeBlock as { index: number; type: 'text' | 'thinking' } | null;
        if (blockToClose) {
          yield encode(eventFrame('content_block_stop', { type: 'content_block_stop', index: blockToClose.index }));
          activeBlock = null;
        }
        for (const toolCall of current.tool_calls) {
          const idx = toolCall.index ?? 0;
          let outIndex = toolBlocks.get(idx);
          if (outIndex === undefined) {
            hadTool = true;
            outIndex = blockIndex++;
            toolBlocks.set(idx, outIndex);
            yield encode(
              eventFrame('content_block_start', {
                type: 'content_block_start',
                index: outIndex,
                content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: {} },
              }),
            );
          }
          if (toolCall.function.arguments) {
            yield encode(
              eventFrame('content_block_delta', {
                type: 'content_block_delta',
                index: outIndex,
                delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments },
              }),
            );
          }
        }
      } else if (current.type === 'web_search') {
        // Anthropic has no compatible hosted-search output block in this
        // gateway contract; preserve its final synthesis and hide internals.
      } else if (current.type === 'usage') {
        usage = current.usage;
      } else if (current.type === 'done') {
        sawDone = true;
        finishReason = current.finish_reason;
      } else if (current.type === 'progress') {
        yield encode(`: ${current.event}\n\n`);
      }
    }
    if (!sawDone) {
      throw incompleteCanonicalStreamError();
    }
    if (!started) {
      yield* ensureStart();
    }
    const finalBlock = activeBlock as { index: number; type: 'text' | 'thinking' } | null;
    if (finalBlock) {
      yield encode(eventFrame('content_block_stop', { type: 'content_block_stop', index: finalBlock.index }));
    }
    for (const outIndex of [...toolBlocks.values()].sort((a, b) => a - b)) {
      yield encode(eventFrame('content_block_stop', { type: 'content_block_stop', index: outIndex }));
    }
    yield encode(
      eventFrame('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: finishReason === 'length' ? 'max_tokens' : hadTool ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: usage.output_tokens },
      }),
    );
    yield encode(eventFrame('message_stop', { type: 'message_stop' }));
  } catch (error) {
    yield* ensureStart();
    yield encode(
      eventFrame('error', {
        type: 'error',
        error: { type: 'api_error', code: upstreamErrorCode(model, error), message: errorMessage(error) },
      }),
    );
  }
}

export async function anthropicSseFromEvents(
  events: AsyncIterable<CanonicalStreamEvent>,
  fallbackModel: string,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of anthropicSseIterable(events, fallbackModel)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type StreamRunner = (request: unknown) => AsyncIterable<CanonicalStreamEvent>;
