import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import {
  AGENT_THINKING_LEVELS,
  type AgentExtensionUIRequest,
  type AgentExtensionUIResponse,
  type AgentModelInfo,
  type AgentSessionState,
  type AgentSlashCommand,
  type AgentThinkingLevel,
} from '../types.js';
import type { SpawnedProcessByStdio } from '../../platform/spawn.js';
import { log } from '../../core/logger.js';
import {
  parseRpcExtensionUIRequest,
  parseRpcUIPromptLifecycleEvent,
  serializeRpcExtensionUIResponse,
  type RpcUIPromptLifecycleEvent,
} from './rpc-extension-ui.js';
import { StrictPiJsonlDecoder, type PiJsonlLimits } from './jsonl.js';

export interface RpcImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export type RpcPromptDisposition = 'started' | 'queued' | 'handled';
export type RpcQueuedDisposition = 'queued' | 'handled';
export type RpcAcceptance = 'not-accepted' | 'accepted' | 'uncertain';

export class RpcCommandError extends Error {
  constructor(
    message: string,
    readonly acceptance: RpcAcceptance,
    readonly fallbackSafe = false,
  ) {
    super(message);
    this.name = 'RpcCommandError';
  }
}

interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type RpcSessionState = AgentSessionState;

export interface RpcExtensionUIRequest {
  id: string;
  request: AgentExtensionUIRequest;
  expectsResponse: boolean;
}

export interface RpcExtensionUIHandler {
  onRequest(request: RpcExtensionUIRequest): Promise<AgentExtensionUIResponse | void>;
  onPromptLifecycle?(event: RpcUIPromptLifecycleEvent): void;
}

interface PendingCommand {
  command: string;
  acceptanceOnUncertainFailure: RpcAcceptance;
  timer: NodeJS.Timeout;
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

export interface StrictPiRpcConnectionOptions {
  commandTimeoutMs?: number;
  stderrLimitBytes?: number;
  maxPendingCommands?: number;
  maxCommandBytes?: number;
  terminateGraceMs?: number;
  jsonlLimits?: PiJsonlLimits;
  now?: () => number;
  extensionUIHandler?: RpcExtensionUIHandler;
}

type PiRpcChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const MAX_RETAINED_EXTENSION_UI_REQUEST_IDS = 4_096;
const MAX_PENDING_EXTENSION_UI_REQUESTS = 64;

/** Strict, bounded client for one already-spawned Pi RPC child. */
export class StrictPiRpcConnection {
  private readonly decoder: StrictPiJsonlDecoder;
  private readonly commandTimeoutMs: number;
  private readonly stderrLimitBytes: number;
  private readonly maxPendingCommands: number;
  private readonly maxCommandBytes: number;
  private readonly terminateGraceMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly extensionUIRequestIds = new Set<string>();
  private readonly pendingExtensionUIRequests = new Map<string, AgentExtensionUIRequest>();
  private extensionUIHandler: RpcExtensionUIHandler | undefined;
  private stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fatalError: Error | undefined;
  private closed = false;
  private disposing = false;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private _lastUsedAt: number;

