export type ContentBlock =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } };

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type CanonicalToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  index?: number;
  client_type?: 'function' | 'custom';
  namespace?: string;
};

export type CanonicalMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'unknown';
  content: ContentBlock[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: CanonicalToolCall[];
  /** Gateway-owned provenance; never populate from client fields or serialize upstream. */
  tool_output_attachment?: { call_id: string };
};

export function isUserIntentMessage(message: CanonicalMessage): boolean {
  return message.role === 'user' && !message.tool_output_attachment;
}

export function withoutToolOutputAttachment(message: CanonicalMessage): CanonicalMessage {
  const { tool_output_attachment: _attachment, ...upstreamMessage } = message;
  return upstreamMessage;
}

export type CanonicalTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
  hosted?: boolean;
  /** Original client-visible name when canonical routing needs a flattened name. */
  client_name?: string;
  client_type?: 'function' | 'custom';
  namespace?: string;
};

export type CanonicalToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export function canonicalMessageRole(value: unknown): CanonicalMessage['role'] {
  const role = typeof value === 'string' && value ? value : 'user';
  return role === 'system' || role === 'developer' || role === 'user' || role === 'assistant' || role === 'tool'
    ? role
    : 'unknown';
}

export type CanonicalRequest = {
  model: string;
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  tool_choice?: CanonicalToolChoice;
  max_tokens?: number;
  stream?: boolean;
  session_id?: string;
  previous_response_id?: string;
  reasoning_effort?: string;
  metadata?: Record<string, unknown>;
  /** Original Responses `input` item count for request-policy validation. */
  input_item_count?: number;
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type CanonicalWebSearchCall = {
  id: string;
  type: 'web_search_call';
  status: 'in_progress' | 'completed' | 'failed';
  action: { type: 'search'; query: string; queries?: string[]; mode?: 'structured_search' | 'online_answer' };
  results: Array<{ type: 'search_result'; title?: string; url: string; snippet?: string; snippets?: string[] }>;
  references?: Array<{ title?: string; url: string; snippet?: string; snippets?: string[] }>;
};

export type CanonicalResult = {
  model: string;
  text: string;
  reasoning: string;
  tool_calls: CanonicalToolCall[];
  finish_reason: string;
  usage: Usage;
  web_search_calls?: CanonicalWebSearchCall[];
};

export type CanonicalStreamEvent =
  | { type: 'start'; model: string }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call_delta'; tool_calls: CanonicalToolCall[] }
  | { type: 'web_search'; call: CanonicalWebSearchCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'progress'; event: string; data: Record<string, unknown> }
  | { type: 'done'; finish_reason: string };

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') {
        return [];
      }
      const value = block as Record<string, unknown>;
      const type = value.type;
      if (type === 'text' || type === 'input_text' || type === 'output_text') {
        return typeof value.text === 'string' ? [value.text] : [];
      }
      if (type === 'tool_result') {
        return [textFromContent(value.content)];
      }
      return [];
    })
    .join('');
}

function imageUrlFromBlock(block: Record<string, unknown>): { url: string; detail?: string } | undefined {
  if (block.type === 'image_url') {
    const image = block.image_url;
    if (typeof image === 'string' && image) {
      return { url: image, detail: typeof block.detail === 'string' ? block.detail : undefined };
    }
    const imageObject = asObject(image);
    const url = imageObject.url;
    return typeof url === 'string' && url
      ? { url, detail: typeof imageObject.detail === 'string' ? imageObject.detail : undefined }
      : undefined;
  }
  if (block.type === 'input_image') {
    const url = block.image_url;
    if (typeof url === 'string' && url) {
      return { url, detail: typeof block.detail === 'string' ? block.detail : undefined };
    }
    const imageObject = asObject(url);
    return typeof imageObject.url === 'string' && imageObject.url
      ? { url: imageObject.url, detail: typeof imageObject.detail === 'string' ? imageObject.detail : undefined }
      : undefined;
  }
  if (block.type === 'image') {
    const source = asObject(block.source);
    if (source.type === 'url' && typeof source.url === 'string' && source.url) {
      return { url: source.url };
    }
    if (source.type === 'base64' && typeof source.data === 'string' && source.data) {
      return {
        url: `data:${typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream'};base64,${source.data}`,
      };
    }
  }
  return undefined;
}

export function contentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: 'text', text: '' }];
  }
  const blocks: ContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const block = raw as Record<string, unknown>;
    const type = block.type;
    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      if (typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      }
    } else if (type === 'image_url' || type === 'input_image' || type === 'image') {
      const image = imageUrlFromBlock(block);
      if (image) {
        blocks.push({ type: 'image_url', image_url: image });
      }
    } else if (type === 'tool_result') {
      const text = textFromContent(block.content);
      if (text) {
        blocks.push({ type: 'text', text });
      }
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

export function textBlocks(content: unknown): ContentBlock[] {
  return [{ type: 'text', text: textFromContent(content) }];
}

export function toolOutputMessages(output: unknown, callId: string): CanonicalMessage[] {
  const images = contentBlocks(output).filter(
    (block): block is Extract<ContentBlock, { type: 'image_url' }> => block.type === 'image_url',
  );
  if (!images.length) {
    return [{ role: 'tool', tool_call_id: callId, content: textBlocks(output) }];
  }

  const text = textFromContent(output);
  return [
    {
      role: 'user',
      tool_output_attachment: { call_id: callId },
      content: [{ type: 'text', text: 'Image returned by the preceding tool call.' }, ...images],
    },
    {
      role: 'tool',
      tool_call_id: callId,
      content: textBlocks(text || 'Image tool output attached in the preceding user message.'),
    },
  ];
}

export function fillToolResultNames(messages: CanonicalMessage[]): CanonicalMessage[] {
  const namesByCallId = new Map<string, string>();
  return messages.map((message) => {
    for (const call of message.tool_calls ?? []) {
      if (call.id && call.function.name) {
        namesByCallId.set(call.id, call.function.name);
      }
    }
    if (message.role === 'tool' && message.tool_call_id && !message.name) {
      const name = namesByCallId.get(message.tool_call_id);
      if (name) {
        return { ...message, name };
      }
    }
    return message;
  });
}
