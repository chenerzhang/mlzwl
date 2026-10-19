import { log } from '../../core/logger.js';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentBotIdentity,
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
import { RpcCommandError } from './rpc-connection.js';

/**
 * RPC-first adapter with a deliberately narrow fallback boundary. It replays a
 * prompt only when RPC proves it was rejected before acceptance.
 */
export class PiRpcFallbackAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi coding agent (RPC with safe spawn fallback)';

  constructor(
    private readonly rpc: AgentAdapter,
    private readonly spawnPerTurn: AgentAdapter,
  ) {}

  setBotIdentity(identity: AgentBotIdentity): void {
    this.rpc.setBotIdentity?.(identity);
    this.spawnPerTurn.setBotIdentity?.(identity);
  }

  setInteractionPort(port: AgentInteractionPort): void {
    this.rpc.setInteractionPort?.(port);
    this.spawnPerTurn.setInteractionPort?.(port);
  }

  isAvailable(): Promise<boolean> {
    return this.rpc.isAvailable();
  }

  checkAvailability(): Promise<AgentAvailability> {
    return (
      this.rpc.checkAvailability?.() ??
      this.rpc.isAvailable().then((ok) => (ok ? { ok: true } : { ok: false, error: new Error('Pi RPC unavailable') }))
    );
  }

  async prepareRun(opts?: AgentRunOptions): Promise<void> {
    await this.rpc.prepareRun?.(opts);
  }

  probeModel(opts: Omit<AgentRunOptions, 'runId' | 'prompt' | 'sessionId' | 'attachments'>): Promise<void> {
    if (!this.rpc.probeModel) {
      return Promise.reject(new Error('Pi RPC model probe is unavailable'));
    }
    return this.rpc.probeModel(opts);
  }

  forkSession(opts: AgentRunOptions): Promise<AgentSessionState> {
    // Native fork is a local pre-prompt operation. Spawn-per-turn reads the
    // authoritative JSON session event and cannot accidentally replay a model
    // prompt across transports.
    if (!this.spawnPerTurn.forkSession) {
      return Promise.reject(new Error('当前 adapter 不支持原生 Pi session fork。'));
    }
    return this.spawnPerTurn.forkSession(opts);
  }

  listCommands(opts: AgentRunOptions): Promise<AgentSlashCommand[]> {
    if (!this.rpc.listCommands) {
      return Promise.reject(new Error('当前 RPC adapter 不支持 /pi 命令。'));
    }
    return this.rpc.listCommands(opts);
  }

  getSessionState(opts: AgentRunOptions): Promise<AgentSessionState> {
    if (!this.rpc.getSessionState) {
      return Promise.reject(unsupportedModelControl());
    }
    return this.rpc.getSessionState(opts);
  }

  listModels(opts: AgentRunOptions): Promise<AgentModelCatalog> {
    if (!this.rpc.listModels) {
      return Promise.reject(unsupportedModelControl());
    }
    return this.rpc.listModels(opts);
  }

  setModel(opts: AgentRunOptions, provider: string, modelId: string): Promise<AgentSessionState> {
    if (!this.rpc.setModel) {
      return Promise.reject(unsupportedModelControl());
    }
    return this.rpc.setModel(opts, provider, modelId);
  }

  listThinkingLevels(opts: AgentRunOptions): Promise<AgentThinkingSupport> {
    if (!this.rpc.listThinkingLevels) {
      return Promise.reject(unsupportedModelControl());
    }
    return this.rpc.listThinkingLevels(opts);
  }

  setThinkingLevel(opts: AgentRunOptions, level: AgentThinkingLevel): Promise<AgentSessionState> {
    if (!this.rpc.setThinkingLevel) {
      return Promise.reject(unsupportedModelControl());
    }
    return this.rpc.setThinkingLevel(opts, level);
  }

  invalidateSession(opts: AgentRunOptions): Promise<void> {
    return this.rpc.invalidateSession?.(opts) ?? Promise.resolve();
  }

  run(opts: AgentRunOptions): AgentRun {
    const rpcRun = this.rpc.run(opts);
    let active = rpcRun;
    const spawnPerTurn = this.spawnPerTurn;
    let stopped: 'interrupted' | 'timeout' | undefined;
    let settle: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return {
      runId: opts.runId,
      events: {
        async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          try {
            const iterator = rpcRun.events[Symbol.asyncIterator]();
            let first: IteratorResult<AgentEvent>;
            try {
              first = await iterator.next();
            } catch (error) {
              if (!(error instanceof RpcCommandError) || !error.fallbackSafe) {
                throw error;
              }
              if (opts.promptMode === 'pi-command' || opts.handoff) {
                throw new Error(
                  opts.handoff
                    ? 'handoff 运行不会跨 transport 重放；请重试。'
                    : '/pi 命令无法安全回退到 spawn-per-turn transport。',
                  { cause: error },
                );
              }
              log.warn('agent', 'pi-rpc-safe-fallback', { reason: 'prompt-not-accepted' });
              await spawnPerTurn.prepareRun?.(opts);
              const fallback = spawnPerTurn.run(opts);
              active = fallback;
              if (stopped) {
                await fallback.stop(stopped);
              }
              for await (const event of fallback.events) {
                yield event;
              }
              return;
            }
            if (!first.done) {
              yield first.value;
            }
            while (true) {
              const next = await iterator.next();
              if (next.done) {
                return;
              }
              yield next.value;
            }
          } finally {
            settle?.();
          }
        },
      },
      async stop(reason = 'interrupted') {
        stopped = reason;
        await active.stop(reason);
      },
      async waitForExit(timeoutMs) {
        return Promise.race([
          completed.then(() => true),
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs);
            timer.unref();
          }),
        ]);
      },
    };
  }

  control(runId: string, kind: 'steer' | 'follow-up', prompt: string) {
    if (!this.rpc.control) {
      throw new Error('当前 RPC adapter 不支持 steer/follow-up。');
    }
    return this.rpc.control(runId, kind, prompt);
  }

  async closeIdleSessions(): Promise<void> {
    await Promise.all([this.rpc.closeIdleSessions?.(), this.spawnPerTurn.closeIdleSessions?.()]);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.rpc.dispose?.(), this.spawnPerTurn.dispose?.()]);
  }
}

function unsupportedModelControl(): Error {
  return new Error('当前 RPC adapter 不支持模型与思考级别控制。');
}
