import { intEnv } from '../config/env.js';
import {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResult,
  CanonicalStreamEvent,
  CanonicalTool,
  CanonicalToolCall,
  CanonicalWebSearchCall,
  textFromContent,
  isUserIntentMessage,
} from '../protocol/canonical.js';
import { mergeToolCallDeltas, stringifyJson } from '../protocol/tools.js';
import { truncateToolOutput } from '../protocol/tool-output.js';

/** Never expose this provider-internal function name to a gateway client. */
export const INTERNAL_WEB_SEARCH_TOOL_NAME = '__x_connect_web_search';

const HOSTED_WEB_SEARCH_NAMES = new Set([
  'web_search',
  'tool_search',
  'web_search_20250305',
  'web_search_20260209',
  'web_search_preview',
  'web_search_preview_2025_03_11',
]);

export type WebSearchReference = {
  title?: string;
  url: string;
  snippet?: string;
  snippets?: string[];
};

export type StructuredSearchResult = {
  query: string;
  references: WebSearchReference[];
  answer?: string;
};

export type StructuredSearchRunner = (
  query: string,
  options: { model: string; signal?: AbortSignal },
) => Promise<StructuredSearchResult>;

type ChatRunner = (request: CanonicalRequest, signal?: AbortSignal) => Promise<CanonicalResult>;
type StreamRunner = (request: CanonicalRequest, signal?: AbortSignal) => AsyncIterable<CanonicalStreamEvent>;

export function hasHostedWebSearch(request: CanonicalRequest): boolean {
  return (request.tools ?? []).some((tool) => tool.hosted === true || HOSTED_WEB_SEARCH_NAMES.has(tool.function.name));
}

export function hostedWebSearchTool(): CanonicalTool {
  return {
    type: 'function',
    function: {
      name: INTERNAL_WEB_SEARCH_TOOL_NAME,
      description: 'Search the public web for current information and return concise source-backed results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language web search query.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  };
}

/** Replace a client hosted-tool declaration with an unobservable provider function tool. */
export function withInternalWebSearchTool(request: CanonicalRequest): CanonicalRequest {
  if (!hasHostedWebSearch(request)) {
    return request;
  }
  const tools = (request.tools ?? []).filter(
    (tool) => !tool.hosted && !HOSTED_WEB_SEARCH_NAMES.has(tool.function.name),
  );
  tools.push(hostedWebSearchTool());
  const requestedName = typeof request.tool_choice === 'object' ? request.tool_choice.function.name : undefined;
  const toolChoice =
    requestedName && HOSTED_WEB_SEARCH_NAMES.has(requestedName)
      ? { type: 'function' as const, function: { name: INTERNAL_WEB_SEARCH_TOOL_NAME } }
      : request.tool_choice;
  return { ...request, tools, tool_choice: toolChoice };
}

function webSearchQuery(argumentsText: string): string {
  const trimmed = argumentsText.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') {
      return parsed.trim();
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { query?: unknown }).query === 'string') {
      return (parsed as { query: string }).query.trim();
    }
  } catch {
    // The internal tool requires JSON; raw text is not treated as a query.
  }
  return '';
}

function webSearchCall(
  id: string,
  query: string,
  status: CanonicalWebSearchCall['status'],
  result?: StructuredSearchResult,
): CanonicalWebSearchCall {
  const references = result?.references ?? [];
  return {
    id,
    type: 'web_search_call',
    status,
    action: { type: 'search', query },
    results: references.map((reference) => ({
      type: 'search_result',
      title: reference.title,
      url: reference.url,
      snippet: reference.snippet,
      snippets: reference.snippets,
    })),
    references,
  };
}

function internalToolResultMessage(callId: string, value: Record<string, unknown>): CanonicalMessage {
  return {
    role: 'tool',
    name: INTERNAL_WEB_SEARCH_TOOL_NAME,
    tool_call_id: callId,
    content: [{ type: 'text', text: truncateToolOutput(stringifyJson(value)) }],
  };
}

