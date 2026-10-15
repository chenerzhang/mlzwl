import { CanonicalMessage, textFromContent } from './canonical.js';

export function estimateInputTokens(data: { system?: unknown; messages?: unknown; tools?: unknown; input?: unknown }): {
  input_tokens: number;
} {
  const parts: string[] = [];
  let messageCount = 0;
  if (data.system !== undefined) {
    parts.push(textFromContent(data.system));
  }
  if (typeof data.input === 'string') {
    parts.push(data.input);
  }
  if (Array.isArray(data.input)) {
    for (const item of data.input) {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        parts.push(textFromContent(record.content ?? record.text));
        messageCount += 1;
      }
    }
  }
  if (Array.isArray(data.messages)) {
    for (const raw of data.messages) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const msg = raw as CanonicalMessage | Record<string, unknown>;
      parts.push(textFromContent((msg as Record<string, unknown>).content));
      messageCount += 1;
    }
  }
  if (data.tools !== undefined) {
    try {
      parts.push(JSON.stringify(data.tools));
    } catch {
      // ignore unserializable tool metadata
    }
  }
  const chars = parts.join('').length;
  return { input_tokens: Math.max(1, Math.ceil(chars / 3.5) + messageCount * 4) };
}