  constructor(
    private readonly child: PiRpcChild,
    options: StrictPiRpcConnectionOptions = {},
  ) {
    this.decoder = new StrictPiJsonlDecoder(options.jsonlLimits);
    this.commandTimeoutMs = positive(options.commandTimeoutMs, 30_000, 'commandTimeoutMs');
    this.stderrLimitBytes = positive(options.stderrLimitBytes, 4_096, 'stderrLimitBytes');
    this.maxPendingCommands = positive(options.maxPendingCommands, 16, 'maxPendingCommands');
    this.maxCommandBytes = positive(options.maxCommandBytes, 64 * 1024 * 1024, 'maxCommandBytes');
    this.terminateGraceMs = positive(options.terminateGraceMs, 1_000, 'terminateGraceMs');
    this.now = options.now ?? Date.now;
    this.extensionUIHandler = options.extensionUIHandler;
    this._lastUsedAt = this.now();
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.stdout.on('data', (chunk: Buffer) => this.handleStdout(Buffer.from(chunk)));
    child.stdout.once('end', () => this.handleStdoutEnd());
    child.stdout.once('error', (error) => this.fail(new Error(`Pi RPC stdout error: ${error.message}`)));
    child.stderr.on('data', (chunk: Buffer) => this.handleStderr(Buffer.from(chunk)));
    child.stderr.once('error', (error) => this.fail(new Error(`Pi RPC stderr error: ${error.message}`)));
    child.once('error', (error) => this.fail(new Error(`Pi RPC process error: ${error.message}`)));
    child.stdin.on('error', (error) => this.fail(new Error(`Pi RPC stdin error: ${error.message}`)));
    child.once('exit', (code, signal) => {
      this.closed = true;
      this.resolveExit();
      if (!this.disposing && !this.fatalError) {
        this.fail(new Error(`Pi RPC process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`));
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get lastUsedAt(): number {
    return this._lastUsedAt;
  }

  get usable(): boolean {
    return !this.closed && !this.fatalError && this.child.exitCode === null && this.child.signalCode === null;
  }

  get error(): Error | undefined {
    return this.fatalError;
  }

  getStderr(): string {
    return this.stderr.toString('utf8').trim();
  }

  touch(): void {
    this._lastUsedAt = this.now();
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.fatalError) {
      listener(this.fatalError);
    }
    return () => this.failureListeners.delete(listener);
  }

  setExtensionUIHandler(handler: RpcExtensionUIHandler | undefined): void {
    this.extensionUIHandler = handler;
  }

  cancelExtensionUIRequests(): void {
    for (const [id, request] of this.pendingExtensionUIRequests) {
      this.writeExtensionUIResponse(id, request, { cancelled: true });
    }
    this.pendingExtensionUIRequests.clear();
  }

  async waitForEvent(predicate: (event: unknown) => boolean, timeoutMs = this.commandTimeoutMs): Promise<unknown> {
    if (!this.usable) {
      throw new RpcCommandError(this.fatalError?.message ?? 'Pi RPC connection is not usable', 'accepted');
    }
    return new Promise((resolve, reject) => {
      let unsubscribeEvent = (): void => {};
      let unsubscribeFailure = (): void => {};
      const timer = setTimeout(() => {
        unsubscribeEvent();
        unsubscribeFailure();
        reject(new RpcCommandError('Pi RPC event wait timed out', 'accepted'));
      }, timeoutMs);
      timer.unref();
      unsubscribeEvent = this.onEvent((event) => {
        if (!predicate(event)) {
          return;
        }
        clearTimeout(timer);
        unsubscribeEvent();
        unsubscribeFailure();
        resolve(event);
      });
      unsubscribeFailure = this.onFailure((error) => {
        clearTimeout(timer);
        unsubscribeEvent();
        unsubscribeFailure();
        reject(new RpcCommandError(error.message, 'accepted'));
      });
    });
  }

  terminate(error: Error): void {
    this.fail(error);
  }

  async getState(): Promise<RpcSessionState> {
    const response = await this.send({ type: 'get_state' }, 'not-accepted');
    const data = record(response.data);
    const sessionId = string(data?.sessionId);
    if (!sessionId || typeof data?.isStreaming !== 'boolean') {
      throw this.protocolFailure('Pi RPC get_state returned invalid data', 'not-accepted');
    }
    const model = data?.model === undefined ? undefined : parseModel(data.model);
    const thinkingLevel = data?.thinkingLevel === undefined ? undefined : parseThinkingLevel(data.thinkingLevel);
    if ((data?.model !== undefined && !model) || (data?.thinkingLevel !== undefined && !thinkingLevel)) {
      throw this.protocolFailure('Pi RPC get_state returned invalid model state', 'not-accepted');
    }
    return {
      sessionId,
      isStreaming: data.isStreaming,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  }

  async getAvailableModels(): Promise<AgentModelInfo[]> {
    const response = await this.send({ type: 'get_available_models' }, 'not-accepted');
    const rawModels = record(response.data)?.models;
    if (!Array.isArray(rawModels) || rawModels.length > 10_000) {
      throw this.protocolFailure('Pi RPC get_available_models returned invalid data', 'not-accepted');
    }
    const models = rawModels.map(parseModel);
    if (models.some((model) => !model)) {
      throw this.protocolFailure('Pi RPC get_available_models returned an invalid model entry', 'not-accepted');
    }
    return models as AgentModelInfo[];
  }

  async setModel(provider: string, modelId: string): Promise<AgentModelInfo> {
    const response = await this.sendStateChange({ type: 'set_model', provider, modelId });
    const model = parseModel(response.data);
    if (!model) {
      throw this.protocolFailure('Pi RPC set_model returned invalid data', 'not-accepted');
    }
    return model;
  }

  async getAvailableThinkingLevels(): Promise<AgentThinkingLevel[]> {
    const response = await this.send({ type: 'get_available_thinking_levels' }, 'not-accepted');
    const rawLevels = record(response.data)?.levels;
    if (!Array.isArray(rawLevels) || !rawLevels.length || rawLevels.length > AGENT_THINKING_LEVELS.length) {
      throw this.protocolFailure('Pi RPC get_available_thinking_levels returned invalid data', 'not-accepted');
    }
    const levels = rawLevels.map(parseThinkingLevel);
    if (levels.some((level) => !level) || new Set(levels).size !== levels.length) {
      throw this.protocolFailure('Pi RPC get_available_thinking_levels returned invalid levels', 'not-accepted');
    }
    return levels as AgentThinkingLevel[];
  }

  async setThinkingLevel(level: AgentThinkingLevel): Promise<void> {
    await this.sendStateChange({ type: 'set_thinking_level', level });
  }

  async prompt(message: string, images?: RpcImageContent[], timeoutMs?: number): Promise<RpcPromptDisposition> {
    // A pooled RPC child is long-lived. Bound each accepted run independently
    // instead of exhausting one lifetime counter across otherwise valid turns.
    this.decoder.resetOutputBudget();
    const response = await this.send(
      { type: 'prompt', message, ...(images?.length ? { images } : {}) },
      'uncertain',
      timeoutMs,
    );
    const disposition = string(record(response.data)?.disposition);
    if (disposition !== 'started' && disposition !== 'queued' && disposition !== 'handled') {
      throw this.protocolFailure('Pi RPC prompt returned an invalid disposition', 'uncertain');
    }
    return disposition;
  }

  async getCommands(): Promise<AgentSlashCommand[]> {
    const response = await this.send({ type: 'get_commands' }, 'not-accepted');
    const commands = record(response.data)?.commands;
    if (!Array.isArray(commands) || commands.length > 1_024) {
      throw this.protocolFailure('Pi RPC get_commands returned invalid data', 'not-accepted');
    }
    const projected: AgentSlashCommand[] = [];
    const names = new Set<string>();
    for (const raw of commands) {
      const command = record(raw);
      const name = string(command?.name);
      const source = string(command?.source);
      const description = command?.description;
      if (
        !name ||
        name.length > 256 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name) ||
        (source !== 'extension' && source !== 'prompt' && source !== 'skill') ||
        (description !== undefined && (typeof description !== 'string' || description.length > 2_048))
      ) {
        throw this.protocolFailure('Pi RPC get_commands returned an invalid command entry', 'not-accepted');
      }
      if (!names.has(name)) {
        names.add(name);
        projected.push({ name, source, ...(description ? { description } : {}) });
      }
    }
    return projected;
  }

  async steer(message: string, images?: RpcImageContent[]): Promise<RpcQueuedDisposition> {
    return this.queueCommand('steer', message, images);
  }

  async followUp(message: string, images?: RpcImageContent[]): Promise<RpcQueuedDisposition> {
    return this.queueCommand('follow_up', message, images);
  }

  async abort(timeoutMs?: number): Promise<void> {
    await this.send({ type: 'abort' }, 'accepted', timeoutMs);
  }

  async dispose(graceMs = 250): Promise<void> {
    this.disposing = true;
    this.rejectPending(new Error('Pi RPC connection was disposed'));
    this.cancelExtensionUIRequests();
    this.listeners.clear();
    this.failureListeners.clear();
    this.extensionUIHandler = undefined;
    this.extensionUIRequestIds.clear();
    if (this.closed) {
      return;
    }
    this.child.stdin.end();
    if (!(await this.waitForExit(graceMs))) {
      this.child.kill('SIGTERM');
      if (!(await this.waitForExit(graceMs))) {
        this.child.kill('SIGKILL');
        await this.waitForExit(250);
      }
    }
    this.closed = true;
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) {
      return true;
    }
    return Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  }

  private async sendStateChange(command: Record<string, unknown>): Promise<RpcResponse> {
    let eventError: Error | undefined;
    const unsubscribe = this.onEvent((event) => {
      const raw = record(event);
      if (raw?.type !== 'thinking_level_changed' || !parseThinkingLevel(raw.level)) {
        eventError = new Error(`Pi RPC emitted an unexpected event during ${String(command.type)}`);
        this.terminate(eventError);
      }
    });
    try {
      const response = await this.send(command, 'not-accepted');
      if (eventError) {
        throw eventError;
      }
      return response;
    } finally {
      unsubscribe();
    }
  }

  private async queueCommand(
    type: 'steer' | 'follow_up',
    message: string,
    images?: RpcImageContent[],
  ): Promise<RpcQueuedDisposition> {
    const response = await this.send({ type, message, ...(images?.length ? { images } : {}) }, 'accepted');
    const disposition = string(record(response.data)?.disposition);
    if (disposition !== 'queued' && disposition !== 'handled') {
      throw this.protocolFailure(`Pi RPC ${type} returned an invalid disposition`, 'accepted');
    }
    return disposition;
  }

  private send(
    command: Record<string, unknown>,
    acceptanceOnUncertainFailure: RpcAcceptance,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<RpcResponse> {
    this.touch();
    if (!this.usable) {
      throw new RpcCommandError(this.fatalError?.message ?? 'Pi RPC connection is not usable', 'not-accepted');
    }
    if (this.pending.size >= this.maxPendingCommands) {
      throw new RpcCommandError('Pi RPC pending command limit exceeded', 'not-accepted');
    }
    const id = randomUUID();
    const payload = Buffer.from(`${JSON.stringify({ ...command, id })}\n`, 'utf8');
    if (payload.length > this.maxCommandBytes) {
      throw new RpcCommandError(`Pi RPC command exceeded ${this.maxCommandBytes} bytes`, 'not-accepted');
    }
    return new Promise<RpcResponse>((resolve, reject) => {
      const pendingCommand = String(command.type);
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        const error = new Error(`Pi RPC ${pending.command} response timed out`);
        pending.reject(new RpcCommandError(error.message, pending.acceptanceOnUncertainFailure));
        this.fail(error);
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        command: pendingCommand,
        acceptanceOnUncertainFailure,
        timer,
        resolve,
        reject,
      });
      try {
        this.child.stdin.write(payload, (error) => {
          if (!error) {
            return;
          }
          const pending = this.pending.get(id);
          if (!pending) {
            return;
          }
          clearTimeout(pending.timer);
          this.pending.delete(id);
          const writeError = new RpcCommandError(
            `Pi RPC ${pending.command} write failed: ${error.message}`,
            pending.acceptanceOnUncertainFailure,
          );
          pending.reject(writeError);
          this.fail(writeError);
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const message = `Pi RPC ${pending.command} write failed: ${error instanceof Error ? error.message : String(error)}`;
        const acceptance = pending.acceptanceOnUncertainFailure;
        const writeError = new RpcCommandError(message, acceptance);
        pending.reject(writeError);
        this.fail(writeError);
      }
    });
  }

  private handleStdout(chunk: Buffer): void {
    if (this.fatalError) {
      return;
    }
    try {
      // Dispatch as records are decoded. Holding every record from one stdout
      // chunk until the chunk is fully parsed can retain several large Pi
      // lifecycle events at once and needlessly amplify peak memory.
      this.decoder.push(chunk, (raw) => this.handleRecord(raw));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleStdoutEnd(): void {
    if (this.fatalError || this.disposing || this.closed) {
      return;
    }
    try {
      this.decoder.finish();
      this.fail(new Error('Pi RPC stdout ended before process exit'));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleRecord(raw: unknown): void {
    const value = record(raw);
    const type = string(value?.type);
    if (!value || !type) {
      throw this.protocolFailure('Pi RPC emitted a non-object record');
    }
    if (type === 'response') {
      const response = value as unknown as RpcResponse;
      const id = string(response.id);
      if (!id) {
        throw this.protocolFailure('Pi RPC emitted an uncorrelated response');
      }
      const pending = this.pending.get(id);
      if (!pending) {
        throw this.protocolFailure(`Pi RPC emitted a response for unknown command id ${id}`);
      }
      if (response.command !== pending.command || typeof response.success !== 'boolean') {
        throw this.protocolFailure('Pi RPC emitted a mismatched command response');
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (!response.success) {
        pending.reject(
          new RpcCommandError(
            truncate(string(response.error) ?? `Pi RPC ${pending.command} command failed`, 4_096),
            pending.command === 'prompt' ? 'not-accepted' : pending.acceptanceOnUncertainFailure,
            pending.command === 'prompt',
          ),
        );
      } else {
        pending.resolve(response);
      }
      return;
    }
    if (type === 'extension_ui_request') {
      this.handleExtensionUIRequest(raw);
      return;
    }
    if (type === 'ui_prompt_start' || type === 'ui_prompt_end') {
      const event = parseRpcUIPromptLifecycleEvent(raw);
      this.extensionUIHandler?.onPromptLifecycle?.(event);
      return;
    }
    if (!this.listeners.size) {
      throw this.protocolFailure(`Pi RPC emitted unconsumed event: ${type}`);
    }
    for (const listener of [...this.listeners]) {
      listener(raw);
    }
    if (type === 'agent_settled') {
      // The next pooled turn gets an independent output budget. Reset here so
      // its get_state handshake cannot be charged to the completed turn.
      this.decoder.resetOutputBudget();
    }
  }

  private handleExtensionUIRequest(raw: unknown): void {
    const parsed = parseRpcExtensionUIRequest(raw);
    if (this.extensionUIRequestIds.has(parsed.id)) {
      throw this.protocolFailure('Pi RPC emitted a duplicate extension UI request id');
    }
    if (parsed.expectsResponse && this.pendingExtensionUIRequests.size >= MAX_PENDING_EXTENSION_UI_REQUESTS) {
      throw this.protocolFailure('Pi RPC extension UI pending request capacity was exceeded');
    }
    this.extensionUIRequestIds.add(parsed.id);
    if (this.extensionUIRequestIds.size > MAX_RETAINED_EXTENSION_UI_REQUEST_IDS) {
      for (const candidate of this.extensionUIRequestIds) {
        if (candidate !== parsed.id && !this.pendingExtensionUIRequests.has(candidate)) {
          this.extensionUIRequestIds.delete(candidate);
          break;
        }
      }
    }
    const handler = this.extensionUIHandler;
    if (!handler) {
      if (parsed.expectsResponse) {
        this.writeExtensionUIResponse(parsed.id, parsed.request, { cancelled: true });
      }
      return;
    }
    if (parsed.expectsResponse) {
      this.pendingExtensionUIRequests.set(parsed.id, parsed.request);
    }
    void handler
      .onRequest(parsed)
      .then((response) => {
        if (!parsed.expectsResponse || !this.pendingExtensionUIRequests.delete(parsed.id)) {
          return;
        }
        this.writeExtensionUIResponse(parsed.id, parsed.request, response ?? { cancelled: true });
      })
      .catch((error) => {
        if (!parsed.expectsResponse) {
          log.warn('agent', 'pi-rpc-extension-ui-fire-and-forget-failed', {
            method: parsed.request.method,
            message: truncate(error instanceof Error ? error.message : String(error), 500),
          });
          return;
        }
        try {
          if (!this.pendingExtensionUIRequests.delete(parsed.id)) {
            return;
          }
          this.writeExtensionUIResponse(parsed.id, parsed.request, { cancelled: true });
        } catch {
          // writeExtensionUIResponse already failed the connection.
        }
      });
  }

  private writeExtensionUIResponse(
    id: string,
    request: AgentExtensionUIRequest,
    response: AgentExtensionUIResponse,
  ): void {
    if (!this.usable) {
      return;
    }
    let payload: Buffer;
    try {
      payload = serializeRpcExtensionUIResponse(id, request, response);
      this.child.stdin.write(payload, (error) => {
        if (error) {
          this.fail(new Error(`Pi RPC extension UI response write failed: ${error.message}`));
        }
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleStderr(chunk: Buffer): void {
    const combined = this.stderr.length ? Buffer.concat([this.stderr, chunk]) : chunk;
    this.stderr =
      combined.length > this.stderrLimitBytes ? combined.subarray(combined.length - this.stderrLimitBytes) : combined;
    log.warn('agent', 'pi-rpc-stderr', {
      message: truncate(chunk.toString('utf8').replace(/[\r\n]+/g, ' '), 500),
    });
  }

  private protocolFailure(message: string, acceptance: RpcAcceptance = 'accepted'): RpcCommandError {
    const error = new RpcCommandError(message, acceptance);
    this.fail(error);
    return error;
  }

  private fail(error: Error): void {
    if (this.fatalError) {
      return;
    }
    this.fatalError = error;
    this.rejectPending(error, 'preserve');
    for (const listener of [...this.failureListeners]) {
      listener(error);
    }
    if (!this.closed && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (!this.closed && this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill('SIGKILL');
        }
      }, this.terminateGraceMs);
      timer.unref();
    }
  }

  private rejectPending(error: Error, mode: 'preserve' | 'disposed' = 'disposed'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new RpcCommandError(
          error.message,
          mode === 'preserve' ? pending.acceptanceOnUncertainFailure : 'not-accepted',
          false,
        ),
      );
    }
    this.pending.clear();
  }
}

export interface RpcPoolEntry {
  key: string;
  connection: StrictPiRpcConnection;
  busy: boolean;
}

export interface PiRpcPoolOptions {
  maxConnections?: number;
  idleTtlMs?: number;
  now?: () => number;
}

/** Small bounded pool. Entries are never shared while an active run consumes them. */
export class PiRpcPool {
  private readonly entries = new Map<string, RpcPoolEntry>();
  private readonly maxConnections: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private operation: Promise<void> = Promise.resolve();

  constructor(options: PiRpcPoolOptions = {}) {
    this.maxConnections = positive(options.maxConnections, 10, 'maxConnections');
    this.idleTtlMs = positive(options.idleTtlMs, 15 * 60_000, 'idleTtlMs');
    this.now = options.now ?? Date.now;
  }

  acquire(
    key: string,
    create: () => Promise<StrictPiRpcConnection>,
  ): Promise<{ entry: RpcPoolEntry; reused: boolean }> {
    return this.exclusive(async () => {
      await this.sweepUnlocked();
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.busy) {
          throw new Error('Pi RPC connection is already active for this scope');
        }
        if (existing.connection.usable) {
          existing.busy = true;
          existing.connection.touch();
          return { entry: existing, reused: true };
        }
        await this.invalidateUnlocked(existing);
      }
      if (this.entries.size >= this.maxConnections) {
        const idle = [...this.entries.values()]
          .filter((entry) => !entry.busy)
          .sort((left, right) => left.connection.lastUsedAt - right.connection.lastUsedAt)[0];
        if (!idle) {
          throw new Error('Pi RPC process pool is full');
        }
        await this.invalidateUnlocked(idle);
      }
      const entry = { key, connection: await create(), busy: true };
      this.entries.set(key, entry);
      entry.connection.onFailure(() => {
        void this.exclusive(async () => {
          if (this.entries.get(entry.key) === entry) {
            await this.invalidateUnlocked(entry);
          }
        });
      });
      return { entry, reused: false };
    });
  }

  release(entry: RpcPoolEntry): void {
    if (this.entries.get(entry.key) !== entry) {
      return;
    }
    entry.busy = false;
    entry.connection.touch();
  }

  invalidate(entry: RpcPoolEntry): Promise<void> {
    return this.exclusive(() => this.invalidateUnlocked(entry));
  }

  sweep(): Promise<void> {
    return this.exclusive(() => this.sweepUnlocked());
  }

  dispose(): Promise<void> {
    return this.exclusive(async () => {
      const entries = [...this.entries.values()];
      this.entries.clear();
      await Promise.all(entries.map((entry) => entry.connection.dispose().catch(() => {})));
    });
  }

  size(): number {
    return this.entries.size;
  }

  private async sweepUnlocked(): Promise<void> {
    const cutoff = this.now() - this.idleTtlMs;
    const stale = [...this.entries.values()].filter(
      (entry) => !entry.busy && (!entry.connection.usable || entry.connection.lastUsedAt <= cutoff),
    );
    for (const entry of stale) {
      await this.invalidateUnlocked(entry);
    }
  }

  private async invalidateUnlocked(entry: RpcPoolEntry): Promise<void> {
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    await entry.connection.dispose().catch(() => {});
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseModel(value: unknown): AgentModelInfo | undefined {
  const raw = record(value);
  const provider = string(raw?.provider);
  const id = string(raw?.id);
  const name = raw?.name;
  if (
    !provider ||
    provider.length > 128 ||
    !id ||
    id.length > 256 ||
    typeof raw?.reasoning !== 'boolean' ||
    (name !== undefined && (typeof name !== 'string' || name.length > 512))
  ) {
    return undefined;
  }
  return { provider, id, reasoning: raw.reasoning, ...(name ? { name } : {}) };
}

function parseThinkingLevel(value: unknown): AgentThinkingLevel | undefined {
  return typeof value === 'string' && (AGENT_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as AgentThinkingLevel)
    : undefined;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}
