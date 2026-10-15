import { intEnv } from '../config/env.js';
import {
  canonicalMessageRole,
  CanonicalMessage,
  contentBlocks,
  textBlocks,
  textFromContent,
  toolOutputMessages,
} from '../protocol/canonical.js';
import { truncateCanonicalToolOutputs, truncateResponsesInputToolOutputs } from '../protocol/tool-output.js';
import { canonicalMessageBytes, jsonSize, maxContextBytes } from '../protocol/validation.js';

export type ResponseRecord = {
  id: string;
  sessionId: string;
  provider?: string;
  previousResponseId?: string | null;
  request: {
    instructions?: string;
    input?: unknown;
    model?: string;
  };
  output: unknown[];
  createdAt: number;
};

export type ReplayResult = {
  messages: CanonicalMessage[];
  warnings: Array<{ type: string; response_id?: string; detail?: string }>;
  rootResponseId?: string;
};

type SessionBucket = {
  records: Map<string, { record: ResponseRecord; bytes: number }>;
  bytes: number;
  lastAccessAt: number;
  lastAccessOrder: number;
};

const sessions = new Map<string, SessionBucket>();
let accessOrder = 0;
let totalBytes = 0;

function touch(bucket: SessionBucket): void {
  bucket.lastAccessAt = Date.now();
  bucket.lastAccessOrder = ++accessOrder;
}
const DEFAULT_SESSION_ID = 'default';
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_RECORDS_PER_SESSION = 200;
const DEFAULT_MAX_REPLAY_RESPONSES = 50;
const DEFAULT_MAX_REPLAY_CHARS = 200_000;

function historyLimit(name: string, fallback: number): number {
  const value = intEnv(name, fallback);
  return value >= 0 ? value : fallback;
}

function maxHistoryBytes(): number {
  return historyLimit('X_ADAPTER_RESPONSE_HISTORY_MAX_TOTAL_BYTES', 128 * 1024 * 1024);
}

function deleteSession(sessionId: string): void {
  const bucket = sessions.get(sessionId);
  if (bucket) {
    totalBytes -= bucket.bytes;
    sessions.delete(sessionId);
  }
}

function deleteRecord(bucket: SessionBucket, id: string): void {
  const entry = bucket.records.get(id);
  if (entry) {
    bucket.records.delete(id);
    bucket.bytes -= entry.bytes;
    totalBytes -= entry.bytes;
  }
}

function maxSessions(): number {
  return historyLimit('X_ADAPTER_RESPONSE_HISTORY_MAX_SESSIONS', DEFAULT_MAX_SESSIONS);
}

function maxRecordsPerSession(): number {
  return historyLimit('X_ADAPTER_RESPONSE_HISTORY_MAX_RECORDS_PER_SESSION', DEFAULT_MAX_RECORDS_PER_SESSION);
}

function maxReplayResponses(): number {
  return historyLimit('X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_RESPONSES', DEFAULT_MAX_REPLAY_RESPONSES);
}

function maxReplayChars(): number {
  return historyLimit('X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_CHARS', DEFAULT_MAX_REPLAY_CHARS);
}

function sessionTtlMs(): number {
  return historyLimit('X_ADAPTER_RESPONSE_HISTORY_TTL_MS', 0);
}

function cleanupExpiredSessions(now = Date.now()): void {
  const ttl = sessionTtlMs();
  if (ttl <= 0) {
    return;
  }
  for (const [sessionId, bucket] of sessions) {
    if (now - bucket.lastAccessAt >= ttl) {
      deleteSession(sessionId);
    }
  }
}

function trimSessions(): void {
  const limit = maxSessions();
  const byteLimit = maxHistoryBytes();
  while ((limit > 0 && sessions.size > limit) || (byteLimit > 0 && totalBytes > byteLimit)) {
    const oldest = [...sessions.entries()].reduce<string | undefined>(
      (candidate, [sessionId, bucket]) =>
        !candidate || bucket.lastAccessOrder < sessions.get(candidate)!.lastAccessOrder ? sessionId : candidate,
      undefined,
    );
    if (!oldest) {
      return;
    }
    deleteSession(oldest);
  }
}

