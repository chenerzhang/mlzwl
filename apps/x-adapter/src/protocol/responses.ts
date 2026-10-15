import { defaultOpenAiModel } from '../config/env.js';
import {
  canonicalMessageRole,
  CanonicalMessage,
  CanonicalResult,
  contentBlocks,
  textBlocks,
  textFromContent,
  toolOutputMessages,
} from './canonical.js';
import { resolveResponsesReasoningEffort, shouldExposeReasoningSummary } from './reasoning.js';
import { customToolInput, flattenToolName, normalizeToolChoice, responsesToolsToCanonical } from './tools.js';
import { truncateCanonicalToolOutputs } from './tool-output.js';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function inputToMessages(input: unknown): CanonicalMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: textBlocks(input) }];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  const messages: CanonicalMessage[] = [];
  for (const raw of input) {
    const item = asObject(raw);
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      messages.push(...toolOutputMessages(item.output, callId));
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : '';
      const name = typeof item.name === 'string' ? item.name : '';
      const namespace = typeof item.namespace === 'string' ? item.namespace : undefined;
      if (callId && name) {
        const args =
          item.type === 'custom_tool_call' ? stringifyJson({ input: item.input ?? '' }) : stringifyJson(item.arguments);
        messages.push({
          role: 'assistant',
          content: textBlocks(''),
          tool_calls: [
            {
              id: callId,
              type: 'function',
              client_type: item.type === 'custom_tool_call' ? 'custom' : 'function',
              namespace,
              function: { name: namespace ? flattenToolName(namespace, name) : name, arguments: args },
            },
          ],
        });
      }
    } else if (item.type === 'message' || item.role || item.content !== undefined) {
      messages.push({ role: canonicalMessageRole(item.role), content: contentBlocks(item.content) });
    }
  }
  return messages;
}

function responsesToolDeclarations(body: Record<string, unknown>): unknown[] {
  const declarations = Array.isArray(body.tools) ? [...body.tools] : [];
  if (!Array.isArray(body.input)) {
    return declarations;
  }
  for (const raw of body.input) {
    const item = asObject(raw);
    if (item.type !== 'additional_tools' || !Array.isArray(item.tools)) {
      continue;
    }
    declarations.push(...item.tools);
  }
  return declarations;
}

export function responsesRequestToCanonical(data: unknown) {
  const body = asObject(data);
  const messages: CanonicalMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: textBlocks(body.instructions) });
  }
  messages.push(...inputToMessages(body.input));
  const boundedMessages = truncateCanonicalToolOutputs(messages);
  const maxTokens = Number(body.max_output_tokens ?? body.max_tokens);
  const metadata = asObject(body.metadata);
  const tools = responsesToolsToCanonical(responsesToolDeclarations(body));
  return {
    model: String(body.model || defaultOpenAiModel()),
    messages: boundedMessages,
    tools,
    tool_choice: normalizeToolChoice(body.tool_choice),
    max_tokens: Number.isInteger(maxTokens) ? maxTokens : undefined,
    stream: body.stream === true,
    reasoning_effort: resolveResponsesReasoningEffort(body),
    previous_response_id: typeof body.previous_response_id === 'string' ? body.previous_response_id : undefined,
    session_id: typeof metadata.session_id === 'string' ? metadata.session_id : undefined,
    metadata,
    input_item_count: Array.isArray(body.input) ? body.input.length : body.input === undefined ? 0 : 1,
  };
}

function annotationsFromWebSearch(result: CanonicalResult, text: string): Record<string, unknown>[] {
  const refs = (result.web_search_calls ?? []).flatMap((call) => call.references ?? []);
  if (!refs.length || !text) {
    return [];
  }
  const annotations: Record<string, unknown>[] = [];
  for (const match of text.matchAll(/(?:\[\^(\d+)\]|【\^(\d+)】|\[(\d+)\])/g)) {
    const rawIndex = match[1] ?? match[2] ?? match[3];
    const index = Number.parseInt(rawIndex, 10) - 1;
    const ref = refs[index];
    if (!ref?.url || match.index === undefined) {
      continue;
    }
    annotations.push({
      type: 'url_citation',
      start_index: match.index,
      end_index: match.index + match[0].length,
      url: ref.url,
      title: ref.title ?? ref.url,
    });
  }
  return annotations;
}

