import { boolEnv, createDoubaoStreamWatchdog, intEnv } from '../config/env.js';
import { log } from '../../../logging/jsonl.js';
import {
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResult,
  CanonicalStreamEvent,
  CanonicalToolCall,
} from '../../../protocol/canonical.js';
import { getDoubaoModelCatalog, resolveDoubaoModel } from '../models/catalog.js';
import { DoubaoSessionStore, KeyedSerialQueue, resolveDoubaoSessionKey } from '../state/session-store.js';
import { FetchLike } from './client.js';
import { doubaoEvents } from './events.js';
import { modifyConversation, pullConversationState, reasoningEffort, startCompletion } from './protocol.js';
import { DoubaoCredential } from '../auth/doubao-cookie.js';
import {
  createDoubaoToolRuntime,
  DoubaoRemoteToolCall,
  DoubaoToolEnvelope,
  DoubaoToolRuntime,
  doubaoPromptMessages,
  doubaoSystemPrompt,
  doubaoToolLimitMs,
  doubaoToolStream,
  doubaoWaitTimeoutMs,
  routeDoubaoToolCall,
  uploadDoubaoRemoteToolResult,
} from './tools.js';

const sessionStore = new DoubaoSessionStore({
  ttlMs: intEnv('DOUBAO_SESSION_TTL_MS', 6 * 60 * 60 * 1000),
  maxEntries: intEnv('DOUBAO_SESSION_MAX_ENTRIES', 200),
});
const conversationQueue = new KeyedSerialQueue();
const activeTurns = new Map<string, ActiveDoubaoTurn>();

const STILL_RUNNING =
  'The client tool is still running, possibly waiting for user approval. Do not retry it. Call the bridge wait tool to retrieve the result.';
const WAIT_IDLE = 'No client tool is still running. Do not call the wait tool again.';
const WAIT_LIMIT =
  'The client tool did not return within the bridge limit. Its outcome is unknown. Stop and report this.';
const PARALLEL_TOOL_UNSUPPORTED =
  'x-adapter supports one client tool call at a time. Wait for the current call to finish, then call the next tool.';

type PendingCall = {
  canonical: CanonicalToolCall;
  remote: DoubaoRemoteToolCall;
  detached: boolean;
  result?: { text: string; error: boolean };
  timer?: ReturnType<typeof setTimeout>;
};

type ActiveDoubaoTurn = {
  key: string;
  conversationId?: string;
  runtime?: DoubaoToolRuntime;
  queue: AsyncEventQueue<CanonicalStreamEvent>;
  pending: Map<string, PendingCall>;
  credential: DoubaoCredential;
  fetchImpl: FetchLike;
  watchdog: ReturnType<typeof createDoubaoStreamWatchdog>;
  toolController: AbortController;
  toolStartedAt?: number;
  seenRemoteCallIds: Set<string>;
  clientToolCallIds: Set<string>;
  exposedPendingIds: Set<string>;
  limitTimer?: ReturnType<typeof setTimeout>;
  waiter?: { remote: DoubaoRemoteToolCall; timer?: ReturnType<typeof setTimeout> };
  settled: boolean;
};

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
  const toolCalls: CanonicalToolCall[] = [];
  await executeDoubao(credential, request, fetchImpl, signal, (event) => {
    if (event.type === 'text') {
      text += event.delta;
    } else if (event.type === 'reasoning') {
      reasoning += event.delta;
    } else if (event.type === 'tool_call_delta') {
      toolCalls.push(...event.tool_calls);
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'done') {
      finishReason = event.finish_reason;
    }
  });
  return { model: request.model, text, reasoning, tool_calls: toolCalls, finish_reason: finishReason, usage };
}