export function defaultSessionId(): string {
  return DEFAULT_SESSION_ID;
}

export function clearResponseHistory(): void {
  sessions.clear();
  accessOrder = 0;
  totalBytes = 0;
}

function sessionBucket(sessionId: string): SessionBucket {
  cleanupExpiredSessions();
  const key = sessionId || DEFAULT_SESSION_ID;
  let bucket = sessions.get(key);
  if (!bucket) {
    bucket = { records: new Map(), bytes: 0, lastAccessAt: Date.now(), lastAccessOrder: 0 };
    touch(bucket);
    sessions.set(key, bucket);
    return bucket;
  }
  touch(bucket);
  return bucket;
}

function existingSessionBucket(sessionId: string): SessionBucket | undefined {
  cleanupExpiredSessions();
  const bucket = sessions.get(sessionId || DEFAULT_SESSION_ID);
  if (bucket) {
    touch(bucket);
  }
  return bucket;
}

export function recordResponse(record: ResponseRecord): void {
  cleanupExpiredSessions();
  const bounded: ResponseRecord = {
    ...record,
    request: { ...record.request, input: truncateResponsesInputToolOutputs(record.request.input) },
    output: truncateResponsesInputToolOutputs(record.output) as unknown[],
  };
  const bytes = jsonSize(bounded);
  const byteLimit = maxHistoryBytes();
  // Do not evict healthy sessions or fail an already completed response for an uncacheable record.
  if (byteLimit > 0 && bytes > byteLimit) {
    const existing = sessions.get(record.sessionId || DEFAULT_SESSION_ID);
    if (existing) {
      deleteRecord(existing, record.id);
    }
    return;
  }
  const bucket = sessionBucket(record.sessionId);
  deleteRecord(bucket, record.id);
  bucket.records.set(record.id, { record: structuredCloneSafe(bounded), bytes });
  bucket.bytes += bytes;
  totalBytes += bytes;
  const limit = maxRecordsPerSession();
  while (limit > 0 && bucket.records.size > limit) {
    const first = bucket.records.keys().next().value;
    if (!first) {
      break;
    }
    deleteRecord(bucket, first);
  }
  // Keep the newest record when a single session exceeds the global byte budget.
  while (byteLimit > 0 && bucket.bytes > byteLimit) {
    deleteRecord(bucket, bucket.records.keys().next().value!);
  }
  trimSessions();
}

export function getResponseRecord(sessionId: string, responseId: string): ResponseRecord | undefined {
  const entry = existingSessionBucket(sessionId)?.records.get(responseId);
  return entry ? structuredCloneSafe(entry.record) : undefined;
}

/** Internal references only; callers must not mutate or expose cached records. */
function responseChain(
  sessionId: string,
  previousResponseId: string,
): { records: ResponseRecord[]; warnings: ReplayResult['warnings'] } {
  const bucket = existingSessionBucket(sessionId);
  const warnings: ReplayResult['warnings'] = [];
  if (!bucket) {
    return { records: [], warnings: [{ type: 'missing_previous_response', response_id: previousResponseId }] };
  }
  const records: ResponseRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined | null = previousResponseId;
  while (cursor) {
    if (seen.has(cursor)) {
      warnings.push({ type: 'response_chain_cycle', response_id: cursor });
      break;
    }
    seen.add(cursor);
    const record: ResponseRecord | undefined = bucket.records.get(cursor)?.record;
    if (!record) {
      warnings.push({ type: 'missing_previous_response', response_id: cursor });
      break;
    }
    records.push(record);
    const responseLimit = maxReplayResponses();
    if (responseLimit > 0 && records.length >= responseLimit && record.previousResponseId) {
      warnings.push({
        type: 'response_chain_truncated',
        response_id: cursor,
        detail: `kept ${responseLimit} responses`,
      });
      break;
    }
    cursor = record.previousResponseId;
  }
  records.reverse();
  return { records, warnings };
}