export function responseJson(
  result: CanonicalResult,
  options: { id?: string; previousResponseId?: string | null } = {},
) {
  const id = options.id ?? `resp_${crypto.randomUUID().replaceAll('-', '')}`;
  const output: Record<string, unknown>[] = [];
  for (const searchCall of result.web_search_calls ?? []) {
    output.push(searchCall);
  }
  const exposeReasoningSummary = result.reasoning && shouldExposeReasoningSummary();
  if (exposeReasoningSummary) {
    output.push({
      id: `rs_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: result.reasoning }],
    });
  }
  if (result.text) {
    output.push({
      id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: result.text, annotations: annotationsFromWebSearch(result, result.text) }],
    });
  }
  for (const toolCall of result.tool_calls) {
    if (toolCall.client_type === 'custom') {
      output.push({
        id: `cc_${toolCall.id}`,
        type: 'custom_tool_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.function.name,
        input: customToolInput(toolCall.function.arguments),
      });
    } else {
      output.push({
        id: `fc_${toolCall.id}`,
        type: 'function_call',
        status: 'completed',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }
  }
  const status = result.finish_reason === 'length' ? 'incomplete' : 'completed';
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    max_output_tokens: null,
    model: result.model,
    output,
    output_text: result.text,
    parallel_tool_calls: true,
    previous_response_id: options.previousResponseId ?? null,
    reasoning: exposeReasoningSummary ? { summary: [{ type: 'summary_text', text: result.reasoning }] } : null,
    store: false,
    tools: [],
    usage: result.usage,
    metadata: {},
  };
}

function event(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function asOutputItems(response: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(response.output)
    ? response.output.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

export function responsesSseFromResponse(response: Record<string, unknown>): string {
  const responseId = String(response.id ?? `resp_${crypto.randomUUID().replaceAll('-', '')}`);
  const model = String(response.model ?? '');
  const created = typeof response.created_at === 'number' ? response.created_at : Math.floor(Date.now() / 1000);
  const shell = { ...response, id: responseId, model, created_at: created, status: 'in_progress', output: [] };
  const lines: string[] = [
    event('response.created', { type: 'response.created', response: shell }),
    event('response.in_progress', { type: 'response.in_progress', response: shell }),
  ];
  asOutputItems(response).forEach((item, outputIndex) => {
    if (item.type === 'message') {
      const itemId = String(item.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`);
      const content = Array.isArray(item.content) ? item.content : [];
      const textPart = content.find(
        (part) => !!part && typeof part === 'object' && (part as Record<string, unknown>).type === 'output_text',
      ) as Record<string, unknown> | undefined;
      const text = typeof textPart?.text === 'string' ? textPart.text : '';
      lines.push(
        event('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { ...item, id: itemId, status: 'in_progress', content: [] },
        }),
      );
      lines.push(
        event('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        }),
      );
      if (text) {
        lines.push(
          event('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: itemId,
            output_index: outputIndex,
            content_index: 0,
            delta: text,
            response_id: responseId,
          }),
        );
      }
      lines.push(
        event('response.output_text.done', {
          type: 'response.output_text.done',
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          text,
          response_id: responseId,
        }),
      );
      lines.push(
        event('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: textPart ?? { type: 'output_text', text },
        }),
      );
      lines.push(
        event('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item }),
      );
    } else if (item.type === 'function_call') {
      lines.push(
        event('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { ...item, status: 'in_progress', arguments: '' },
        }),
      );
      const args = typeof item.arguments === 'string' ? item.arguments : '';
      if (args) {
        lines.push(
          event('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: outputIndex,
            call_id: item.call_id,
            delta: args,
          }),
        );
      }
      lines.push(
        event('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: item.id,
          output_index: outputIndex,
          call_id: item.call_id,
          name: item.name,
          arguments: args,
        }),
      );
      lines.push(
        event('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item }),
      );
    } else if (item.type === 'custom_tool_call') {
      const itemId = String(item.id ?? `cc_${crypto.randomUUID().replaceAll('-', '')}`);
      const input = typeof item.input === 'string' ? item.input : '';
      lines.push(
        event('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { ...item, id: itemId, status: 'in_progress', input: '' },
        }),
      );
      if (input) {
        lines.push(
          event('response.custom_tool_call_input.delta', {
            type: 'response.custom_tool_call_input.delta',
            item_id: itemId,
            output_index: outputIndex,
            delta: input,
          }),
        );
      }
      lines.push(
        event('response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done',
          item_id: itemId,
          output_index: outputIndex,
          input,
        }),
      );
      lines.push(
        event('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: outputIndex,
          item: { ...item, id: itemId },
        }),
      );
    } else if (item.type === 'reasoning') {
      const itemId = String(item.id ?? `rs_${crypto.randomUUID().replaceAll('-', '')}`);
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const text = summary
        .map((part) => asObject(part).text)
        .filter((value): value is string => typeof value === 'string')
        .join('');
      lines.push(
        event('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { ...item, id: itemId, status: 'in_progress', summary: [] },
        }),
      );
      lines.push(
        event('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      );
      if (text) {
        lines.push(
          event('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: itemId,
            output_index: outputIndex,
            summary_index: 0,
            delta: text,
          }),
        );
      }
      lines.push(
        event('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          text,
        }),
      );
      lines.push(
        event('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item }),
      );
    } else {
      lines.push(
        event('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item }),
      );
      lines.push(
        event('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item }),
      );
    }
  });
  const terminalEvent = response.status === 'incomplete' ? 'response.incomplete' : 'response.completed';
  lines.push(event(terminalEvent, { type: terminalEvent, response }));
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

export function responsesSseFromResult(
  result: CanonicalResult,
  options: { id?: string; previousResponseId?: string | null } = {},
): string {
  return responsesSseFromResponse(responseJson(result, options));
}

export function promptFromResponsesInput(data: unknown): string {
  return responsesRequestToCanonical(data)
    .messages.map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join('\n\n');
}
