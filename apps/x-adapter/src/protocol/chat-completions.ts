import { defaultOpenAiModel } from '../config/env.js';
import {
  canonicalMessageRole,
  CanonicalMessage,
  CanonicalResult,
  contentBlocks,
  textFromContent,
} from './canonical.js';
import { shouldExposeRawReasoning, toReasoningEffort } from './reasoning.js';
import { normalizeToolChoice, openAiToolsToCanonical } from './tools.js';
import { truncateCanonicalToolOutputs } from './tool-output.js';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function chatRequestToCanonical(data: unknown) {
  const body = asObject(data);
  const messagesRaw = Array.isArray(body.messages) ? body.messages : [];
  const messages: CanonicalMessage[] = messagesRaw.flatMap((raw) => {
    const message = asObject(raw);
    const role = canonicalMessageRole(message.role);
    const item: CanonicalMessage = { role, content: contentBlocks(message.content) };
    if (typeof message.name === 'string') {
      item.name = message.name;
    }
    if (typeof message.tool_call_id === 'string') {
      item.tool_call_id = message.tool_call_id;
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      item.tool_calls = message.tool_calls.flatMap((rawTool, index) => {
        const tool = asObject(rawTool);
        const fn = asObject(tool.function);
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) {
          return [];
        }
        return [
          {
            id: typeof tool.id === 'string' ? tool.id : `call_${index}`,
            type: 'function' as const,
            index,
            function: {
              name,
              arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
            },
          },
        ];
      });
    }
    return [item];
  });
  const metadata = asObject(body.metadata);
  return {
    model: String(body.model || defaultOpenAiModel()),
    messages: truncateCanonicalToolOutputs(messages),
    tools: openAiToolsToCanonical(body.tools),
    tool_choice: normalizeToolChoice(body.tool_choice),
    max_tokens: Number.isInteger(Number(body.max_tokens)) ? Number(body.max_tokens) : undefined,
    stream: body.stream === true,
    reasoning_effort: toReasoningEffort(body.reasoning_effort),
    session_id: typeof metadata.session_id === 'string' ? metadata.session_id : undefined,
    previous_response_id: typeof body.previous_response_id === 'string' ? body.previous_response_id : undefined,
    metadata: {
      ...metadata,
      ...(body.conversation_id !== undefined ? { conversation_id: body.conversation_id } : {}),
      ...(body.chat_id !== undefined ? { chat_id: body.chat_id } : {}),
      ...(body.user !== undefined ? { user: body.user } : {}),
    },
  };
}

export function chatCompletionJson(result: CanonicalResult, options: { id?: string } = {}) {
  const toolCalls = result.tool_calls.map((toolCall) => ({
    id: toolCall.id,
    type: 'function',
    function: { ...toolCall.function },
  }));
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: result.text || (toolCalls.length ? null : ''),
  };
  if (result.reasoning && shouldExposeRawReasoning()) {
    message.reasoning_content = result.reasoning;
  }
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }
  return {
    id: options.id ?? `chatcmpl-${crypto.randomUUID().replaceAll('-', '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : result.finish_reason || 'stop' }],
    usage: {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
      total_tokens: result.usage.total_tokens,
    },
  };
}

export function chatCompletionsStartChunk(id: string, created: number, model: string) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
}

export function chatCompletionsDeltaChunk(id: string, created: number, model: string, delta: Record<string, unknown>) {
  return { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] };
}

export function chatCompletionsDoneChunk(id: string, created: number, model: string, result: CanonicalResult) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      { index: 0, delta: {}, finish_reason: result.tool_calls.length ? 'tool_calls' : result.finish_reason || 'stop' },
    ],
    usage: {
      prompt_tokens: result.usage.input_tokens,
      completion_tokens: result.usage.output_tokens,
      total_tokens: result.usage.total_tokens,
    },
  };
}

export function chatCompletionsSseFromResult(result: CanonicalResult): string {
  const completion = chatCompletionJson(result);
  const id = completion.id;
  const created = completion.created;
  const lines: string[] = [];
  const emit = (payload: unknown) => lines.push(`data: ${JSON.stringify(payload)}\n\n`);
  emit(chatCompletionsStartChunk(id, created, result.model));
  if (result.reasoning && shouldExposeRawReasoning()) {
    emit(chatCompletionsDeltaChunk(id, created, result.model, { reasoning_content: result.reasoning }));
  }
  if (result.text) {
    emit(chatCompletionsDeltaChunk(id, created, result.model, { content: result.text }));
  }
  for (const toolCall of result.tool_calls) {
    emit(
      chatCompletionsDeltaChunk(id, created, result.model, {
        tool_calls: [{ index: toolCall.index ?? 0, id: toolCall.id, type: 'function', function: toolCall.function }],
      }),
    );
  }
  emit(chatCompletionsDoneChunk(id, created, result.model, result));
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

export function promptFromMessages(messages: CanonicalMessage[]): string {
  return messages
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join('\n\n');
}