export function collectResponseChain(
  sessionId: string,
  previousResponseId: string,
): { records: ResponseRecord[]; warnings: ReplayResult['warnings'] } {
  const chain = responseChain(sessionId, previousResponseId);
  return { records: chain.records.map(structuredCloneSafe), warnings: chain.warnings };
}

function inputToMessages(input: unknown): CanonicalMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: textBlocks(input) }];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((raw): CanonicalMessage[] => {
    if (!raw || typeof raw !== 'object') {
      return [];
    }
    const item = raw as Record<string, unknown>;
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      return toolOutputMessages(item.output, callId);
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const name = typeof item.name === 'string' ? item.name : '';
      const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : '';
      const args =
        typeof item.arguments === 'string'
          ? item.arguments
          : typeof item.input === 'string'
            ? JSON.stringify({ input: item.input })
            : '{}';
      return name && callId
        ? [
            {
              role: 'assistant',
              content: textBlocks(''),
              tool_calls: [
                {
                  id: callId,
                  type: 'function',
                  client_type: item.type === 'custom_tool_call' ? 'custom' : 'function',
                  function: { name, arguments: args },
                },
              ],
            },
          ]
        : [];
    }
    if (item.type === 'message' || item.role || item.content !== undefined) {
      return [{ role: canonicalMessageRole(item.role), content: contentBlocks(item.content) }];
    }
    return [];
  });
}

function outputToMessages(output: unknown[]): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [];
  for (const raw of output) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (item.type === 'message') {
      messages.push({ role: item.role === 'user' ? 'user' : 'assistant', content: contentBlocks(item.content) });
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const name = typeof item.name === 'string' ? item.name : '';
      const callId = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : '';
      const args =
        typeof item.arguments === 'string'
          ? item.arguments
          : typeof item.input === 'string'
            ? JSON.stringify({ input: item.input })
            : '{}';
      if (name && callId) {
        messages.push({
          role: 'assistant',
          content: textBlocks(''),
          tool_calls: [
            {
              id: callId,
              type: 'function',
              client_type: item.type === 'custom_tool_call' ? 'custom' : 'function',
              function: { name, arguments: args },
            },
          ],
        });
      }
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      messages.push(...toolOutputMessages(item.output, callId));
    }
  }
  return messages;
}

export function replayMessagesForPreviousResponse(
  sessionId: string,
  previousResponseId?: string | null,
  provider?: string,
): ReplayResult {
  if (!previousResponseId) {
    return { messages: [], warnings: [] };
  }
  const { records, warnings } = responseChain(sessionId, previousResponseId);
  if (provider && records.some((record) => record.provider && record.provider !== provider)) {
    return {
      messages: [],
      warnings: [
        ...warnings,
        {
          type: 'previous_response_provider_mismatch',
          response_id: previousResponseId,
          detail: `Response history belongs to a different provider than ${provider}.`,
        },
      ],
    };
  }
  const messages: CanonicalMessage[] = [];
  let chars = 0;
  let bytes = 2;
  const byteLimit = maxContextBytes();
  for (const record of records) {
    const recordMessages = truncateCanonicalToolOutputs([
      ...(record.request.instructions
        ? [{ role: 'system' as const, content: textBlocks(record.request.instructions) }]
        : []),
      ...inputToMessages(record.request.input),
      ...outputToMessages(record.output),
    ]);
    for (const message of recordMessages) {
      const size = textFromContent(message.content).length;
      const charLimit = maxReplayChars();
      bytes += canonicalMessageBytes(message) + (messages.length ? 1 : 0);
      if (byteLimit > 0 && bytes > byteLimit) {
        return {
          messages: [],
          warnings: [...warnings, { type: 'response_replay_bytes_exceeded', response_id: record.id }],
        };
      }
      if (charLimit > 0 && chars + size > charLimit) {
        warnings.push({
          type: 'response_replay_chars_truncated',
          response_id: record.id,
          detail: `kept ${chars} chars`,
        });
        return { messages: structuredCloneSafe(messages), warnings };
      }
      chars += size;
      messages.push(message);
    }
  }
  return { messages: structuredCloneSafe(messages), warnings, rootResponseId: records[0]?.id };
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
