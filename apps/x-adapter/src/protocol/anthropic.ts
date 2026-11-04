import { defaultOpenAiModel } from '../config/env.js';
import {
  canonicalMessageRole,
  CanonicalMessage,
  CanonicalResult,
  anthropicUsage,
  contentBlocks,
  textBlocks,
  textFromContent,
} from './canonical.js';
import { resolveAnthropicReasoningEffort, shouldExposeReasoningSummary } from './reasoning.js';
import { anthropicToolsToCanonical, stringifyJson } from './tools.js';
import { truncateCanonicalToolOutputs } from './tool-output.js';

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function anthropicToolChoice(choice: unknown) {
  const item = asObject(choice);
  if (item.type === 'auto') {
    return 'auto' as const;
  }
  if (item.type === 'none') {
    return 'none' as const;
  }
  if (item.type === 'any') {
    return 'required' as const;
  }
  if (item.type === 'tool' && typeof item.name === 'string') {
    return { type: 'function' as const, function: { name: item.name } };
  }
  return undefined;
}

function anthropicMessagesToCanonical(messages: unknown): CanonicalMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const toolNames = new Map<string, string>();
  const result: CanonicalMessage[] = [];
  for (const raw of messages) {
    const message = asObject(raw);
    const role = canonicalMessageRole(message.role);
    const content = message.content;
    if (!Array.isArray(content)) {
      result.push({ role, content: contentBlocks(content) });
      continue;
    }
    const messageBlocks: CanonicalMessage['content'] = [];
    const toolCalls: NonNullable<CanonicalMessage['tool_calls']> = [];
    const toolResults: CanonicalMessage[] = [];
    for (const rawBlock of content) {
      const block = asObject(rawBlock);
      const type = block.type;
      if (
        type === 'text' ||
        type === 'input_text' ||
        type === 'output_text' ||
        type === 'image' ||
        type === 'image_url' ||
        type === 'input_image'
      ) {
        messageBlocks.push(...contentBlocks([block]));
      } else if (type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : `toolu_${toolCalls.length}`;
        const name = typeof block.name === 'string' ? block.name : '';
        if (id && name) {
          toolNames.set(id, name);
        }
        toolCalls.push({
          id,
          type: 'function',
          index: toolCalls.length,
          function: { name, arguments: stringifyJson(block.input) },
        });
      } else if (type === 'tool_result') {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        toolResults.push({
          role: 'tool',
          content: textBlocks(block.content),
          tool_call_id: toolUseId,
          tool_result_error: block.is_error === true,
          name: toolNames.get(toolUseId) ?? '',
        });
      }
    }
    if (role === 'assistant') {
      const item: CanonicalMessage = {
        role: 'assistant',
        content: messageBlocks.length ? messageBlocks : textBlocks(''),
      };
      if (toolCalls.length) {
        item.tool_calls = toolCalls;
      }
      result.push(item);
    } else {
      if (messageBlocks.length) {
        result.push({ role, content: messageBlocks });
      }
      result.push(...toolResults);
    }
  }
  return result;
}

export function anthropicRequestToCanonical(data: unknown) {
  const body = asObject(data);
  const messages = anthropicMessagesToCanonical(body.messages);
  const systemText = textFromContent(body.system);
  const canonicalMessages = systemText
    ? [{ role: 'system' as const, content: textBlocks(systemText) }, ...messages]
    : messages;
  const maxTokens = Number(body.max_tokens);
  const metadata = asObject(body.metadata);
  return {
    model: String(body.model || defaultOpenAiModel()),
    messages: truncateCanonicalToolOutputs(canonicalMessages),
    tools: anthropicToolsToCanonical(body.tools),
    tool_choice: anthropicToolChoice(body.tool_choice),
    max_tokens: Number.isInteger(maxTokens) ? maxTokens : undefined,
    stream: body.stream === true,
    reasoning_effort: resolveAnthropicReasoningEffort(body),
    session_id: typeof metadata.session_id === 'string' ? metadata.session_id : undefined,
    metadata,
  };
}

export function anthropicMessageJson(result: CanonicalResult, options: { id?: string } = {}) {
  const content: Record<string, unknown>[] = [];
  if (result.reasoning && shouldExposeReasoningSummary()) {
    content.push({ type: 'thinking', thinking: result.reasoning });
  }
  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }
  for (const toolCall of result.tool_calls) {
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseJsonObject(toolCall.function.arguments),
    });
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return {
    id: options.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content,
    stop_reason: result.tool_calls.length ? 'tool_use' : result.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: anthropicUsage(result.usage),
  };
}
