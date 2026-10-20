import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentEvent,
  AgentInteractionContext,
  AgentModelCatalog,
  AgentRun,
  AgentRunOptions,
  AgentSessionState,
  AgentSlashCommand,
  AgentThinkingLevel,
  AgentThinkingSupport,
} from '../agent/types.js';
import type { AccessMode } from '../config/permissions.js';

export interface RunRequest {
  scopeId: string;
  prompt: string;
  cwd: string;
  accessMode: AccessMode;
  handoff?: { sourcePath?: string; sourceSessionId: string };
  sessionId?: string;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  stopGraceMs?: number;
  attachments?: string[];
  policyFingerprint?: string;
  promptMode?: 'bridge' | 'pi-command';
  interaction?: Omit<AgentInteractionContext, 'runId' | 'scopeId'>;
}

export class ScopeBusyError extends Error {
  constructor(readonly scopeId: string) {
    super('another run is already active for this scope');
    this.name = 'ScopeBusyError';
  }
}

export class ProcessPoolFullError extends Error {
  constructor() {
    super('process pool is full');
    this.name = 'ProcessPoolFullError';
  }
}

export interface ScopeLease {
  submit(request: RunRequest): Promise<{ run: AgentRun; events: AsyncIterable<AgentEvent> }>;
  listCommands(request: Omit<RunRequest, 'prompt' | 'attachments' | 'promptMode'>): Promise<AgentSlashCommand[]>;
  getSessionState(request: IdleSessionRequest): Promise<AgentSessionState>;
  listModels(request: IdleSessionRequest): Promise<AgentModelCatalog>;
  setModel(request: IdleSessionRequest, provider: string, modelId: string): Promise<AgentSessionState>;
  listThinkingLevels(request: IdleSessionRequest): Promise<AgentThinkingSupport>;
  setThinkingLevel(request: IdleSessionRequest, level: AgentThinkingLevel): Promise<AgentSessionState>;
  invalidateSession(request: IdleSessionRequest): Promise<void>;
  forkSession(request: IdleSessionRequest): Promise<AgentSessionState>;
}

export class RunExecutor {
  private active = new Map<string, AgentRun>();
  private starting = new Map<string, symbol>();
  private leases = new Map<string, symbol>();
  constructor(
    private readonly agent: AgentAdapter,
    private readonly maxConcurrent = 10,
  ) {}

  async submit(request: RunRequest): Promise<{ run: AgentRun; events: AsyncIterable<AgentEvent> }> {
    return this.withScopeLease(request.scopeId, (lease) => lease.submit(request));
  }

