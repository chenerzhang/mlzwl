import { describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRun, AgentRunOptions } from '../../src/agent/types.js';
import { RunExecutor } from '../../src/runtime/run-executor.js';

describe('RunExecutor', () => {
  it('rejects a second concurrent run in the same scope and releases it after stream consumption', async () => {
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi',
      async isAvailable() {
        return true;
      },
      run(opts: AgentRunOptions): AgentRun {
        return {
          runId: opts.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'system' as const, sessionId: 'session-a' };
              yield { type: 'done' as const, terminationReason: 'normal' as const };
            },
          },
          async stop(_reason) {},
          async waitForExit() {
            return true;
          },
        };
      },
    };
    const executor = new RunExecutor(adapter, 2);
    const first = await executor.submit({ scopeId: 'chat-a', prompt: 'one', cwd: '/tmp', accessMode: 'full' });
    await expect(
      executor.submit({ scopeId: 'chat-a', prompt: 'two', cwd: '/tmp', accessMode: 'full' }),
    ).rejects.toThrow(/already active/);
    for await (const _ of first.events) {
      /* drain */
    }
    const second = await executor.submit({ scopeId: 'chat-a', prompt: 'three', cwd: '/tmp', accessMode: 'full' });
    for await (const _ of second.events) {
      /* drain */
    }
  });

  it('routes explicit steer/follow-up only to the active run without submitting another prompt', async () => {
    const control = vi.fn(async () => 'queued' as const);
    let release: (() => void) | undefined;
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi RPC',
      async isAvailable() {
        return true;
      },
      control,
      run(opts: AgentRunOptions): AgentRun {
        return {
          runId: opts.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              yield { type: 'done' as const, terminationReason: 'normal' as const };
            },
          },
          async stop() {},
          async waitForExit() {
            return true;
          },
        };
      },
    };
    const executor = new RunExecutor(adapter, 1);
    const running = await executor.submit({ scopeId: 'chat-a', prompt: 'one', cwd: '/tmp', accessMode: 'full' });
    expect(await executor.control('chat-a', 'steer', 'change')).toBe('queued');
    expect(control).toHaveBeenCalledWith(running.run.runId, 'steer', 'change');
    await expect(executor.control('chat-b', 'follow-up', 'later')).rejects.toThrow(/没有活跃/);
    const drained = (async () => {
      for await (const _ of running.events) {
        /* drain */
      }
    })();
    await Promise.resolve();
    release?.();
    await drained;
  });

  it('rejects control commands for spawn-per-turn even while its run is active', async () => {
    let release: (() => void) | undefined;
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi spawn',
      async isAvailable() {
        return true;
      },
      run(opts: AgentRunOptions): AgentRun {
        return {
          runId: opts.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              yield { type: 'done' as const, terminationReason: 'normal' as const };
            },
          },
          async stop() {},
          async waitForExit() {
            return true;
          },
        };
      },
    };
    const executor = new RunExecutor(adapter, 1);
    const running = await executor.submit({ scopeId: 'chat-a', prompt: 'one', cwd: '/tmp', accessMode: 'full' });
    await expect(executor.control('chat-a', 'steer', 'change')).rejects.toThrow(/transport 不支持/);
    const drained = (async () => {
      for await (const _ of running.events) {
        /* drain */
      }
    })();
    await Promise.resolve();
    release?.();
    await drained;
  });

  it('lists Pi commands under the same scope and global concurrency boundaries', async () => {
    const listCommands = vi.fn(async () => [{ name: 'plan', source: 'extension' as const }]);
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi RPC',
      async isAvailable() {
        return true;
      },
      listCommands,
      run(opts: AgentRunOptions): AgentRun {
        return {
          runId: opts.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const, terminationReason: 'normal' as const };
            },
          },
          async stop() {},
          async waitForExit() {
            return true;
          },
        };
      },
    };
    const executor = new RunExecutor(adapter, 1);
    await expect(executor.listCommands({ scopeId: 'chat-a', cwd: '/tmp', accessMode: 'full' })).resolves.toEqual([
      { name: 'plan', source: 'extension' },
    ]);
    expect(listCommands).toHaveBeenCalledWith(
      expect.objectContaining({ scopeId: 'chat-a', prompt: '/pi commands', cwd: '/tmp', accessMode: 'full' }),
    );
    const running = await executor.submit({ scopeId: 'chat-a', prompt: 'one', cwd: '/tmp', accessMode: 'full' });
    await expect(executor.listCommands({ scopeId: 'chat-b', cwd: '/tmp', accessMode: 'full' })).rejects.toThrow(
      /pool is full/,
    );
    for await (const _ of running.events) {
      /* drain */
    }
  });

  it('runs model and thinking controls under the idle scope boundary', async () => {
    const state = {
      sessionId: 'session-a',
      isStreaming: false,
      model: { provider: 'provider-a', id: 'model-a', reasoning: true },
      thinkingLevel: 'medium' as const,
    };
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi RPC',
      async isAvailable() {
        return true;
      },
      getSessionState: vi.fn(async () => state),
      listModels: vi.fn(async () => ({ state, models: [state.model] })),
      setModel: vi.fn(async (_opts, provider, modelId) => ({
        ...state,
        model: { provider, id: modelId, reasoning: false },
      })),
      listThinkingLevels: vi.fn(async () => ({
        state,
        levels: ['off', 'medium', 'high'] as Array<'off' | 'medium' | 'high'>,
      })),
      setThinkingLevel: vi.fn(async (_opts, thinkingLevel) => ({ ...state, thinkingLevel })),
      run() {
        throw new Error('not used');
      },
    };
    const executor = new RunExecutor(adapter, 1);
    const request = { scopeId: 'chat-a', cwd: '/tmp', accessMode: 'full' as const, sessionId: 'session-a' };
    await expect(executor.getSessionState(request)).resolves.toEqual(state);
    await expect(executor.listModels(request)).resolves.toEqual({ state, models: [state.model] });
    await expect(executor.setModel(request, 'provider-a', 'model-b')).resolves.toMatchObject({
      model: { provider: 'provider-a', id: 'model-b' },
    });
    await expect(executor.listThinkingLevels(request)).resolves.toEqual({
      state,
      levels: ['off', 'medium', 'high'],
    });
    await expect(executor.setThinkingLevel(request, 'high')).resolves.toMatchObject({ thinkingLevel: 'high' });
  });

  it('rejects model controls for spawn-per-turn transport', async () => {
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi spawn',
      async isAvailable() {
        return true;
      },
      run() {
        throw new Error('not used');
      },
    };
    const executor = new RunExecutor(adapter, 1);
    await expect(executor.listModels({ scopeId: 'chat-a', cwd: '/tmp', accessMode: 'full' })).rejects.toThrow(
      /RPC transport/,
    );
  });

  it('atomically excludes runs and idle operations while a scope lease is held and reports starting stop safely', async () => {
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi',
      async isAvailable() {
        return true;
      },
      run() {
        throw new Error('must not run');
      },
      async getSessionState() {
        return { sessionId: 'session-a', isStreaming: false };
      },
    };
    const executor = new RunExecutor(adapter);
    let release!: () => void;
    const lease = executor.withScopeLease('chat-a', () => new Promise<void>((resolve) => (release = resolve)));
    expect(executor.activity()).toMatchObject({ starting: 1, scopes: ['chat-a'] });
    await expect(executor.withScopeLease('chat-a', async () => {})).rejects.toThrow(/already active/);
    expect(await executor.stop('chat-a')).toBe('starting');
    await expect(
      executor.submit({ scopeId: 'chat-a', prompt: 'blocked', cwd: '/tmp', accessMode: 'full' }),
    ).rejects.toThrow(/already active/);
    await expect(executor.getSessionState({ scopeId: 'chat-a', cwd: '/tmp', accessMode: 'full' })).rejects.toThrow(
      /already active/,
    );
    release();
    await lease;
    expect(executor.isScopeBusy('chat-a')).toBe(false);
  });

  it('converts a leased raw Pi submit from starting to active without double-counting capacity', async () => {
    let release!: () => void;
    const stop = vi.fn(async () => {});
    const control = vi.fn(async () => 'queued' as const);
    const prepareRun = vi.fn(async () => {});
    const run = vi.fn((opts: AgentRunOptions): AgentRun => ({
      runId: opts.runId,
      events: {
        async *[Symbol.asyncIterator]() {
          if (opts.scopeId === 'chat-a') {
            await new Promise<void>((resolve) => (release = resolve));
          }
          yield { type: 'done' as const, terminationReason: 'normal' as const };
        },
      },
      stop,
      async waitForExit() {
        return true;
      },
    }));
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi RPC',
      async isAvailable() {
        return true;
      },
      prepareRun,
      control,
      run,
    };
    const executor = new RunExecutor(adapter, 2);
    const raw = await executor.withScopeLease('chat-a', (lease) =>
      lease.submit({
        scopeId: 'chat-a',
        prompt: '/plan',
        promptMode: 'pi-command',
        cwd: '/tmp',
        accessMode: 'full',
      }),
    );
    expect(executor.activity()).toMatchObject({ active: 1, starting: 0 });
    const second = await executor.submit({ scopeId: 'chat-b', prompt: 'two', cwd: '/tmp', accessMode: 'full' });
    expect(executor.activity()).toMatchObject({ active: 2, starting: 0 });
    expect(await executor.control('chat-a', 'steer', 'change')).toBe('queued');
    expect(await executor.stop('chat-a')).toBe('stopped');
    expect(prepareRun).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(2);
    const drain = (async () => {
      for await (const _ of raw.events) {
        /* drain */
      }
    })();
    await Promise.resolve();
    release();
    await drain;
    for await (const _ of second.events) {
      /* drain */
    }
  });

  it.each(['prepare', 'submit'] as const)('releases a leased reservation after %s failure', async (failure) => {
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi RPC',
      async isAvailable() {
        return true;
      },
      async prepareRun() {
        if (failure === 'prepare') {
          throw new Error('prepare failed');
        }
      },
      run() {
        throw new Error('submit failed');
      },
    };
    const executor = new RunExecutor(adapter, 1);
    await expect(
      executor.withScopeLease('chat-a', (lease) =>
        lease.submit({ scopeId: 'chat-a', prompt: '/plan', cwd: '/tmp', accessMode: 'full' }),
      ),
    ).rejects.toThrow(/failed/);
    expect(executor.activity()).toMatchObject({ active: 0, starting: 0 });
  });

  it('rejects stale lease calls and a second submit from the same lease token', async () => {
    let stale: Parameters<Parameters<RunExecutor['withScopeLease']>[1]>[0] | undefined;
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi',
      async isAvailable() {
        return true;
      },
      run(opts): AgentRun {
        return {
          runId: opts.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const, terminationReason: 'normal' as const };
            },
          },
          async stop() {},
          async waitForExit() {
            return true;
          },
        };
      },
    };
    const executor = new RunExecutor(adapter, 2);
    const first = await executor.withScopeLease('chat-a', async (lease) => {
      stale = lease;
      const execution = await lease.submit({ scopeId: 'chat-a', prompt: 'one', cwd: '/tmp', accessMode: 'full' });
      await expect(lease.submit({ scopeId: 'chat-a', prompt: 'two', cwd: '/tmp', accessMode: 'full' })).rejects.toThrow(
        /only be called once/,
      );
      return execution;
    });
    for await (const _ of first.events) {
      /* drain */
    }
    await expect(stale!.getSessionState({ scopeId: 'chat-a', cwd: '/tmp', accessMode: 'full' })).rejects.toThrow(
      /scope lease is required/,
    );
  });

  it('reserves a scope while asynchronous preparation is pending', async () => {
    let releasePreparation: (() => void) | undefined;
    const adapter: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi',
      async isAvailable() {
        return true;
      },
      prepareRun: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePreparation = resolve;
          }),
      ),
      run(opts: AgentRunOptions): AgentRun {
        return {
          runId: opts.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done' as const, terminationReason: 'normal' as const };
            },
          },
          async stop() {},
          async waitForExit() {
            return true;
          },
        };
      },
    };
    const executor = new RunExecutor(adapter, 1);
    const first = executor.submit({ scopeId: 'chat-a', prompt: 'one', cwd: '/tmp', accessMode: 'full' });
    await expect(
      executor.submit({ scopeId: 'chat-a', prompt: 'two', cwd: '/tmp', accessMode: 'full' }),
    ).rejects.toThrow(/already active/);
    releasePreparation?.();
    const prepared = await first;
    for await (const _ of prepared.events) {
      /* drain */
    }
  });
});
