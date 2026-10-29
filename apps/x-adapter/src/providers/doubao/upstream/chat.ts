import { boolEnv, createDoubaoStreamWatchdog, intEnv } from '../config/env.js';
import { doubaoToolBoundaryError } from '../local-runtime-capability.js';
import { log } from '../../../logging/jsonl.js';
import {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResult,
  CanonicalStreamEvent,
} from '../../../protocol/canonical.js';
import { getDoubaoModelCatalog, resolveDoubaoModel } from '../models/catalog.js';
import {
  DoubaoSession,
  DoubaoSessionStore,
  KeyedSerialQueue,
  resolveDoubaoSessionKey,
} from '../state/session-store.js';
import { FetchLike } from './client.js';
import { doubaoEvents } from './events.js';
import { modifyConversation, pullConversationState, reasoningEffort, startCompletion } from './protocol.js';
import { DoubaoCredential } from '../auth/doubao-cookie.js';

const sessionStore = new DoubaoSessionStore({
  ttlMs: intEnv('DOUBAO_SESSION_TTL_MS', 6 * 60 * 60 * 1000),
  maxEntries: intEnv('DOUBAO_SESSION_MAX_ENTRIES', 200),
});
const conversationQueue = new KeyedSerialQueue();

export async function* streamDoubaoChat(
  credential: DoubaoCredential,
  request: CanonicalRequest,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalStreamEvent> {
  const queue = new AsyncEventQueue<CanonicalStreamEvent>();
  void executeDoubao(credential, request, fetchImpl, signal, (event) => queue.push(event)).then(
    () => queue.close(),
    (error) => queue.fail(error),
  );
  yield* queue;
}

export async function runDoubaoChat(
  credential: DoubaoCredential,
  request: CanonicalRequest,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<CanonicalResult> {
  let text = '';
  let reasoning = '';
  let finishReason = 'stop';
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  await executeDoubao(credential, request, fetchImpl, signal, (event) => {
    if (event.type === 'text') {
      text += event.delta;
    } else if (event.type === 'reasoning') {
      reasoning += event.delta;
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'done') {
      finishReason = event.finish_reason;
    }
  });
  return { model: request.model, text, reasoning, tool_calls: [], finish_reason: finishReason, usage };
}

async function executeDoubao(
  credential: DoubaoCredential,
  request: CanonicalRequest,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  emit: (event: CanonicalStreamEvent) => void,
): Promise<void> {
  if (request.tools?.length) {
    throw doubaoToolBoundaryError('Doubao Work currently supports text-only requests; tools are not supported.');
  }
  if (request.messages.some((message) => message.content.some((block) => block.type !== 'text'))) {
    const error = new Error('Doubao Work currently supports text-only message content.');
    (error as NodeJS.ErrnoException).code = 'unsupported_multimodal_content';
    throw error;
  }
  if (boolEnv('DOUBAO_MOCK', false)) {
    emit({ type: 'start', model: request.model });
    emit({ type: 'text', delta: 'PONG' });
    emit({ type: 'usage', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
    emit({ type: 'done', finish_reason: 'stop' });
    return;
  }
  const catalog = await getDoubaoModelCatalog(credential, fetchImpl);
  const selectedModel = resolveDoubaoModel(catalog, request.model);
  const effort = reasoningEffort(request.reasoning_effort, selectedModel.defaultReasoningLevel);
  const upstreamConversationId =
    typeof request.metadata?.conversation_id === 'string' ? request.metadata.conversation_id.trim() : '';
  const sessionKey = resolveDoubaoSessionKey(request) || `ephemeral:${Date.now()}:${Math.random()}`;
  if (upstreamConversationId && !sessionStore.get(sessionKey)) {
    sessionStore.set(sessionKey, {
      conversationId: upstreamConversationId,
      sectionId: '',
      lastMessageIndex: 0,
      modelItemKey: '',
      reasoningEffort: 0,
    });
  }
  const existing = sessionStore.get(sessionKey);
  const lockKey = existing?.conversationId || sessionKey;
  await conversationQueue.run(lockKey, async () => {
    // One watchdog per turn. It governs only the long-lived completion request and
    // its stream, and re-arms on every observable progress event; the short
    // pre-stream calls keep their own total timeout.
    const watchdog = createDoubaoStreamWatchdog(signal);
    let acknowledged: Pick<DoubaoSession, 'conversationId' | 'sectionId' | 'lastMessageIndex'> | undefined;
    let reusedSession = false;
    try {
      let session = sessionStore.get(sessionKey);
      reusedSession = Boolean(session);
      if (session) {
        const latest = await pullConversationState(credential, session.conversationId, fetchImpl, signal);
        session = { ...session, ...latest };
        await modifyConversation(credential, session, selectedModel, effort, fetchImpl, signal);
        session = { ...session, modelItemKey: selectedModel.modelItemKey, reasoningEffort: effort };
        sessionStore.set(sessionKey, session);
      }
      const prompt = promptForDoubao(request, Boolean(session));
      if (!prompt) {
        const error = new Error('Doubao Work requires at least one non-empty text message.');
        (error as NodeJS.ErrnoException).code = 'invalid_input';
        throw error;
      }
      const response = await startCompletion({
        credential,
        prompt,
        model: selectedModel,
        effort,
        session,
        fetchImpl,
        signal,
        streamSignal: watchdog.signal,
      });
      watchdog.arm();
      emit({ type: 'start', model: request.model });
      for await (const output of doubaoEvents(response.body!, request.model, watchdog.arm)) {
        if (output.type === 'canonical') {
          emit(output.event);
        } else if (output.type === 'activity') {
          // Doubao executes tools itself and reports the work as a stream block.
          // Record only bounded, non-content fields: the block summary is derived
          // from tool output and must not enter logs.
          log('info', 'doubao upstream tool activity', {
            model: request.model,
            block: output.activity.block,
            block_id: output.activity.blockId,
            status: output.activity.status,
          });
        } else {
          acknowledged = output.session;
          if (acknowledged.conversationId) {
            sessionStore.set(sessionKey, {
              conversationId: acknowledged.conversationId,
              sectionId: acknowledged.sectionId,
              lastMessageIndex: acknowledged.lastMessageIndex,
              modelItemKey: selectedModel.modelItemKey,
              reasoningEffort: effort,
            });
          }
        }
      }
    } catch (error) {
      if (!reusedSession && !acknowledged?.conversationId) {
        sessionStore.delete(sessionKey);
      }
      if (watchdog.tripped()) {
        const stalled = new Error('Doubao upstream stream stalled without observable agent progress.');
        (stalled as NodeJS.ErrnoException).code = 'upstream_stream_truncated';
        throw stalled;
      }
      throw error;
    } finally {
      watchdog.dispose();
    }
  });
}

export function promptForDoubao(request: CanonicalRequest, reusedSession: boolean): string {
  if (reusedSession) {
    return latestUserText(request.messages) || messagesToPrompt(request.messages);
  }
  return messagesToPrompt(request.messages);
}

function latestUserText(messages: CanonicalMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') {
      continue;
    }
    const text = contentText(message).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function messagesToPrompt(messages: CanonicalMessage[]): string {
  const names: Record<string, string> = {
    system: '系统指令',
    developer: '开发者指令',
    user: '用户消息',
    assistant: '助手历史回复',
    tool: '工具结果',
  };
  return messages
    .map((message) => ({ role: names[message.role] ?? message.role, text: contentText(message).trim() }))
    .filter((message) => message.text)
    .map((message) => `${message.role}:\n${message.text}`)
    .join('\n\n');
}

function contentText(message: CanonicalMessage): string {
  return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    this.values.push(value);
    this.waiters.shift()?.resolve();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()?.resolve();
    }
  }

  fail(error: unknown): void {
    this.failure = error;
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()?.reject(error);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.values.length) {
        yield this.values.shift()!;
        continue;
      }
      if (this.failure) {
        throw this.failure;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
  }
}

export const __testHooks = { sessionStore, conversationQueue };
