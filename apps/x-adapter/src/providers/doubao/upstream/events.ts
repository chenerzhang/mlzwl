import { CanonicalStreamEvent } from '../../../protocol/canonical.js';
import { DoubaoSession } from '../state/session-store.js';
import { jsonFromSseData, parseSseStream, SseEvent } from './sse.js';

export type DoubaoUpstreamEvent =
  | { type: 'session'; session: Pick<DoubaoSession, 'conversationId' | 'sectionId' | 'lastMessageIndex'> }
  | { type: 'canonical'; event: CanonicalStreamEvent };

export async function* doubaoEvents(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<DoubaoUpstreamEvent> {
  const projector = new DoubaoEventProjector(model);
  for await (const event of parseSseStream(body)) {
    for (const output of projector.push(event)) {
      yield output;
    }
  }
  for (const output of projector.finish()) {
    yield output;
  }
}

export class DoubaoEventProjector {
  private deltaAnswer = '';
  private readonly fallbackBlocks = new Map<string, string>();
  private finalBrief = '';
  private sawReplyEnd = false;
  private sawDone = false;
  private activeTextKind: 'unknown' | 'answer' | 'nonanswer' = 'unknown';
  private readonly blockKinds = new Map<string, 'answer' | 'nonanswer'>();
  private readonly blockParents = new Map<string, string>();
  private emittedUsage = false;

  constructor(private readonly model: string) {}

  push(event: SseEvent): DoubaoUpstreamEvent[] {
    const payload = jsonFromSseData(event.data);
    if ((event.event === 'STREAM_ERROR' || event.event === 'stream_error') && Object.keys(payload).length === 0) {
      const error = new Error('Doubao upstream returned an invalid stream error event.');
      (error as NodeJS.ErrnoException).code = 'upstream_sse_error';
      throw error;
    }
    if (event.event === 'STREAM_ERROR' || event.event === 'stream_error') {
      const detail = objectValue(payload.error_detail);
      const statusCode = numberValue(detail.code ?? payload.error_code ?? payload.code);
      const message = String(
        detail.message ??
          detail.msg ??
          payload.error_msg ??
          payload.message ??
          payload.msg ??
          'Doubao upstream stream error.',
      );
      const error = new Error(
        isAuthenticationCode(statusCode)
          ? 'Doubao Work credentials are invalid or expired. Run `x-adapter doubao login`.'
          : message,
      );
      (error as NodeJS.ErrnoException).code = isAuthenticationCode(statusCode)
        ? 'invalid_doubao_credentials'
        : 'upstream_sse_error';
      Object.assign(error, { statusCode });
      throw error;
    }
    if (event.event === 'SSE_ACK' || event.event === 'sse_ack') {
      const meta = objectValue(payload.ack_client_meta);
      const query = Array.isArray(payload.query_list) ? objectValue(payload.query_list[0]) : {};
      const conversationId = providerIdValue(meta.conversation_id);
      if (!conversationId) {
        return [];
      }
      return [
        {
          type: 'session',
          session: {
            conversationId,
            sectionId: providerIdValue(meta.section_id),
            lastMessageIndex: numberValue(query.message_index),
          },
        },
      ];
    }
    if (event.event === 'STREAM_MSG_NOTIFY' || event.event === 'stream_msg_notify') {
      return this.holdAnswerBlocks(objectValue(payload.content).content_block);
    }
    if (event.event === 'FULL_MSG_NOTIFY' || event.event === 'full_msg_notify') {
      const message = objectValue(payload.message);
      return numberValue(message.user_type) === 2 ? this.holdAnswerBlocks(message.content_block) : [];
    }
    if (event.event === 'CHUNK_DELTA' || event.event === 'chunk_delta') {
      const text = stringValue(payload.text);
      if (!text || this.activeTextKind === 'nonanswer') {
        return [];
      }
      // Keep deltas and answer-block snapshots independently. A completion may
      // send a suffix-only delta and then publish its complete message through
      // a later notify event, including one after SSE_REPLY_END.
      this.deltaAnswer += text;
      return [];
    }
    if (event.event === 'STREAM_CHUNK' || event.event === 'stream_chunk') {
      const operations = Array.isArray(payload.patch_op) ? payload.patch_op : [];
      for (const rawOperation of operations) {
        const operation = objectValue(rawOperation);
        if (numberValue(operation.patch_object) !== 1) {
          continue;
        }
        this.holdAnswerBlocks(objectValue(operation.patch_value).content_block);
      }
      // STREAM_CHUNK may carry cumulative snapshots that are duplicated by a
      // later CHUNK_DELTA. Hold it until reply-end, then use it only if no
      // answer CHUNK_DELTA was observed.
      return [];
    }
    if ((event.event === 'SSE_REPLY_END' || event.event === 'sse_reply_end') && numberValue(payload.end_type) === 1) {
      if (this.sawDone) {
        return [];
      }
      this.sawReplyEnd = true;
      const brief = stringValue(objectValue(payload.msg_finish_attr).brief);
      if (brief) {
        this.finalBrief = brief;
      }
      // `SSE_REPLY_END` does not guarantee that all FULL_MSG_NOTIFY snapshots
      // have arrived. Defer projection until EOF so a complete persisted answer
      // can supersede a truncated brief without emitting irreversible text.
      return [];
    }
    return [];
  }

  finish(): DoubaoUpstreamEvent[] {
    if (this.sawDone) {
      return [];
    }
    if (!this.sawReplyEnd) {
      const error = new Error('Doubao upstream stream ended before SSE_REPLY_END.');
      (error as NodeJS.ErrnoException).code = 'upstream_stream_truncated';
      throw error;
    }
    return [...this.emitText(this.finalAnswer()), ...this.complete()];
  }

  private holdAnswerBlocks(value: unknown): DoubaoUpstreamEvent[] {
    if (!Array.isArray(value)) {
      return [];
    }
    for (const rawBlock of value) {
      const block = objectValue(rawBlock);
      const blockId = providerIdValue(block.block_id) || `anonymous:${this.fallbackBlocks.size}`;
      const blockType = numberValue(block.block_type);
      const previousKind = this.blockKinds.get(blockId);
      const parentId = Object.hasOwn(block, 'parent_id')
        ? providerIdValue(block.parent_id)
        : (this.blockParents.get(blockId) ?? '');
      if (Object.hasOwn(block, 'parent_id')) {
        this.blockParents.set(blockId, parentId);
      }
      if (blockType === 10_040 || (blockType && blockType !== 10_000)) {
        this.blockKinds.set(blockId, 'nonanswer');
        this.activeTextKind = 'nonanswer';
        continue;
      }
      const content = objectValue(block.content);
      if (!Object.hasOwn(content, 'text_block')) {
        continue;
      }
      const kind = previousKind ?? (parentId ? 'nonanswer' : 'answer');
      this.blockKinds.set(blockId, kind);
      this.activeTextKind = kind;
      if (kind !== 'answer') {
        continue;
      }
      const text = stringValue(objectValue(content.text_block).text);
      if (!text) {
        continue;
      }
      this.fallbackBlocks.set(blockId, mergeSnapshot(this.fallbackBlocks.get(blockId) ?? '', text));
    }
    return [];
  }

  private finalAnswer(): string {
    const fallbackAnswer = mergeAnswerSnapshots([...this.fallbackBlocks.values()]);
    if (this.finalBrief) {
      // A persisted answer snapshot that contains the reply-end brief is more
      // complete (for example when the brief omits an introductory block or
      // ends mid-answer). Do not prefer unrelated interim snapshots.
      const completeSnapshot = [fallbackAnswer, this.deltaAnswer]
        .filter((candidate) => candidate.length > this.finalBrief.length && candidate.includes(this.finalBrief))
        .sort((left, right) => right.length - left.length)[0];
      return completeSnapshot ?? this.finalBrief;
    }
    return [this.deltaAnswer, fallbackAnswer].sort((left, right) => right.length - left.length)[0] ?? '';
  }

  private emitText(text: string): DoubaoUpstreamEvent[] {
    if (!text) {
      return [];
    }
    return [{ type: 'canonical', event: { type: 'text', delta: text } }];
  }

  private complete(): DoubaoUpstreamEvent[] {
    if (this.sawDone) {
      return [];
    }
    this.sawDone = true;
    const outputs: DoubaoUpstreamEvent[] = [];
    if (!this.emittedUsage) {
      this.emittedUsage = true;
      outputs.push({
        type: 'canonical',
        event: { type: 'usage', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
      });
    }
    outputs.push({ type: 'canonical', event: { type: 'done', finish_reason: 'stop' } });
    return outputs;
  }
}

function mergeSnapshot(current: string, candidate: string): string {
  if (!candidate) {
    return current;
  }
  if (!current || candidate.startsWith(current)) {
    return candidate;
  }
  if (current.startsWith(candidate)) {
    return current;
  }
  return candidate;
}

function mergeAnswerSnapshots(snapshots: Iterable<string>): string {
  const unique = [...new Set([...snapshots].filter(Boolean))];
  // A transient anonymous block and a later identified block can describe the
  // same answer snapshot. Keep only the more complete containing snapshot,
  // while retaining disjoint answer blocks in their original order.
  return unique
    .filter((candidate) => !unique.some((other) => other.length > candidate.length && other.includes(candidate)))
    .join('');
}

function objectValue(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function providerIdValue(value: unknown): string {
  const result = stringValue(value);
  return result === '0' ? '' : result;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function isAuthenticationCode(code: number): boolean {
  return code === 401 || code === 403 || code === 710012001;
}
