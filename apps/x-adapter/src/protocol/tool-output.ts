import { CanonicalMessage, textFromContent } from './canonical.js';

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 30_000;

export function maxToolOutputChars(): number {
  const raw = process.env.X_ADAPTER_MAX_TOOL_OUTPUT_CHARS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_TOOL_OUTPUT_CHARS;
}

export function truncateToolOutput(text: string, limit = maxToolOutputChars()): string {
  if (limit === 0 || text.length <= limit) {
    return text;
  }
  const marker = '\n...[truncated by x-adapter]\n';
  if (limit <= marker.length) {
    return marker.slice(0, limit);
  }
  const remaining = limit - marker.length;
  const prefixLength = Math.ceil(remaining / 2);
  return `${text.slice(0, prefixLength)}${marker}${text.slice(text.length - (remaining - prefixLength))}`;
}

/** Bound the combined text of one result while leaving images and block order intact. */
export function truncateToolOutputContent(content: unknown, limit = maxToolOutputChars()): unknown {
  if (typeof content === 'string') {
    return truncateToolOutput(content, limit);
  }
  const text = textFromContent(content);
  if (!Array.isArray(content) || limit === 0 || text.length <= limit) {
    return content;
  }
  const marker = '\n...[truncated by x-adapter]\n'.slice(0, limit);
  const remaining = limit - marker.length;
  const prefixEnd = Math.ceil(remaining / 2);
  const tailStart = text.length - Math.floor(remaining / 2);
  let offset = 0;
  let marked = false;
  const rewrite = (blocks: unknown): unknown => {
    if (typeof blocks === 'string') {
      const start = offset;
      offset += blocks.length;
      let result = blocks.slice(0, Math.max(0, prefixEnd - start));
      if (!marked && offset > prefixEnd && start < tailStart) {
        result += marker;
        marked = true;
      }
      if (offset > tailStart) {
        result += blocks.slice(Math.max(0, tailStart - start));
      }
      return result;
    }
    if (!Array.isArray(blocks)) {
      return blocks;
    }
    return blocks.map((raw) => {
      if (!raw || typeof raw !== 'object') {
        return raw;
      }
      const block = raw as Record<string, unknown>;
      if (['text', 'input_text', 'output_text'].includes(String(block.type)) && typeof block.text === 'string') {
        return { ...block, text: rewrite(block.text) };
      }
      if (block.type === 'tool_result' && (typeof block.content === 'string' || Array.isArray(block.content))) {
        return { ...block, content: rewrite(block.content) };
      }
      return raw;
    });
  };
  return rewrite(content);
}

/** Return bounded copies of canonical tool-result messages before they reach an upstream provider. */
export function truncateCanonicalToolOutputs(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') {
      return message;
    }
    const content = truncateToolOutputContent(message.content) as CanonicalMessage['content'];
    return content === message.content ? message : { ...message, content };
  });
}

/**
 * Responses history currently retains the client-shaped input. Bound known tool-output
 * fields before storing it so replay cannot retain an unbounded duplicate of a result.
 */
export function truncateResponsesInputToolOutputs(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }
  return input.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return raw;
    }
    const item = raw as Record<string, unknown>;
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') {
      return raw;
    }
    const output = truncateToolOutputContent(item.output);
    return output === item.output ? raw : { ...item, output };
  });
}
