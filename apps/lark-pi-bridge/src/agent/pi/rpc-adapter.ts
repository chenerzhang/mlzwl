import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger.js';
import { buildPiChildEnv } from '../../platform/pi-env.js';
import { spawnProcessPrivate, type SpawnedProcessByStdio } from '../../platform/spawn.js';
import { BRIDGE_SYSTEM_PROMPT, buildBridgeUserPrompt } from '../bridge-system-prompt.js';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env.js';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentBotIdentity,
  AgentControlDisposition,
  AgentEvent,
  AgentInteractionPort,
  AgentModelCatalog,
  AgentRun,
  AgentRunOptions,
  AgentSessionState,
  AgentSlashCommand,
  AgentThinkingLevel,
  AgentThinkingSupport,
} from '../types.js';
import { PiJsonTranslator, type PiFinishReason } from './json-translator.js';
import { buildPiRpcArgs } from './rpc-argv.js';
import {
  PiRpcPool,
  RpcCommandError,
  StrictPiRpcConnection,
  type PiRpcPoolOptions,
  type RpcPoolEntry,
  type StrictPiRpcConnectionOptions,
} from './rpc-connection.js';
import { readRpcImages } from './rpc-images.js';
import { checkPiCompatibility } from './preflight.js';
import { checkPiRpcCompatibility } from './rpc-preflight.js';

export interface PiRpcAdapterOptions {
  binary?: string;
  piConfigDir: string;
  handoffPiConfigDir?: string;
  piSessionDir: string;
  bridgeSystemPromptFile: string;
  larkChannel?: LarkChannelEnvContext;
  stopGraceMs?: number;
  pool?: PiRpcPoolOptions;
  connection?: StrictPiRpcConnectionOptions;
  /** Test/defence-in-depth override for the post-write prompt response boundary. */
  promptTimeoutMs?: number;
  maxEventQueueItems?: number;
  maxEventQueueBytes?: number;
}

type PiRpcChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/** Long-lived Pi RPC adapter. New profiles do not select this transport unless explicitly configured. */
export class PiRpcAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi coding agent (RPC)';
  private readonly binary: string;
  private readonly graceMs: number;
  private readonly pool: PiRpcPool;
  private identity: AgentBotIdentity | undefined;
  private interactionPort: AgentInteractionPort | undefined;
  private readonly activeByRunId = new Map<string, RpcPoolEntry>();
  private readonly interactionByConnection = new WeakMap<StrictPiRpcConnection, AgentRunOptions>();

  constructor(private readonly opts: PiRpcAdapterOptions) {
    this.binary = opts.binary ?? 'pi';
    this.graceMs = opts.stopGraceMs ?? 5_000;
    this.pool = new PiRpcPool(opts.pool);
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.identity = identity;
  }

  setInteractionPort(port: AgentInteractionPort): void {
    this.interactionPort = port;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const result = await checkPiCompatibility({ binary: this.binary });
      await checkPiRpcCompatibility({ binary: this.binary });
      return { ok: true, version: result.version };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async prepareRun(): Promise<void> {
    await Promise.all([
      mkdir(dirname(this.opts.bridgeSystemPromptFile), { recursive: true, mode: 0o700 }),
      mkdir(this.opts.piSessionDir, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(this.opts.bridgeSystemPromptFile, BRIDGE_SYSTEM_PROMPT, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.opts.bridgeSystemPromptFile, 0o600);
  }

  async probeModel(opts: Omit<AgentRunOptions, 'runId' | 'prompt' | 'sessionId' | 'attachments'>): Promise<void> {
    await this.prepareRun();
    const run = this.run({
      ...opts,
      runId: `doctor-${Date.now()}`,
      scopeId: `doctor-${Date.now()}`,
      policyFingerprint: `doctor-${Date.now()}`,
      prompt: 'Reply exactly: LARK_PI_BRIDGE_DOCTOR_OK',
    });
    let matched = false;
    let terminal: AgentEvent | undefined;
    for await (const event of run.events) {
      if (event.type === 'text' && event.delta.includes('LARK_PI_BRIDGE_DOCTOR_OK')) {
        matched = true;
      }
      if (event.type === 'done' || event.type === 'error') {
        terminal = event;
      }
    }
    if (terminal?.type === 'error') {
      throw new Error(`Pi model probe failed: ${terminal.message}`);
    }
    if (terminal?.type !== 'done' || terminal.terminationReason !== 'normal') {
      throw new Error('Pi model probe did not complete normally');
    }
    if (!matched) {
      throw new Error('Pi model probe response did not contain the expected marker');
    }
  }

  async forkSession(opts: AgentRunOptions): Promise<AgentSessionState> {
    if (!opts.handoff?.sourcePath) {
      throw new Error('Pi fork requires an exact source path resolved by the bridge.');
    }
    return this.withIdleConnection(opts, async (_connection, state) => state, 'session is forked');
  }

  listCommands(opts: AgentRunOptions): Promise<AgentSlashCommand[]> {
    return this.withIdleConnection(opts, (connection) => connection.getCommands(), 'commands are listed');
  }

  getSessionState(opts: AgentRunOptions): Promise<AgentSessionState> {
    return this.withIdleConnection(opts, (connection, state) => Promise.resolve(state), 'state is read');
  }

  listModels(opts: AgentRunOptions): Promise<AgentModelCatalog> {
    return this.withIdleConnection(
      opts,
      async (connection, state) => ({ state, models: await connection.getAvailableModels() }),
      'models are listed',
    );
  }

  setModel(opts: AgentRunOptions, provider: string, modelId: string): Promise<AgentSessionState> {
    return this.withIdleConnection(
      opts,
      async (connection) => {
        await connection.setModel(provider, modelId);
        return connection.getState();
      },
      'model is changed',
    );
  }

  listThinkingLevels(opts: AgentRunOptions): Promise<AgentThinkingSupport> {
    return this.withIdleConnection(
      opts,
      async (connection, state) => ({ state, levels: await connection.getAvailableThinkingLevels() }),
      'thinking levels are listed',
    );
  }

  setThinkingLevel(opts: AgentRunOptions, level: AgentThinkingLevel): Promise<AgentSessionState> {
    return this.withIdleConnection(
      opts,
      async (connection) => {
        await connection.setThinkingLevel(level);
        return connection.getState();
      },
      'thinking level is changed',
    );
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.scopeId || !opts.policyFingerprint) {
      return failedRun(opts.runId, 'Pi RPC requires scopeId and policyFingerprint');
    }
    const completion = deferred<boolean>();
    let currentEntry: RpcPoolEntry | undefined;
    let requestedStop: PiFinishReason | undefined;
    let terminalSeen = false;
    let abortStarted = false;
    const start = this.startRun(
      opts,
      (entry) => {
        currentEntry = entry;
      },
      () => requestedStop,
      () => {
        terminalSeen = true;
        this.activeByRunId.delete(opts.runId);
      },
    );
    const events = this.eventsFor(start, opts, () => requestedStop, completion);
    return {
      runId: opts.runId,
      events,
      stop: async (reason = 'interrupted') => {
        if (terminalSeen) {
          return;
        }
        requestedStop = reason;
        this.interactionPort?.cancelRun(opts.runId);
        const entry = currentEntry;
        entry?.connection.cancelExtensionUIRequests();
        if (!entry || abortStarted) {
          return;
        }
        abortStarted = true;
        try {
          await entry.connection.abort(opts.stopGraceMs ?? this.graceMs);
        } catch {
          await this.pool.invalidate(entry);
        }
      },
      waitForExit: (timeoutMs) => withTimeout(completion.promise, timeoutMs),
    };
  }

  async control(runId: string, kind: 'steer' | 'follow-up', prompt: string): Promise<AgentControlDisposition> {
    const entry = this.activeByRunId.get(runId);
    if (!entry) {
      throw new Error('当前 scope 没有活跃 RPC 运行。');
    }
    const message = buildBridgeUserPrompt(prompt, this.identity);
    return kind === 'steer' ? entry.connection.steer(message) : entry.connection.followUp(message);
  }

  async invalidateSession(opts: AgentRunOptions): Promise<void> {
    if (!opts.scopeId || !opts.policyFingerprint) {
      return;
    }
    await this.pool.invalidateKey(rpcPoolKey(opts));
  }

  async closeIdleSessions(): Promise<void> {
    await this.pool.disposeIdle();
  }

  async dispose(): Promise<void> {
    for (const [runId, entry] of this.activeByRunId) {
      this.interactionPort?.cancelRun(runId);
      entry.connection.cancelExtensionUIRequests();
    }
    this.activeByRunId.clear();
    await this.pool.dispose();
  }

  private async withIdleConnection<T>(
    opts: AgentRunOptions,
    operation: (connection: StrictPiRpcConnection, state: AgentSessionState) => Promise<T>,
    activity: string,
  ): Promise<T> {
    if (!opts.scopeId || !opts.policyFingerprint) {
      throw new Error('Pi RPC requires scopeId and policyFingerprint');
    }
    const key = rpcPoolKey(opts);
    let acquired: Awaited<ReturnType<PiRpcPool['acquire']>>;
    try {
      acquired = await this.pool.acquire(key, async () => this.createConnection(opts));
    } catch (error) {
      throw new RpcCommandError(error instanceof Error ? error.message : String(error), 'not-accepted', true);
    }
    const entry = acquired.entry;
    let invalidate = false;
    try {
      const state = await entry.connection.getState();
      if (opts.sessionId && state.sessionId !== opts.sessionId) {
        throw new RpcCommandError(
          `Pi RPC resumed session ${state.sessionId} but catalog expected ${opts.sessionId}`,
          'not-accepted',
          true,
        );
      }
      if (state.isStreaming) {
        throw new RpcCommandError(`Pi RPC connection is active while ${activity}`, 'not-accepted');
      }
      return await operation(entry.connection, state);
    } catch (error) {
      invalidate = true;
      await this.pool.invalidate(entry);
      throw error;
    } finally {
      entry.connection.cancelExtensionUIRequests();
      this.interactionPort?.cancelRun(opts.runId);
      if (!invalidate && entry.connection.usable) {
        this.pool.release(entry);
      }
    }
  }

  private async startRun(
    opts: AgentRunOptions,
    onEntry: (entry: RpcPoolEntry) => void,
    getStopReason: () => PiFinishReason | undefined,
    onTerminal: () => void,
  ): Promise<{
    entry: RpcPoolEntry;
    sessionId: string;
    disposition: 'started' | 'queued' | 'handled';
    awaitEvents: boolean;
    inbox: RpcEventInbox;
  }> {
    const key = rpcPoolKey(opts);
    let acquired: Awaited<ReturnType<PiRpcPool['acquire']>>;
    try {
      acquired = await this.pool.acquire(key, async () => this.createConnection(opts));
    } catch (error) {
      throw new RpcCommandError(error instanceof Error ? error.message : String(error), 'not-accepted', true);
    }
    let entry = acquired.entry;
    onEntry(entry);
    this.interactionByConnection.set(entry.connection, opts);
    let inbox = createRpcEventInbox(entry.connection, onTerminal, {
      maxItems: this.opts.maxEventQueueItems,
      maxBytes: this.opts.maxEventQueueBytes,
    });
    let promptAttempted = false;
    try {
      let state: Awaited<ReturnType<StrictPiRpcConnection['getState']>>;
      try {
        state = await entry.connection.getState();
      } catch (error) {
        throw new RpcCommandError(error instanceof Error ? error.message : String(error), 'not-accepted', true);
      }
      if (acquired.reused && (opts.sessionId === undefined || state.sessionId !== opts.sessionId)) {
        // `/new` archives the catalog entry, and an externally changed catalog
        // can select another existing session. Never deliver either prompt to
        // a pooled child whose session identity no longer matches.
        inbox.close();
        this.interactionByConnection.delete(entry.connection);
        await this.pool.invalidate(entry);
        acquired = await this.pool.acquire(key, async () => this.createConnection(opts));
        entry = acquired.entry;
        onEntry(entry);
        this.interactionByConnection.set(entry.connection, opts);
        inbox = createRpcEventInbox(entry.connection, onTerminal, {
          maxItems: this.opts.maxEventQueueItems,
          maxBytes: this.opts.maxEventQueueBytes,
        });
        try {
          state = await entry.connection.getState();
        } catch (error) {
          throw new RpcCommandError(error instanceof Error ? error.message : String(error), 'not-accepted', true);
        }
      }
      if (opts.sessionId && state.sessionId !== opts.sessionId) {
        throw new RpcCommandError(
          `Pi RPC resumed session ${state.sessionId} but catalog expected ${opts.sessionId}`,
          'not-accepted',
          true,
        );
      }
      if (state.isStreaming) {
        throw new RpcCommandError('Pi RPC connection was unexpectedly streaming before prompt', 'not-accepted', true);
      }
      if (opts.promptMode === 'pi-command') {
        const name = piCommandName(opts.prompt);
        const commands = await entry.connection.getCommands();
        if (!name || !commands.some((command) => command.name === name)) {
          throw new RpcCommandError(`Pi no longer exposes command /${name ?? ''}`, 'not-accepted');
        }
      }
      const images = await readRpcImages(opts.attachments);
      if (getStopReason()) {
        throw new RpcCommandError('Pi RPC run was stopped before prompt acceptance', 'not-accepted');
      }
      promptAttempted = true;
      const disposition = await entry.connection.prompt(
        opts.promptMode === 'pi-command' ? opts.prompt : buildBridgeUserPrompt(opts.prompt, this.identity),
        images.length ? images : undefined,
        this.opts.promptTimeoutMs,
      );
      let awaitEvents = disposition !== 'handled';
      if (!awaitEvents) {
        awaitEvents = await waitForHandledCommandWork(entry.connection, inbox);
      }
      if (awaitEvents && !inbox.terminal) {
        this.activeByRunId.set(opts.runId, entry);
      } else {
        entry.connection.cancelExtensionUIRequests();
        this.interactionPort?.cancelRun(opts.runId);
      }
      return { entry, sessionId: state.sessionId, disposition, awaitEvents, inbox };
    } catch (error) {
      inbox.close();
      this.interactionByConnection.delete(entry.connection);
      entry.connection.cancelExtensionUIRequests();
      this.interactionPort?.cancelRun(opts.runId);
      const classified =
        error instanceof RpcCommandError
          ? new RpcCommandError(error.message, error.acceptance, error.fallbackSafe)
          : new RpcCommandError(
              error instanceof Error ? error.message : String(error),
              promptAttempted ? 'uncertain' : 'not-accepted',
            );
      await this.pool.invalidate(entry);
      throw classified;
    }
  }

  private async createConnection(opts: AgentRunOptions): Promise<StrictPiRpcConnection> {
    const args = buildPiRpcArgs({
      accessMode: opts.accessMode,
      handoff: Boolean(opts.handoff),
      // Native handoff fork is completed once by PiAdapter before catalog
      // commit. RPC only resumes the committed catalog session.
      sessionDir: this.opts.piSessionDir,
      sessionId: opts.sessionId,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      bridgeSystemPromptFile: this.opts.bridgeSystemPromptFile,
    });
    const child = spawnProcessPrivate(this.binary, args, {
      cwd: opts.cwd,
      env: buildPiChildEnv({
        bridgeEnv: buildLarkChannelEnv(this.opts.larkChannel),
        piConfigDir: opts.handoff
          ? (this.opts.handoffPiConfigDir ?? join(homedir(), '.pi', 'agent'))
          : this.opts.piConfigDir,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiRpcChild;
    log.info('agent', 'pi-rpc-spawn', {
      pid: child.pid ?? null,
      hasSession: Boolean(opts.sessionId),
      accessMode: opts.accessMode,
    });
    if (!child.pid) {
      child.kill('SIGTERM');
      throw new Error('Pi RPC spawn returned no pid');
    }
    const connection = new StrictPiRpcConnection(child, {
      ...this.opts.connection,
      logSensitivePaths: [opts.cwd, this.opts.piSessionDir, this.opts.bridgeSystemPromptFile],
      extensionUIHandler: {
        onRequest: async (request) => {
          const active = this.interactionByConnection.get(connection);
          const port = this.interactionPort;
          if (!active || !port || !active.scopeId || !active.interaction) {
            return request.expectsResponse ? ({ cancelled: true } as const) : undefined;
          }
          return port.handle(
            {
              runId: active.runId,
              scopeId: active.scopeId,
              actorOpenId: active.interaction.actorOpenId,
              surface: active.interaction.surface,
              ...(active.interaction.privateReplyTarget
                ? { privateReplyTarget: active.interaction.privateReplyTarget }
                : {}),
            },
            request.request,
          );
        },
        onPromptLifecycle: () => {
          // Lifecycle is consumed as sideband. The pending dialog itself is
          // owned by the interaction port and never enters the event stream.
        },
      },
    });
    return connection;
  }

  private async *eventsFor(
    started: Promise<{
      entry: RpcPoolEntry;
      sessionId: string;
      disposition: 'started' | 'queued' | 'handled';
      awaitEvents: boolean;
      inbox: RpcEventInbox;
    }>,
    opts: AgentRunOptions,
    getStopReason: () => PiFinishReason | undefined,
    completion: Deferred<boolean>,
  ): AsyncGenerator<AgentEvent> {
    let entry: RpcPoolEntry | undefined;
    try {
      const result = await started;
      entry = result.entry;
      if (!result.awaitEvents) {
        result.inbox.close();
        // Pi 1.0.2 has no authoritative "no future independent work" event
        // for a handled command. Retire the child before yielding anything so
        // consumer cancellation cannot release it back into the pool.
        await this.pool.invalidate(entry);
        yield { type: 'system', sessionId: result.sessionId, cwd: opts.cwd, model: opts.model };
        yield { type: 'done', sessionId: result.sessionId, terminationReason: 'normal' };
        return;
      }
      yield { type: 'system', sessionId: result.sessionId, cwd: opts.cwd, model: opts.model };
      const translator = new PiJsonTranslator({
        knownSensitivePaths: [opts.cwd, this.opts.piSessionDir, this.opts.bridgeSystemPromptFile],
      });
      translator.primeSession(result.sessionId);
      const inbox = result.inbox;
      try {
        while (true) {
          if (inbox.size === 0) {
            if (inbox.failure || !entry.connection.usable) {
              const reason = getStopReason();
              if (reason === 'interrupted' || reason === 'timeout') {
                yield* translator.finish(reason);
              } else {
                yield failure(
                  `Pi RPC connection failed: ${inbox.failure?.message ?? entry.connection.error?.message ?? 'process exited'}`,
                );
              }
              return;
            }
            await inbox.wait();
          }
          while (inbox.size > 0) {
            const raw = inbox.dequeue();
            for (const event of translator.translate(raw)) {
              if (event.type === 'done' || event.type === 'error') {
                // Drain all records delivered in the same event-loop turn before
                // publishing success. This catches a record after agent_settled
                // instead of silently leaving it for an idle pooled connection.
                await settleTerminalEvents();
                if (inbox.failure || inbox.size > 0) {
                  const protocolError = new Error(
                    inbox.failure?.message ?? 'Pi RPC emitted an event after the terminal boundary',
                  );
                  await this.pool.invalidate(entry);
                  yield failure(`Pi RPC protocol error: ${protocolError.message}`);
                  return;
                }
                const stopReason = getStopReason();
                if (stopReason === 'interrupted' || stopReason === 'timeout') {
                  yield { type: 'done', sessionId: result.sessionId, terminationReason: stopReason };
                } else {
                  yield event;
                }
                return;
              }
              yield event;
            }
          }
        }
      } catch (error) {
        if (error instanceof RpcCommandError && error.acceptance === 'not-accepted') {
          yield failure(`Pi RPC command was rejected: ${error.message}`);
        } else {
          yield failure(`Pi RPC protocol error: ${error instanceof Error ? error.message : String(error)}`);
        }
        await this.pool.invalidate(entry);
      } finally {
        inbox.close();
      }
    } catch (error) {
      const stopReason = getStopReason();
      if (stopReason === 'interrupted' || stopReason === 'timeout') {
        yield { type: 'done', terminationReason: stopReason };
        return;
      }
      if (error instanceof RpcCommandError && error.fallbackSafe) {
        throw error;
      }
      yield failure(
        `Pi RPC start failed [${error instanceof RpcCommandError ? error.acceptance : 'internal'}]: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.activeByRunId.delete(opts.runId);
      this.interactionPort?.cancelRun(opts.runId);
      if (entry) {
        if (this.interactionByConnection.get(entry.connection) === opts) {
          this.interactionByConnection.delete(entry.connection);
        }
        if (entry.connection.usable) {
          this.pool.release(entry);
        } else {
          await this.pool.invalidate(entry);
        }
      }
      completion.resolve(true);
    }
  }
}

interface RpcEventInbox {
  readonly size: number;
  readonly terminal: boolean;
  failure?: Error;
  dequeue(): unknown;
  wait(): Promise<void>;
  close(): void;
}

interface RpcEventInboxOptions {
  maxItems?: number;
  maxBytes?: number;
}

function createRpcEventInbox(
  connection: StrictPiRpcConnection,
  onTerminal: () => void,
  options: RpcEventInboxOptions = {},
): RpcEventInbox {
  const queue: unknown[] = [];
  const maxItems = positiveInteger(options.maxItems, 4_096, 'maxEventQueueItems');
  const maxBytes = positiveInteger(options.maxBytes, 16 * 1024 * 1024, 'maxEventQueueBytes');
  let queuedBytes = 0;
  let failure: Error | undefined;
  let terminal = false;
  let resolveNext: (() => void) | undefined;
  const unsubscribe = connection.onEvent((event) => {
    if (terminal) {
      const error = new Error('Pi RPC emitted an event after the terminal boundary');
      failure = error;
      connection.terminate(error);
      resolveNext?.();
      resolveNext = undefined;
      return;
    }
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    if (queue.length + 1 > maxItems || queuedBytes + eventBytes > maxBytes) {
      const error = new Error('Pi RPC event queue exceeded its bounded capacity');
      failure = error;
      connection.terminate(error);
      resolveNext?.();
      resolveNext = undefined;
      return;
    }
    queue.push(event);
    queuedBytes += eventBytes;
    if (isAgentSettled(event)) {
      terminal = true;
      onTerminal();
    }
    resolveNext?.();
    resolveNext = undefined;
  });
  const unsubscribeFailure = connection.onFailure((error) => {
    failure = error;
    resolveNext?.();
    resolveNext = undefined;
  });
  return {
    get size() {
      return queue.length;
    },
    get terminal() {
      return terminal;
    },
    get failure() {
      return failure;
    },
    dequeue() {
      const value = queue.shift();
      if (value !== undefined) {
        queuedBytes -= Buffer.byteLength(JSON.stringify(value), 'utf8');
      }
      return value;
    },
    wait: () =>
      new Promise<void>((resolve) => {
        if (queue.length || failure || !connection.usable) {
          resolve();
        } else {
          resolveNext = resolve;
        }
      }),
    close() {
      unsubscribe();
      unsubscribeFailure();
      resolveNext?.();
      resolveNext = undefined;
    },
  };
}

function isAgentSettled(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'agent_settled',
  );
}

function piCommandName(prompt: string): string | undefined {
  if (!prompt.startsWith('/')) {
    return undefined;
  }
  const name = prompt.slice(1).split(/\s+/, 1)[0];
  return name || undefined;
}

function rpcPoolKey(opts: AgentRunOptions): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        scopeId: opts.scopeId,
        cwd: opts.cwd,
        policyFingerprint: opts.policyFingerprint,
        model: opts.model ?? null,
        thinkingLevel: opts.thinkingLevel ?? null,
        handoffSourceSessionId: opts.handoff?.sourceSessionId ?? null,
        approval: opts.handoff ? 'approve' : 'no-approve',
        accessMode: opts.handoff ? 'full' : opts.accessMode,
        // Session identity is authoritatively checked with get_state on every
        // acquire; keeping this stable permits the just-created session child
        // to serve the next catalog-resumed turn.
        sessionId: null,
      }),
    )
    .digest('base64url');
}

function failedRun(runId: string, message: string): AgentRun {
  return {
    runId,
    events: {
      async *[Symbol.asyncIterator]() {
        yield failure(message);
      },
    },
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

function failure(message: string): AgentEvent {
  return { type: 'error', message: truncate(message, 4_096), terminationReason: 'failed' };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const HANDLED_COMMAND_QUIESCENCE_MS = 250;

async function waitForHandledCommandWork(connection: StrictPiRpcConnection, inbox: RpcEventInbox): Promise<boolean> {
  const deadline = Date.now() + HANDLED_COMMAND_QUIESCENCE_MS;
  do {
    await settleTerminalEvents();
    const state = await connection.getState();
    if (state.isStreaming || inbox.size > 0) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, remaining));
        timer.unref();
      });
    }
  } while (Date.now() < deadline);
  const state = await connection.getState();
  return state.isStreaming || inbox.size > 0;
}

async function settleTerminalEvents(): Promise<void> {
  // stdout chunks can be split after agent_settled even when Pi wrote adjacent
  // records. Cross both the timers and check phases before publishing success.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function withTimeout(value: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    value,
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
}
