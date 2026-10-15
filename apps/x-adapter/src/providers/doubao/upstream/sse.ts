import { intEnv } from '../config/env.js';

export type SseEvent = {
  event: string;
  data: string;
};

export function maxSseEventBytes(): number {
  return intEnv('X_ADAPTER_DOUBAO_MAX_SSE_EVENT_BYTES', 1_048_576);
}

export function assertSseEventSize(text: string, limit = maxSseEventBytes()): void {
  if (limit > 0 && Buffer.byteLength(text, 'utf8') > limit) {
    const error = new Error(`SSE event exceeds ${limit} bytes.`);
    (error as NodeJS.ErrnoException).code = 'sse_event_too_large';
    throw error;
  }
}

export function parseSseText(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event = 'message';
  let data: string[] = [];

  function flush(): void {
    if (data.length === 0) {
      event = 'message';
      return;
    }
    const joined = data.join('\n');
    assertSseEventSize(joined);
    events.push({ event, data: joined });
    event = 'message';
    data = [];
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  flush();
  return events;
}

export async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const rawEvent = buffer.slice(0, match.index);
        assertSseEventSize(rawEvent);
        buffer = buffer.slice(match.index + match[0].length);
        for (const event of parseSseText(`${rawEvent}\n\n`)) {
          yield event;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      assertSseEventSize(buffer);
      for (const event of parseSseText(buffer)) {
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function jsonFromSseData(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