async function executeSearchCalls(
  calls: CanonicalToolCall[],
  model: string,
  runner: StructuredSearchRunner,
  signal?: AbortSignal,
): Promise<{ searchCalls: CanonicalWebSearchCall[]; toolMessages: CanonicalMessage[] }> {
  const searchCalls: CanonicalWebSearchCall[] = [];
  const toolMessages: CanonicalMessage[] = [];
  for (const call of calls) {
    const query = webSearchQuery(call.function.arguments);
    if (!query) {
      searchCalls.push(webSearchCall(call.id, '', 'failed'));
      toolMessages.push(
        internalToolResultMessage(call.id, {
          type: 'web_search_result',
          version: 'v1',
          status: 'error',
          error: { code: 'invalid_query', message: 'Please provide a specific search query.' },
          references: [],
        }),
      );
      continue;
    }
    try {
      const result = await runner(query, { model, signal });
      searchCalls.push(webSearchCall(call.id, query, 'completed', result));
      toolMessages.push(
        internalToolResultMessage(call.id, {
          type: 'web_search_result',
          version: 'v1',
          status: 'ok',
          query,
          summary: result.answer,
          references: result.references,
        }),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      searchCalls.push(webSearchCall(call.id, query, 'failed'));
      toolMessages.push(
        internalToolResultMessage(call.id, {
          type: 'web_search_result',
          version: 'v1',
          status: 'error',
          query,
          // Do not return upstream response bodies or provider diagnostics to a model.
          error: {
            code: typeof code === 'string' ? code : 'temporary_failure',
            message: 'Web search is temporarily unavailable.',
          },
          references: [],
        }),
      );
    }
  }
  return { searchCalls, toolMessages };
}

function internalCalls(result: CanonicalResult): CanonicalToolCall[] {
  return result.tool_calls.filter((call) => call.function.name === INTERNAL_WEB_SEARCH_TOOL_NAME);
}

function resultWithoutInternalCalls(result: CanonicalResult): CanonicalResult {
  return {
    ...result,
    tool_calls: result.tool_calls.filter((call) => call.function.name !== INTERNAL_WEB_SEARCH_TOOL_NAME),
  };
}

function terminalFallback(model: string, calls: CanonicalWebSearchCall[]): CanonicalResult {
  return {
    model,
    text: 'Live web search took too many steps to finish. Please retry with a narrower request.',
    reasoning: '',
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    web_search_calls: calls,
  };
}

/**
 * Execute a bounded, provider-local model → search → model loop. Client tools are
 * never executed here: a turn that mixes an internal search and client tool call
 * is returned to the client with its ordinary calls intact.
 */
export async function runStructuredHostedSearch(
  request: CanonicalRequest,
  runChat: ChatRunner,
  search: StructuredSearchRunner,
  signal?: AbortSignal,
): Promise<CanonicalResult> {
  if (!hasHostedWebSearch(request)) {
    return runChat(request, signal);
  }
  const maxSteps = Math.max(0, intEnv('X_ADAPTER_MAX_INTERNAL_TOOL_STEPS', 64));
  let active = withInternalWebSearchTool(request);
  const allSearchCalls: CanonicalWebSearchCall[] = [];
  for (let step = 0; step <= maxSteps; step += 1) {
    const result = await runChat(active, signal);
    const calls = internalCalls(result);
    if (!calls.length) {
      return {
        ...resultWithoutInternalCalls(result),
        web_search_calls: [...(result.web_search_calls ?? []), ...allSearchCalls],
      };
    }
    const clientCalls = result.tool_calls.filter((call) => call.function.name !== INTERNAL_WEB_SEARCH_TOOL_NAME);
    if (clientCalls.length) {
      return {
        ...resultWithoutInternalCalls(result),
        web_search_calls: [...(result.web_search_calls ?? []), ...allSearchCalls],
      };
    }
    if (step >= maxSteps) {
      return terminalFallback(request.model, allSearchCalls);
    }
    const completed = await executeSearchCalls(calls, active.model, search, signal);
    allSearchCalls.push(...completed.searchCalls);
    active = {
      ...active,
      messages: [
        ...active.messages,
        { role: 'assistant', content: [{ type: 'text', text: result.text }], tool_calls: calls },
        ...completed.toolMessages,
      ],
    };
  }
  return terminalFallback(request.model, allSearchCalls);
}

/**
 * A hosted-search stream stays live: each model turn is forwarded as it arrives,
 * except for the internal function-call chunks. Its terminal is held while the
 * provider-local search runs; the following synthesis turn is then forwarded.
 * Thus no complete internal loop is converted into a faux single SSE response.
 */
export async function* streamStructuredHostedSearch(
  request: CanonicalRequest,
  streamChat: StreamRunner,
  search: StructuredSearchRunner,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalStreamEvent> {
  if (!hasHostedWebSearch(request)) {
    yield* streamChat(request, signal);
    return;
  }
  const maxSteps = Math.max(0, intEnv('X_ADAPTER_MAX_INTERNAL_TOOL_STEPS', 64));
  let active = withInternalWebSearchTool(request);
  let emittedStart = false;
  let searched = false;
  let emittedSynthesisText = false;
  for (let step = 0; step <= maxSteps; step += 1) {
    const internalChunks: CanonicalToolCall[] = [];
    const clientChunks: CanonicalToolCall[] = [];
    const deferredEvents: CanonicalStreamEvent[] = [];
    let turnText = '';
    let finishReason = 'stop';
    for await (const event of streamChat(active, signal)) {
      if (event.type === 'start') {
        if (!emittedStart) {
          emittedStart = true;
          yield event;
        }
      } else if (event.type === 'text') {
        turnText += event.delta;
        // Planning text can be superseded by a search-backed synthesis. Only
        // expose text live after a search result has been appended.
        if (searched) {
          emittedSynthesisText = true;
          yield event;
        } else {
          deferredEvents.push(event);
        }
      } else if (event.type === 'reasoning') {
        if (searched) {
          yield event;
        } else {
          deferredEvents.push(event);
        }
      } else if (event.type === 'tool_call_delta') {
        // Upstreams may provide the function name only in an earlier chunk and
        // append arguments in later nameless chunks. Route by call index after
        // the first internal declaration, then merge the complete argument set.
        const routed = event.tool_calls.map((call) => {
          const index = call.index ?? 0;
          const knownInternal = internalChunks.some((entry) => (entry.index ?? 0) === index);
          const internal = call.function.name === INTERNAL_WEB_SEARCH_TOOL_NAME || knownInternal;
          const normalized =
            internal && !call.function.name
              ? { ...call, function: { ...call.function, name: INTERNAL_WEB_SEARCH_TOOL_NAME } }
              : call;
          if (internal) {
            internalChunks.push(normalized);
          } else {
            clientChunks.push(normalized);
          }
          return { internal, call: normalized };
        });
        const visible = routed.filter((entry) => !entry.internal).map((entry) => entry.call);
        if (visible.length) {
          if (searched) {
            yield { ...event, tool_calls: visible };
          } else {
            deferredEvents.push({ ...event, tool_calls: visible });
          }
        }
      } else if (event.type === 'done') {
        finishReason = event.finish_reason;
        // Do not close the client stream until either this is the final turn or
        // a search result has been appended and another model turn is started.
      } else if (event.type === 'usage') {
        if (searched) {
          yield event;
        } else {
          deferredEvents.push(event);
        }
      } else {
        yield event;
      }
    }
    const calls = mergeToolCallDeltas([internalChunks]).filter(
      (call) => call.function.name === INTERNAL_WEB_SEARCH_TOOL_NAME,
    );
    if (!calls.length) {
      if (!searched) {
        for (const event of deferredEvents) {
          yield event;
        }
      } else if (!emittedSynthesisText && clientChunks.length === 0) {
        // Do not claim a successful hosted-search answer with no synthesis.
        yield { type: 'text', delta: 'Web search completed, but the model returned no final answer. Please retry.' };
      }
      yield { type: 'done', finish_reason: finishReason || (clientChunks.length ? 'tool_calls' : 'stop') };
      return;
    }
    const clientCalls = mergeToolCallDeltas([clientChunks]);
    if (clientCalls.length) {
      for (const call of calls) {
        const query = webSearchQuery(call.function.arguments);
        yield { type: 'web_search', call: webSearchCall(call.id, query, 'in_progress') };
        yield { type: 'web_search', call: webSearchCall(call.id, query, 'failed') };
      }
      yield { type: 'done', finish_reason: 'tool_calls' };
      return;
    }
    if (step >= maxSteps) {
      yield { type: 'text', delta: terminalFallback(request.model, []).text };
      yield { type: 'done', finish_reason: 'stop' };
      return;
    }
    for (const call of calls) {
      yield {
        type: 'web_search',
        call: webSearchCall(call.id, webSearchQuery(call.function.arguments), 'in_progress'),
      };
    }
    const completed = await executeSearchCalls(calls, active.model, search, signal);
    for (const call of completed.searchCalls) {
      yield { type: 'web_search', call };
    }
    searched = true;
    active = {
      ...active,
      messages: [
        ...active.messages,
        { role: 'assistant', content: [{ type: 'text', text: turnText }], tool_calls: calls },
        ...completed.toolMessages,
      ],
    };
  }
  const error = new Error('Hosted web search exceeded its internal step limit.');
  (error as NodeJS.ErrnoException).code = 'internal_tool_steps_exhausted';
  throw error;
}

export function onlineSearchQuery(request: CanonicalRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (isUserIntentMessage(request.messages[index])) {
      return textFromContent(request.messages[index].content).trim();
    }
  }
  return '';
}

/** Remove hosted declarations before sending a one-shot online-answer request. */
export function withoutHostedWebSearchTools(request: CanonicalRequest): CanonicalRequest {
  return {
    ...request,
    tools: (request.tools ?? []).filter((tool) => !tool.hosted && !HOSTED_WEB_SEARCH_NAMES.has(tool.function.name)),
  };
}
