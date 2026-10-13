import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentInteractionContext, AgentRun, AgentSlashCommand } from '../agent/types.js';
import type { AccessMode } from '../config/permissions.js';

export interface RunRequest {
  scopeId: string;
  prompt: string;
  cwd: string;
  accessMode: AccessMode;
  sessionId?: string;
  model?: string;
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

export class RunExecutor {
  private active = new Map<string, AgentRun>();
  private starting = new Set<string>();
  constructor(
    private readonly agent: AgentAdapter,
    private readonly maxConcurrent = 10,
  ) {}

  async submit(request: RunRequest): Promise<{ run: AgentRun; events: AsyncIterable<AgentEvent> }> {
    if (this.active.has(request.scopeId) || this.starting.has(request.scopeId)) {
      throw new ScopeBusyError(request.scopeId);
    }
    if (this.active.size + this.starting.size >= this.maxConcurrent) {
      throw new ProcessPoolFullError();
    }
    this.starting.add(request.scopeId);
    try {
      const runOptions = {
        runId: randomUUID(),
        scopeId: request.scopeId,
        policyFingerprint: request.policyFingerprint,
        prompt: request.prompt,
        promptMode: request.promptMode,
        interaction: request.interaction,
        cwd: request.cwd,
        accessMode: request.accessMode,
        sessionId: request.sessionId,
        model: request.model,
        stopGraceMs: request.stopGraceMs,
        attachments: request.attachments,
      };
      await this.agent.prepareRun?.(runOptions);
      const run = this.agent.run(runOptions);
      this.active.set(request.scopeId, run);
      const active = this.active;
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
    } finally {
      this.starting.delete(request.scopeId);
    }
  }

  async listCommands(request: Omit<RunRequest, 'prompt' | 'attachments' | 'promptMode'>): Promise<AgentSlashCommand[]> {
    if (!this.agent.listCommands) {
      throw new Error('当前 transport 不支持 /pi 命令。');
    }
    if (this.active.has(request.scopeId) || this.starting.has(request.scopeId)) {
      throw new ScopeBusyError(request.scopeId);
    }
    if (this.active.size + this.starting.size >= this.maxConcurrent) {
      throw new ProcessPoolFullError();
    }
    this.starting.add(request.scopeId);
    try {
      const options = {
        ...request,
        runId: randomUUID(),
        prompt: '/pi commands',
      };
      await this.agent.prepareRun?.(options);
      return await this.agent.listCommands(options);
    } finally {
      this.starting.delete(request.scopeId);
    }
  }

  async stop(scopeId: string, reason: 'interrupted' | 'timeout' = 'interrupted'): Promise<void> {
    await this.active.get(scopeId)?.stop(reason);
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
  activity(): { active: number; starting: number; scopes: string[] } {
    return { active: this.active.size, starting: this.starting.size, scopes: [...this.active.keys()] };
  }
}