async function executeDoubao(
  credential: DoubaoCredential,
  request: CanonicalRequest,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  emit: (event: CanonicalStreamEvent) => void,
): Promise<void> {
  if (request.messages.some((message) => message.content.some((block) => block.type !== 'text'))) {
    const error = new Error('Doubao Work currently supports text-only message content.');
    (error as NodeJS.ErrnoException).code = 'unsupported_multimodal_content';
    throw error;
  }
  if (boolEnv('DOUBAO_MOCK', false)) {
    if (toolChoiceRequiresCall(request.tool_choice)) {
      throw requestError(
        'Doubao Work did not call a client tool required by tool_choice.',
        'upstream_tool_choice_not_satisfied',
      );
    }
    emit({ type: 'start', model: request.model });
    emit({ type: 'text', delta: 'PONG' });
    emit({ type: 'usage', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
    emit({ type: 'done', finish_reason: 'stop' });
    return;
  }

  const sessionKey = resolveDoubaoSessionKey(request) || `ephemeral:${Date.now()}:${Math.random()}`;
  const existing = sessionStore.get(sessionKey);
  const lockKey = existing?.conversationId || sessionKey;
  const active = await conversationQueue.run(lockKey, async () => {
    let turn = activeTurns.get(sessionKey);
    if (turn) {
      const toolResults = currentToolResults(turn, currentTurnToolResults(request));
      if (turn.pending.size && !toolResults.length) {
        throw requestError(
          'Doubao Work is waiting for tool results before accepting another turn.',
          'tool_output_mismatch',
        );
      }
      if (!turn.pending.size && toolResults.length) {
        throw requestError('Doubao Work is not waiting for tool results.', 'tool_output_mismatch');
      }
      await submitToolResults(turn, toolResults);
      turn.watchdog.arm();
    } else {
      if (currentTurnToolResults(request).length) {
        throw requestError('Doubao Work no longer has the matching active tool turn.', 'previous_response_unavailable');
      }
      turn = await startActiveTurn(credential, request, sessionKey, fetchImpl, signal);
      activeTurns.set(sessionKey, turn);
    }
    return turn;
  });

  emit({ type: 'start', model: request.model });
  for (;;) {
    const event = await active.queue.nextValue();
    if (event.type === 'tool_call_delta') {
      for (const call of event.tool_calls) {
        active.exposedPendingIds.add(call.id);
      }
      emit(event);
      emit({ type: 'usage', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
      emit({ type: 'done', finish_reason: 'tool_calls' });
      return;
    }
    emit(event);
    if (event.type === 'done') {
      activeTurns.delete(sessionKey);
      cleanupActiveTurn(active);
      return;
    }
  }
}

async function startActiveTurn(
  credential: DoubaoCredential,
  request: CanonicalRequest,
  sessionKey: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<ActiveDoubaoTurn> {
  const catalog = await getDoubaoModelCatalog(credential, fetchImpl);
  const selectedModel = resolveDoubaoModel(catalog, request.model);
  const effort = reasoningEffort(request.reasoning_effort, selectedModel.defaultReasoningLevel);
  const upstreamConversationId =
    typeof request.metadata?.conversation_id === 'string' ? request.metadata.conversation_id.trim() : '';
  if (upstreamConversationId && !sessionStore.get(sessionKey)) {
    sessionStore.set(sessionKey, {
      conversationId: upstreamConversationId,
      sectionId: '',
      lastMessageIndex: 0,
      modelItemKey: '',
      reasoningEffort: 0,
    });
  }
  let session = sessionStore.get(sessionKey);
  const reusedSession = Boolean(session);
  if (session) {
    const latest = await pullConversationState(credential, session.conversationId, fetchImpl, signal);
    session = { ...session, ...latest };
    await modifyConversation(credential, session, selectedModel, effort, fetchImpl, signal);
    session = { ...session, modelItemKey: selectedModel.modelItemKey, reasoningEffort: effort };
    sessionStore.set(sessionKey, session);
  }
  const hasToolTranscript = request.messages.some(
    (message) => message.role === 'tool' || Boolean(message.tool_calls?.length),
  );
  const runtime =
    request.tools?.length || hasToolTranscript
      ? await createDoubaoToolRuntime(credential, request, fetchImpl)
      : undefined;
  const prompt = runtime ? doubaoPromptMessages(request, reusedSession) : promptForDoubao(request, reusedSession);
  if (!prompt) {
    throw requestError('Doubao Work requires at least one non-empty text message.', 'invalid_input');
  }
  const watchdog = createDoubaoStreamWatchdog(signal);
  const toolController = new AbortController();
  const toolStream = runtime?.connectorId
    ? doubaoToolStream(credential, runtime.deviceId, toolController.signal)
    : undefined;
  try {
    if (toolStream) {
      await waitForToolStreamReady(toolStream);
    }
  } catch (error) {
    watchdog.dispose();
    toolController.abort();
    throw error;
  }
  let response: Response;
  try {
    response = await startCompletion({
      credential,
      prompt,
      model: selectedModel,
      effort,
      session,
      fetchImpl,
      signal,
      streamSignal: watchdog.signal,
      toolRuntime: runtime,
      systemPrompt: runtime ? doubaoSystemPrompt(request, runtime) : '',
      workspace: typeof request.metadata?.cwd === 'string' ? request.metadata.cwd : '',
    });
  } catch (error) {
    watchdog.dispose();
    toolController.abort();
    throw error;
  }
  watchdog.arm();

  const active: ActiveDoubaoTurn = {
    key: sessionKey,
    conversationId: session?.conversationId,
    runtime,
    queue: new AsyncEventQueue<CanonicalStreamEvent>(),
    pending: new Map(),
    credential,
    fetchImpl,
    watchdog,
    toolController,
    seenRemoteCallIds: new Set(),
    clientToolCallIds: new Set(),
    exposedPendingIds: new Set(),
    settled: false,
  };
  void runCompletion(active, response, request.model, selectedModel, effort);
  if (toolStream) {
    void runToolListener(active, toolStream);
  }
  return active;
}

async function runCompletion(
  active: ActiveDoubaoTurn,
  response: Response,
  model: string,
  selectedModel: { modelItemKey: string },
  effort: number,
): Promise<void> {
  try {
    for await (const output of doubaoEvents(response.body!, model, active.watchdog.arm)) {
      if (output.type === 'canonical') {
        if (
          output.event.type === 'done' &&
          toolChoiceRequiresCall(active.runtime?.toolChoice) &&
          active.clientToolCallIds.size === 0
        ) {
          throw requestError(
            'Doubao Work did not call a client tool required by tool_choice.',
            'upstream_tool_choice_not_satisfied',
          );
        }
        active.queue.push(output.event);
      } else if (output.type === 'activity') {
        log('info', 'doubao upstream tool activity', {
          model,
          block: output.activity.block,
          block_id: output.activity.blockId,
          status: output.activity.status,
        });
      } else if (output.session.conversationId) {
        active.conversationId = output.session.conversationId;
        sessionStore.set(active.key, {
          conversationId: output.session.conversationId,
          sectionId: output.session.sectionId,
          lastMessageIndex: output.session.lastMessageIndex,
          modelItemKey: selectedModel.modelItemKey,
          reasoningEffort: effort,
        });
      }
    }
    if (toolChoiceRequiresCall(active.runtime?.toolChoice) && active.clientToolCallIds.size === 0) {
      throw requestError(
        'Doubao Work did not call a client tool required by tool_choice.',
        'upstream_tool_choice_not_satisfied',
      );
    }
    active.settled = true;
  } catch (error) {
    active.queue.fail(normalizeWatchdogError(active, error));
    cleanupActiveTurn(active);
    if (activeTurns.get(active.key) === active) {
      activeTurns.delete(active.key);
    }
  } finally {
    if (active.settled) {
      active.toolController.abort();
    }
  }
}

async function waitForToolStreamReady(stream: AsyncGenerator<DoubaoToolEnvelope>): Promise<void> {
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      throw requestError('Doubao Work tool stream ended before its readiness heartbeat.', 'upstream_stream_truncated');
    }
    if (next.value.heartbeat !== undefined) {
      return;
    }
    if (next.value.tool_call) {
      throw requestError('Doubao Work sent a tool call before the turn started.', 'upstream_invalid_response');
    }
  }
}

async function runToolListener(active: ActiveDoubaoTurn, stream: AsyncGenerator<DoubaoToolEnvelope>): Promise<void> {
  try {
    const runtime = active.runtime;
    if (!runtime) {
      return;
    }
    for await (const envelope of stream) {
      if (!envelope.tool_call || envelope.sandbox_id !== runtime.sandboxId) {
        continue;
      }
      if (
        envelope.tool_call.conversationId &&
        active.conversationId &&
        envelope.tool_call.conversationId !== active.conversationId
      ) {
        continue;
      }
      await handleRemoteToolCall(active, envelope);
    }
  } catch (error) {
    if (!active.toolController.signal.aborted) {
      active.queue.fail(error);
      cleanupActiveTurn(active);
      if (activeTurns.get(active.key) === active) {
        activeTurns.delete(active.key);
      }
    }
  }
}

async function handleRemoteToolCall(active: ActiveDoubaoTurn, envelope: DoubaoToolEnvelope): Promise<void> {
  const remote = envelope.tool_call!;
  if (!active.runtime) {
    throw requestError('Doubao Work sent a tool call for a text-only turn.', 'upstream_invalid_response');
  }
  if (active.seenRemoteCallIds.has(remote.id)) {
    return;
  }
  const routed = routeDoubaoToolCall(envelope, active.runtime);
  active.seenRemoteCallIds.add(remote.id);
  if ('wait' in routed) {
    await handleWaitCall(active, remote);
    return;
  }
  if (active.pending.has(routed.id)) {
    return;
  }
  if (active.pending.size > 0) {
    await uploadDoubaoRemoteToolResult(
      active.credential,
      active.runtime,
      remote,
      PARALLEL_TOOL_UNSUPPORTED,
      true,
      active.fetchImpl,
    );
    return;
  }
  const pending: PendingCall = { canonical: routed, remote, detached: false };
  active.pending.set(routed.id, pending);
  active.clientToolCallIds.add(routed.id);
  armActiveTurnLimit(active);
  pending.timer = setTimeout(() => void detachPending(active, pending), doubaoWaitTimeoutMs());
  pending.timer.unref?.();
  active.watchdog.dispose();
  active.queue.push({ type: 'tool_call_delta', tool_calls: [routed] });
}

async function detachPending(active: ActiveDoubaoTurn, pending: PendingCall): Promise<void> {
  if (pending.detached || pending.result || !active.runtime) {
    return;
  }
  pending.detached = true;
  await uploadDoubaoRemoteToolResult(
    active.credential,
    active.runtime,
    pending.remote,
    STILL_RUNNING,
    true,
    active.fetchImpl,
  ).catch((error) => active.queue.fail(error));
}

function armActiveTurnLimit(active: ActiveDoubaoTurn): void {
  if (active.limitTimer) {
    return;
  }
  active.toolStartedAt = Date.now();
  active.limitTimer = setTimeout(() => expireActiveTurn(active), doubaoToolLimitMs());
  active.limitTimer.unref?.();
}

function expireActiveTurn(active: ActiveDoubaoTurn): void {
  if (activeTurns.get(active.key) !== active) {
    cleanupActiveTurn(active);
    return;
  }
  const error = requestError('Doubao Work tool turn exceeded the configured bridge limit.', 'doubao_tool_turn_expired');
  active.queue.fail(error);
  activeTurns.delete(active.key);
  active.watchdog.abort();
  cleanupActiveTurn(active);
}

async function handleWaitCall(active: ActiveDoubaoTurn, remote: DoubaoRemoteToolCall): Promise<void> {
  const runtime = active.runtime;
  if (!runtime) {
    return;
  }
  const detached = [...active.pending.values()].filter((pending) => pending.detached);
  if (!detached.length) {
    await uploadDoubaoRemoteToolResult(active.credential, runtime, remote, WAIT_IDLE, true, active.fetchImpl);
    return;
  }
  if (active.toolStartedAt !== undefined && Date.now() - active.toolStartedAt >= doubaoToolLimitMs()) {
    await uploadDoubaoRemoteToolResult(active.credential, runtime, remote, WAIT_LIMIT, true, active.fetchImpl);
    return;
  }
  if (detached.every((pending) => pending.result)) {
    await deliverLateResults(active, remote, detached);
    return;
  }
  if (active.waiter) {
    clearTimeout(active.waiter.timer);
    await uploadDoubaoRemoteToolResult(
      active.credential,
      runtime,
      active.waiter.remote,
      STILL_RUNNING,
      true,
      active.fetchImpl,
    );
  }
  const waiter = { remote } as ActiveDoubaoTurn['waiter'];
  active.waiter = waiter;
  waiter!.timer = setTimeout(() => {
    if (active.waiter !== waiter) {
      return;
    }
    active.waiter = undefined;
    void uploadDoubaoRemoteToolResult(active.credential, runtime, remote, STILL_RUNNING, true, active.fetchImpl).catch(
      (error) => active.queue.fail(error),
    );
  }, doubaoWaitTimeoutMs());
  waiter!.timer?.unref?.();
}

async function submitToolResults(
  active: ActiveDoubaoTurn,
  results: Array<{ id: string; text: string; error: boolean }>,
): Promise<void> {
  if (!active.runtime) {
    throw requestError('Doubao Work text-only turn cannot accept tool results.', 'tool_output_mismatch');
  }
  if (results.length === 0 && active.pending.size === 0) {
    return;
  }
  if (results.length !== active.exposedPendingIds.size) {
    throw requestError('The request must return every outstanding Doubao Work tool result.', 'tool_output_mismatch');
  }
  for (const result of results) {
    const pending = active.pending.get(result.id);
    if (!pending || !active.exposedPendingIds.has(result.id)) {
      throw requestError(`Unknown Doubao Work tool result id: ${result.id}`, 'tool_output_mismatch');
    }
    clearTimeout(pending.timer);
    if (pending.detached) {
      pending.result = { text: result.text, error: result.error };
    } else {
      await uploadDoubaoRemoteToolResult(
        active.credential,
        active.runtime,
        pending.remote,
        result.text,
        result.error,
        active.fetchImpl,
      );
      active.pending.delete(result.id);
      active.exposedPendingIds.delete(result.id);
    }
  }
  const detached = [...active.pending.values()].filter((pending) => pending.detached);
  if (active.waiter && detached.length && detached.every((pending) => pending.result)) {
    const waiter = active.waiter;
    active.waiter = undefined;
    clearTimeout(waiter.timer);
    await deliverLateResults(active, waiter.remote, detached);
  }
}

async function deliverLateResults(
  active: ActiveDoubaoTurn,
  waiter: DoubaoRemoteToolCall,
  pendingCalls: PendingCall[],
): Promise<void> {
  if (!active.runtime) {
    return;
  }
  const text = pendingCalls
    .map((pending) => {
      const result = pending.result!;
      return pendingCalls.length === 1
        ? result.text
        : `[${pending.canonical.function.name}]${result.error ? ' ERROR' : ''}\n${result.text}`;
    })
    .join('\n\n');
  const error = pendingCalls.some((pending) => pending.result?.error);
  await uploadDoubaoRemoteToolResult(active.credential, active.runtime, waiter, text, error, active.fetchImpl);
  for (const pending of pendingCalls) {
    active.pending.delete(pending.canonical.id);
    active.exposedPendingIds.delete(pending.canonical.id);
  }
  active.watchdog.arm();
}

function toolChoiceRequiresCall(choice: DoubaoToolRuntime['toolChoice']): boolean {
  return choice === 'required' || typeof choice === 'object';
}

function currentToolResults(
  active: ActiveDoubaoTurn,
  results: Array<{ id: string; text: string; error: boolean }>,
): Array<{ id: string; text: string; error: boolean }> {
  const current: Array<{ id: string; text: string; error: boolean }> = [];
  const seenCurrent = new Set<string>();
  for (const result of results) {
    if (active.pending.has(result.id) && active.exposedPendingIds.has(result.id)) {
      if (seenCurrent.has(result.id)) {
        throw requestError(`Duplicate Doubao Work tool result id: ${result.id}`, 'tool_output_mismatch');
      }
      seenCurrent.add(result.id);
      current.push(result);
      continue;
    }
    if (!active.pending.has(result.id) && active.clientToolCallIds.has(result.id)) {
      continue;
    }
    throw requestError(`Unknown Doubao Work tool result id: ${result.id}`, 'tool_output_mismatch');
  }
  return current;
}

function currentTurnToolResults(request: CanonicalRequest): Array<{ id: string; text: string; error: boolean }> {
  let firstTrailingTool = request.messages.length;
  while (firstTrailingTool > 0 && request.messages[firstTrailingTool - 1].role === 'tool') {
    firstTrailingTool -= 1;
  }
  return toolResultsFromRequest(request.messages.slice(firstTrailingTool));
}

function toolResultsFromRequest(
  messages: CanonicalRequest['messages'],
): Array<{ id: string; text: string; error: boolean }> {
  return messages.flatMap((message) => {
    if (message.role !== 'tool' || !message.tool_call_id) {
      return [];
    }
    return [
      {
        id: message.tool_call_id,
        text: contentText(message),
        error: message.tool_result_error === true,
      },
    ];
  });
}

function cleanupActiveTurn(active: ActiveDoubaoTurn): void {
  clearTimeout(active.limitTimer);
  active.watchdog.dispose();
  active.toolController.abort();
  clearTimeout(active.waiter?.timer);
  for (const pending of active.pending.values()) {
    clearTimeout(pending.timer);
  }
}

function normalizeWatchdogError(active: ActiveDoubaoTurn, error: unknown): unknown {
  if (!active.watchdog.tripped()) {
    return error;
  }
  return requestError('Doubao upstream stream stalled without observable agent progress.', 'upstream_stream_truncated');
}

function requestError(message: string, code: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
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

  async nextValue(): Promise<T> {
    for (;;) {
      if (this.values.length) {
        return this.values.shift()!;
      }
      if (this.failure) {
        throw this.failure;
      }
      if (this.closed) {
        throw requestError('Doubao Work stream ended without a terminal event.', 'upstream_stream_truncated');
      }
      await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
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

export const __testHooks = {
  sessionStore,
  conversationQueue,
  activeTurns,
  currentTurnToolResults,
  currentToolResults,
  toolChoiceRequiresCall,
  handleRemoteToolCall,
  expireActiveTurn,
};