  private async submitWithinLease(
    request: RunRequest,
    token: symbol,
    submitted: { value: boolean },
  ): Promise<{ run: AgentRun; events: AsyncIterable<AgentEvent> }> {
    this.assertLease(request.scopeId, token);
    if (submitted.value) {
      throw new Error('scope lease submit may only be called once');
    }
    submitted.value = true;
    const runOptions = {
      runId: randomUUID(),
      scopeId: request.scopeId,
      policyFingerprint: request.policyFingerprint,
      prompt: request.prompt,
      promptMode: request.promptMode,
      interaction: request.interaction,
      cwd: request.cwd,
      accessMode: request.accessMode,
      handoff: request.handoff,
      sessionId: request.sessionId,
      model: request.model,
      thinkingLevel: request.thinkingLevel,
      stopGraceMs: request.stopGraceMs,
      attachments: request.attachments,
    };
    await this.agent.prepareRun?.(runOptions);
    const run = this.agent.run(runOptions);
    this.active.set(request.scopeId, run);
    const active = this.active;
    if (this.starting.get(request.scopeId) === token) {
      this.starting.delete(request.scopeId);
    }
    return {
      run,
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          try {
            for await (const event of run.events) {
              yield event;
            }
          } finally {
            active.delete(request.scopeId);
          }
        },
      },
    };
  }

  listCommands(request: Omit<RunRequest, 'prompt' | 'attachments' | 'promptMode'>): Promise<AgentSlashCommand[]> {
    return this.withScopeLease(request.scopeId, (lease) => lease.listCommands(request));
  }

  forkSession(request: IdleSessionRequest): Promise<AgentSessionState> {
    return this.withScopeLease(request.scopeId, (lease) => lease.forkSession(request));
  }

  /** Atomically excludes every active/starting operation for one scope. The lease API is deliberately non-reentrant. */
  async withScopeLease<T>(scopeId: string, operation: (lease: ScopeLease) => Promise<T>): Promise<T> {
    const token = Symbol(scopeId);
    this.acquireStarting(scopeId, token);
    this.leases.set(scopeId, token);
    const submitted = { value: false };
    const idle = <TValue>(request: IdleSessionRequest, action: (options: AgentRunOptions) => Promise<TValue>) =>
      this.runIdleWithinLease(request, token, action);
    const lease: ScopeLease = {
      submit: (request) => this.submitWithinLease(request, token, submitted),
      listCommands: (request) =>
        idle(request, async (options) => {
          if (!this.agent.listCommands) {
            throw new Error('当前 transport 不支持 /pi 命令。');
          }
          return this.agent.listCommands({ ...options, prompt: '/pi commands' });
        }),
      getSessionState: (request) =>
        idle(request, async (options) => {
          if (!this.agent.getSessionState) {
            throw unsupportedModelControl();
          }
          return this.agent.getSessionState(options);
        }),
      listModels: (request) =>
        idle(request, async (options) => {
          if (!this.agent.listModels) {
            throw unsupportedModelControl();
          }
          return this.agent.listModels(options);
        }),
      setModel: (request, provider, modelId) =>
        idle(request, async (options) => {
          if (!this.agent.setModel) {
            throw unsupportedModelControl();
          }
          return this.agent.setModel(options, provider, modelId);
        }),
      listThinkingLevels: (request) =>
        idle(request, async (options) => {
          if (!this.agent.listThinkingLevels) {
            throw unsupportedModelControl();
          }
          return this.agent.listThinkingLevels(options);
        }),
      setThinkingLevel: (request, level) =>
        idle(request, async (options) => {
          if (!this.agent.setThinkingLevel) {
            throw unsupportedModelControl();
          }
          return this.agent.setThinkingLevel(options, level);
        }),
      invalidateSession: async (request) => {
        this.assertLease(request.scopeId, token);
        await this.agent.invalidateSession?.({ ...request, runId: randomUUID(), prompt: '/bridge-session-invalidate' });
      },
      forkSession: (request) => idle(request, (options) => this.forkWithOptions(options)),
    };
    try {
      return await operation(lease);
    } finally {
      if (this.starting.get(scopeId) === token) {
        this.starting.delete(scopeId);
      }
      if (this.leases.get(scopeId) === token) {
        this.leases.delete(scopeId);
      }
    }
  }

  getSessionState(request: IdleSessionRequest): Promise<AgentSessionState> {
    return this.withScopeLease(request.scopeId, (lease) => lease.getSessionState(request));
  }

  listModels(request: IdleSessionRequest): Promise<AgentModelCatalog> {
    return this.withScopeLease(request.scopeId, (lease) => lease.listModels(request));
  }

  setModel(request: IdleSessionRequest, provider: string, modelId: string): Promise<AgentSessionState> {
    return this.withScopeLease(request.scopeId, (lease) => lease.setModel(request, provider, modelId));
  }

  listThinkingLevels(request: IdleSessionRequest): Promise<AgentThinkingSupport> {
    return this.withScopeLease(request.scopeId, (lease) => lease.listThinkingLevels(request));
  }

  setThinkingLevel(request: IdleSessionRequest, level: AgentThinkingLevel): Promise<AgentSessionState> {
    return this.withScopeLease(request.scopeId, (lease) => lease.setThinkingLevel(request, level));
  }

  invalidateSession(request: IdleSessionRequest): Promise<void> {
    return this.withScopeLease(request.scopeId, (lease) => lease.invalidateSession(request));
  }

  async stop(
    scopeId: string,
    reason: 'interrupted' | 'timeout' = 'interrupted',
  ): Promise<'stopped' | 'starting' | 'idle'> {
    const run = this.active.get(scopeId);
    if (run) {
      await run.stop(reason);
      return 'stopped';
    }
    return this.starting.has(scopeId) ? 'starting' : 'idle';
  }
  async control(scopeId: string, kind: 'steer' | 'follow-up', prompt: string): Promise<'queued' | 'handled'> {
    const run = this.active.get(scopeId);
    if (!run) {
      throw new Error('当前 scope 没有活跃 Pi 运行。');
    }
    if (!this.agent.control) {
      throw new Error('当前 transport 不支持运行中 steer/follow-up。');
    }
    return this.agent.control(run.runId, kind, prompt);
  }
  activeScopes(): string[] {
    return [...this.active.keys()];
  }
  isScopeBusy(scopeId: string): boolean {
    return this.active.has(scopeId) || this.starting.has(scopeId);
  }
  activity(): { active: number; starting: number; scopes: string[] } {
    return {
      active: this.active.size,
      starting: this.starting.size,
      scopes: [...new Set([...this.active.keys(), ...this.starting.keys()])],
    };
  }

  private runIdleWithinLease<T>(
    request: IdleSessionRequest,
    token: symbol,
    operation: (options: AgentRunOptions) => Promise<T>,
  ): Promise<T> {
    return this.runPreparedWithinLease(request, token, operation);
  }

  private async runPreparedWithinLease<T>(
    request: IdleSessionRequest,
    token: symbol,
    operation: (options: AgentRunOptions) => Promise<T>,
  ): Promise<T> {
    this.assertLease(request.scopeId, token);
    const options = { ...request, runId: randomUUID(), prompt: '/bridge-session-control' };
    await this.agent.prepareRun?.(options);
    return operation(options);
  }

  private assertLease(scopeId: string, token: symbol): void {
    if (this.leases.get(scopeId) !== token) {
      throw new Error('scope lease is required');
    }
  }

  private acquireStarting(scopeId: string, token: symbol): void {
    if (this.active.has(scopeId) || this.starting.has(scopeId)) {
      throw new ScopeBusyError(scopeId);
    }
    if (this.active.size + this.starting.size >= this.maxConcurrent) {
      throw new ProcessPoolFullError();
    }
    this.starting.set(scopeId, token);
  }

  private forkWithOptions(options: AgentRunOptions): Promise<AgentSessionState> {
    if (!this.agent.forkSession) {
      throw new Error('当前 transport 不支持原生 Pi session fork。');
    }
    return this.agent.forkSession(options);
  }
}

type IdleSessionRequest = Omit<RunRequest, 'prompt' | 'attachments' | 'promptMode'>;

function unsupportedModelControl(): Error {
  return new Error('当前 transport 不支持模型与思考级别控制；请使用 RPC transport。');
}
