import { intEnv } from '../config/env.js';
import { CanonicalMessage, CanonicalRequest, withoutToolOutputAttachment } from './canonical.js';

const INTERNAL_WEB_SEARCH_TOOL_NAME = '__x_connect_web_search';

export type ValidationError = {
  message: string;
  code: string;
  param?: string;
  status: 400;
};

export function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? ''), 'utf8');
  } catch {
    return Buffer.byteLength(String(value ?? ''), 'utf8');
  }
}

function estimatedDataUrlBytes(url: string): number | undefined {
  const match = /^data:[^,]*;base64,(.*)$/is.exec(url);
  if (!match) {
    return undefined;
  }
  const base64 = match[1].replace(/\s+/g, '');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** Serialized canonical messages, not decoded image bytes or provider-specific wire framing. */
export function maxContextBytes(): number {
  const value = intEnv('X_ADAPTER_MAX_CONTEXT_BYTES', 32 * 1024 * 1024);
  return value >= 0 ? value : 32 * 1024 * 1024;
}

export function canonicalMessageBytes(message: CanonicalMessage): number {
  return jsonSize(withoutToolOutputAttachment(message));
}

export function validateContextSize(messages: CanonicalMessage[]): ValidationError | undefined {
  const limit = maxContextBytes();
  if (limit === 0) {
    return undefined;
  }
  let bytes = 2; // JSON array brackets
  for (const [index, message] of messages.entries()) {
    bytes += canonicalMessageBytes(message) + (index ? 1 : 0);
    if (bytes > limit) {
      return {
        status: 400,
        code: 'context_too_large',
        message: `Serialized message context exceeds the limit of ${limit} bytes; reduce input or start a new conversation.`,
        param: 'messages',
      };
    }
  }
  return undefined;
}

export function validateCanonicalRequest(request: CanonicalRequest): ValidationError | undefined {
  const maxInputItems = intEnv('X_ADAPTER_MAX_INPUT_ITEMS', 0);
  if (maxInputItems > 0 && request.input_item_count !== undefined && request.input_item_count > maxInputItems) {
    return {
      status: 400,
      code: 'too_many_input_items',
      message: `input has ${request.input_item_count} items, exceeding the limit of ${maxInputItems}.`,
      param: 'input',
    };
  }
  const maxMetadataBytes = intEnv('X_ADAPTER_MAX_METADATA_BYTES', 0);
  if (maxMetadataBytes > 0 && jsonSize(request.metadata) > maxMetadataBytes) {
    return {
      status: 400,
      code: 'metadata_too_large',
      message: `metadata is ${jsonSize(request.metadata)} bytes, exceeding the limit of ${maxMetadataBytes}.`,
      param: 'metadata',
    };
  }
  const hostedTools = (request.tools ?? []).filter((tool) => tool.hosted);
  if (hostedTools.length && request.model.startsWith('doubao-')) {
    return {
      status: 400,
      code: 'unsupported_hosted_tool',
      message: 'Doubao Work does not support hosted tools.',
      param: 'tools',
    };
  }
  if (hostedTools.length && request.model.startsWith('trae-')) {
    return {
      status: 400,
      code: 'unsupported_hosted_search',
      message: 'Trae hosted web search is not supported by the verified Global/CN Agent protocol.',
      param: 'tools',
    };
  }
  const toolNames = new Set<string>();
  for (const tool of request.tools ?? []) {
    const name = tool.function.name;
    if (hostedTools.length && !tool.hosted && name === INTERNAL_WEB_SEARCH_TOOL_NAME) {
      return {
        status: 400,
        code: 'duplicate_tool_name',
        message: `tools cannot use reserved internal hosted-search name "${name}".`,
        param: 'tools',
      };
    }
    if (toolNames.has(name)) {
      return {
        status: 400,
        code: 'duplicate_tool_name',
        message: `tools contains duplicate canonical tool name "${name}".`,
        param: 'tools',
      };
    }
    toolNames.add(name);
  }
  const maxOutputTokens = intEnv('X_ADAPTER_MAX_OUTPUT_TOKENS', 0);
  if (request.max_tokens !== undefined) {
    if (!Number.isInteger(request.max_tokens) || request.max_tokens <= 0) {
      return {
        status: 400,
        code: 'invalid_max_output_tokens',
        message: 'max_tokens must be a positive integer.',
        param: 'max_tokens',
      };
    }
    if (maxOutputTokens > 0 && request.max_tokens > maxOutputTokens) {
      return {
        status: 400,
        code: 'max_output_tokens_too_large',
        message: `max_tokens of ${request.max_tokens} exceeds the limit of ${maxOutputTokens}.`,
        param: 'max_tokens',
      };
    }
  }
  const maxImageBytes = intEnv('X_ADAPTER_MAX_IMAGE_BYTES', 10 * 1024 * 1024);
  if (maxImageBytes > 0) {
    for (let messageIndex = 0; messageIndex < request.messages.length; messageIndex += 1) {
      const message = request.messages[messageIndex];
      for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
        const block = message.content[contentIndex];
        if (block.type !== 'image_url') {
          continue;
        }
        const inlineBytes = estimatedDataUrlBytes(block.image_url.url);
        if (inlineBytes !== undefined && inlineBytes > maxImageBytes) {
          return {
            status: 400,
            code: 'image_too_large',
            message: `image data is ${inlineBytes} bytes, exceeding the limit of ${maxImageBytes}.`,
            param: `messages[${messageIndex}].content[${contentIndex}]`,
          };
        }
      }
    }
  }

  const maxTools = intEnv('X_ADAPTER_MAX_TOOLS', 0);
  if (maxTools > 0 && (request.tools?.length ?? 0) > maxTools) {
    return {
      status: 400,
      code: 'too_many_tools',
      message: `tools has ${request.tools?.length ?? 0} entries, exceeding the limit of ${maxTools}.`,
      param: 'tools',
    };
  }
  const maxToolSchemaBytes = intEnv('X_ADAPTER_MAX_TOOL_SCHEMA_BYTES', 0);
  if (maxToolSchemaBytes > 0) {
    for (let index = 0; index < (request.tools?.length ?? 0); index += 1) {
      const size = jsonSize(request.tools?.[index].function.parameters);
      if (size > maxToolSchemaBytes) {
        return {
          status: 400,
          code: 'tool_schema_too_large',
          message: `tools[${index}] schema is ${size} bytes, exceeding the limit of ${maxToolSchemaBytes}.`,
          param: `tools[${index}]`,
        };
      }
    }
  }
  return validateContextSize(request.messages);
}
