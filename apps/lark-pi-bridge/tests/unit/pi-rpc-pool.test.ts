import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { PiRpcPool, StrictPiRpcConnection } from '../../src/agent/pi/rpc-connection.js';

class FakeChild {
  pid = 1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  once(name: string, listener: (...args: unknown[]) => void) {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
    return this;
  }
  kill(signal: NodeJS.Signals) {
    this.signalCode = signal;
    this.exitCode = 0;
    for (const listener of this.listeners.get('exit') ?? []) {
      listener(0, signal);
    }
    return true;
  }
}

describe('StrictPiRpcConnection extension UI', () => {
  it('routes all official extension UI requests outside the normal event stream', async () => {
    const child = new FakeChild();
    const regularEvents: unknown[] = [];
    const requests: string[] = [];
    const lifecycle: string[] = [];
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: {
        async onRequest(request) {
          requests.push(request.request.method);
          if (request.request.method === 'confirm') {
            return { confirmed: false };
          }
          if (
            request.request.method === 'select' ||
            request.request.method === 'input' ||
            request.request.method === 'editor'
          ) {
            return { cancelled: true };
          }
        },
        onPromptLifecycle(event) {
          lifecycle.push(event.type);
        },
      },
    });
    connection.onEvent((event) => regularEvents.push(event));
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(String(chunk)));
    const records = [
      { type: 'extension_ui_request', id: '1', method: 'select', title: 'Select', options: ['a', 'b'], timeout: 100 },
      { type: 'extension_ui_request', id: '2', method: 'confirm', title: 'Confirm', message: 'Sure?' },
      { type: 'extension_ui_request', id: '3', method: 'input', title: 'Input', placeholder: 'value' },
      { type: 'extension_ui_request', id: '4', method: 'editor', title: 'Editor', prefill: 'text' },
      { type: 'extension_ui_request', id: '5', method: 'notify', message: 'note', notifyType: 'warning' },
      { type: 'extension_ui_request', id: '6', method: 'setStatus', statusKey: 'plan', statusText: 'active' },
      {
        type: 'extension_ui_request',
        id: '7',
        method: 'setWidget',
        widgetKey: 'todo',
        widgetLines: ['one'],
        widgetPlacement: 'belowEditor',
      },
      { type: 'extension_ui_request', id: '8', method: 'setTitle', title: 'title' },
      { type: 'extension_ui_request', id: '9', method: 'set_editor_text', text: 'suggestion' },
      { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'Confirm' },
      { type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm', title: 'Confirm' },
      { type: 'agent_settled' },
    ];
    child.stdout.write(Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n'));
    await vi.waitFor(() => expect(written.join('')).toContain('extension_ui_response'));
    expect(requests).toEqual([
      'select',
      'confirm',
      'input',
      'editor',
      'notify',
      'setStatus',
      'setWidget',
      'setTitle',
      'set_editor_text',
    ]);
    expect(lifecycle).toEqual(['ui_prompt_start', 'ui_prompt_end']);
    expect(regularEvents).toEqual([{ type: 'agent_settled' }]);
    expect(
      written
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { type: 'extension_ui_response', id: '1', cancelled: true },
      { type: 'extension_ui_response', id: '2', confirmed: false },
      { type: 'extension_ui_response', id: '3', cancelled: true },
      { type: 'extension_ui_response', id: '4', cancelled: true },
    ]);
    await connection.dispose();
  });

  it('accepts an empty setWidget line array used to clear a widget', async () => {
    const child = new FakeChild();
    const requests: unknown[] = [];
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: {
        async onRequest(request) {
          requests.push(request);
        },
      },
    });
    child.stdout.write(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'clear-widget', method: 'setWidget', widgetKey: 'todo', widgetLines: [] })}\n`,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(connection.usable).toBe(true);
    await connection.dispose();
  });

  it('validates model and thinking state commands without leaking full model definitions', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never);
    let model = {
      provider: 'provider-a',
      id: 'model-a',
      name: 'Model A',
      reasoning: true,
      baseUrl: 'https://private.example',
    };
    let thinkingLevel = 'medium';
    child.stdin.on('data', (chunk) => {
      const command = JSON.parse(String(chunk));
      if (command.type === 'get_state') {
        child.stdout.write(
          `${JSON.stringify({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-a', isStreaming: false, model, thinkingLevel } })}\n`,
        );
      } else if (command.type === 'get_available_models') {
        child.stdout.write(
          `${JSON.stringify({ id: command.id, type: 'response', command: 'get_available_models', success: true, data: { models: [model, { provider: 'provider-a', id: 'model-b', reasoning: false }] } })}\n`,
        );
      } else if (command.type === 'set_model') {
        model = {
          provider: command.provider,
          id: command.modelId,
          name: 'Model B',
          reasoning: false,
          baseUrl: 'secret',
        };
        child.stdout.write(
          `${JSON.stringify({ id: command.id, type: 'response', command: 'set_model', success: true, data: model })}\n`,
        );
      } else if (command.type === 'get_available_thinking_levels') {
        child.stdout.write(
          `${JSON.stringify({ id: command.id, type: 'response', command: 'get_available_thinking_levels', success: true, data: { levels: ['off'] } })}\n`,
        );
      } else if (command.type === 'set_thinking_level') {
        thinkingLevel = command.level;
        child.stdout.write(`${JSON.stringify({ type: 'thinking_level_changed', level: thinkingLevel })}\n`);
        child.stdout.write(
          `${JSON.stringify({ id: command.id, type: 'response', command: 'set_thinking_level', success: true })}\n`,
        );
      }
    });
    await expect(connection.getState()).resolves.toEqual({
      sessionId: 'session-a',
      isStreaming: false,
      model: { provider: 'provider-a', id: 'model-a', name: 'Model A', reasoning: true },
      thinkingLevel: 'medium',
    });
    await expect(connection.getAvailableModels()).resolves.toEqual([
      { provider: 'provider-a', id: 'model-a', name: 'Model A', reasoning: true },
      { provider: 'provider-a', id: 'model-b', reasoning: false },
    ]);
    await expect(connection.setModel('provider-a', 'model-b')).resolves.toEqual({
      provider: 'provider-a',
      id: 'model-b',
      name: 'Model B',
      reasoning: false,
    });
    await expect(connection.getAvailableThinkingLevels()).resolves.toEqual(['off']);
    await expect(connection.setThinkingLevel('off')).resolves.toBeUndefined();
    expect(connection.usable).toBe(true);
    await connection.dispose();
  });

  it('returns only bounded get_commands fields and rejects unsafe command names', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never);
    child.stdin.on('data', (chunk) => {
      const command = JSON.parse(String(chunk));
      child.stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: 'response',
          command: 'get_commands',
          success: true,
          data: {
            commands: [
              {
                name: 'skill:check',
                description: 'Check work',
                source: 'skill',
                sourceInfo: { path: '/private/SKILL.md' },
              },
              {
                name: 'skill:check',
                description: 'Duplicate from prompt',
                source: 'prompt',
                sourceInfo: { path: '/private/template.md' },
              },
            ],
          },
        })}\n`,
      );
    });
    await expect(connection.getCommands()).resolves.toEqual([
      { name: 'skill:check', description: 'Check work', source: 'skill' },
    ]);
    await connection.dispose();

    const unsafeChild = new FakeChild();
    const unsafe = new StrictPiRpcConnection(unsafeChild as never);
    unsafeChild.stdin.on('data', (chunk) => {
      const command = JSON.parse(String(chunk));
      unsafeChild.stdout.write(
        `${JSON.stringify({
          id: command.id,
          type: 'response',
          command: 'get_commands',
          success: true,
          data: { commands: [{ name: 'bad name', source: 'extension' }] },
        })}\n`,
      );
    });
    await expect(unsafe.getCommands()).rejects.toThrow(/invalid command entry/);
  });

  it('cancels dialogs without an active UI handler and ignores validated fire-and-forget requests', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never);
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(String(chunk)));
    child.stdout.write(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'dialog', method: 'confirm', title: 'x', message: 'x' })}\n${JSON.stringify({ type: 'extension_ui_request', id: 'status', method: 'setStatus', statusKey: 'x', statusText: 'x' })}\n`,
    );
    await vi.waitFor(() => expect(written.join('')).toContain('dialog'));
    expect(
      written
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ type: 'extension_ui_response', id: 'dialog', cancelled: true }]);
    expect(connection.usable).toBe(true);
    await connection.dispose();
  });

  it.each([
    [{ type: 'extension_ui_request', id: '1', method: 'future' }, /Unknown Pi RPC extension UI method/],
    [
      { type: 'extension_ui_request', id: '1', method: 'confirm', title: 'x', message: 'x', secret: true },
      /unexpected field/,
    ],
    [{ type: 'extension_ui_request', id: '1', method: 'select', title: 'x', options: [] }, /options/],
    [{ type: 'extension_ui_request', id: '1', method: 'select', title: 'x', options: [''] }, /options/],
    [{ type: 'extension_ui_request', id: '1', method: 'select', title: 'x', options: ['same', 'same'] }, /duplicates/],
    [{ type: 'extension_ui_request', id: '1', method: 'input', title: 'x', timeout: 0 }, /timeout/],
    [{ type: 'extension_ui_request', id: '1', method: 'notify', message: 'x'.repeat(70_000) }, /exceeded/],
    [{ type: 'extension_ui_request', id: '1', method: 'notify', message: 'x', notifyType: 'debug' }, /notifyType/],
    [
      {
        type: 'extension_ui_request',
        id: '1',
        method: 'setWidget',
        widgetKey: 'x',
        widgetLines: ['x'],
        widgetPlacement: 'side',
      },
      /widgetPlacement/,
    ],
    [{ type: 'ui_prompt_start', reason: 'other', kind: 'confirm' }, /reason/],
  ])('fails closed for malformed extension UI record %#', async (record, expected) => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never);
    child.stdout.write(`${JSON.stringify(record)}\n`);
    await vi.waitFor(() => expect(connection.error?.message).toMatch(expected));
    expect(connection.usable).toBe(false);
  });

  it('fails closed when a select handler returns a value outside the declared options', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: {
        async onRequest() {
          return { value: 'forged' };
        },
      },
    });
    child.stdout.write(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'select-invalid-response', method: 'select', title: 'x', options: ['safe'] })}\n`,
    );
    await vi.waitFor(() => expect(connection.error?.message).toMatch(/declared option/));
  });

  it('fails closed for an invalid response shape from the UI handler', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: {
        async onRequest() {
          return { value: 'wrong shape' };
        },
      },
    });
    child.stdout.write(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'confirm-invalid-response', method: 'confirm', title: 'x', message: 'x' })}\n`,
    );
    await vi.waitFor(() => expect(connection.error?.message).toMatch(/boolean confirmation/));
  });

  it('fails closed when pending blocking extension UI exceeds bounded capacity', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: { onRequest: () => new Promise(() => {}) },
    });
    const records = Array.from({ length: 65 }, (_, index) => ({
      type: 'extension_ui_request',
      id: `pending-${index}`,
      method: 'confirm',
      title: 'x',
      message: 'x',
    }));
    child.stdout.write(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    await vi.waitFor(() => expect(connection.error?.message).toMatch(/capacity/));
  });

  it('fails closed for duplicate extension UI request ids', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never);
    connection.setExtensionUIHandler({ async onRequest() {} });
    const request = { type: 'extension_ui_request', id: 'duplicate', method: 'notify', message: 'x' };
    child.stdout.write(`${JSON.stringify(request)}\n${JSON.stringify(request)}\n`);
    await vi.waitFor(() => expect(connection.error?.message).toMatch(/duplicate/));
  });

  it('cancels a pending blocking request once and ignores its late handler result', async () => {
    const child = new FakeChild();
    let resolveInteraction!: (value: { confirmed: boolean }) => void;
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: {
        onRequest: () =>
          new Promise((resolve) => {
            resolveInteraction = resolve;
          }),
      },
    });
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(String(chunk)));
    child.stdout.write(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'pending', method: 'confirm', title: 'x', message: 'x' })}\n`,
    );
    await vi.waitFor(() => expect(resolveInteraction).toBeTypeOf('function'));
    connection.cancelExtensionUIRequests();
    resolveInteraction({ confirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      written
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ type: 'extension_ui_response', id: 'pending', cancelled: true }]);
    await connection.dispose();
  });

  it('clears pending UI state when disposal follows a child exit', async () => {
    const child = new FakeChild();
    let resolveInteraction!: (value: { confirmed: boolean }) => void;
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: {
        onRequest: () =>
          new Promise((resolve) => {
            resolveInteraction = resolve;
          }),
      },
    });
    child.stdout.write(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'exit-pending', method: 'confirm', title: 'x', message: 'x' })}\n`,
    );
    await vi.waitFor(() => expect(resolveInteraction).toBeTypeOf('function'));
    child.kill('SIGTERM');
    await connection.dispose();
    resolveInteraction({ confirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connection.usable).toBe(false);
  });

  it('sends a safe cancellation before disposing a connection with a pending dialog', async () => {
    const child = new FakeChild();
    const connection = new StrictPiRpcConnection(child as never, {
      extensionUIHandler: { onRequest: () => new Promise(() => {}) },
    });
    const written: string[] = [];
    child.stdin.on('data', (chunk) => written.push(String(chunk)));
    child.stdout.write(
      `${JSON.stringify({ type: 'extension_ui_request', id: 'dispose-pending', method: 'input', title: 'x' })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await connection.dispose();
    expect(
      written
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([{ type: 'extension_ui_response', id: 'dispose-pending', cancelled: true }]);
  });
});

describe('PiRpcPool', () => {
  it('reuses idle entries and evicts the least-recently-used idle entry', async () => {
    const pool = new PiRpcPool({ maxConnections: 2, idleTtlMs: 1_000_000 });
    let created = 0;
    const make = async () => {
      created += 1;
      return new StrictPiRpcConnection(new FakeChild() as never);
    };
    const one = await pool.acquire('one', make);
    pool.release(one.entry);
    const reused = await pool.acquire('one', make);
    expect(reused.reused).toBe(true);
    expect(created).toBe(1);
    pool.release(reused.entry);
    const two = await pool.acquire('two', make);
    pool.release(two.entry);
    const three = await pool.acquire('three', make);
    expect(pool.size()).toBe(2);
    expect(created).toBe(3);
    pool.release(three.entry);
    await pool.dispose();
  });

  it('serializes concurrent acquisition so bounded capacity cannot be oversubscribed', async () => {
    const pool = new PiRpcPool({ maxConnections: 1, idleTtlMs: 1_000_000 });
    let created = 0;
    const make = async () => {
      created += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new StrictPiRpcConnection(new FakeChild() as never);
    };
    const results = await Promise.allSettled([pool.acquire('one', make), pool.acquire('two', make)]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(created).toBe(1);
    expect(pool.size()).toBe(1);
    await pool.dispose();
  });

  it('fails closed when all bounded entries are busy', async () => {
    const pool = new PiRpcPool({ maxConnections: 1, idleTtlMs: 1_000_000 });
    const make = async () => new StrictPiRpcConnection(new FakeChild() as never);
    await pool.acquire('one', make);
    await expect(pool.acquire('two', make)).rejects.toThrow(/pool is full/);
    await pool.dispose();
  });

  it('removes a failed idle child without waiting for a later acquire or sweep', async () => {
    const pool = new PiRpcPool({ maxConnections: 1, idleTtlMs: 1_000_000 });
    const child = new FakeChild();
    const acquired = await pool.acquire('one', async () => new StrictPiRpcConnection(child as never));
    pool.release(acquired.entry);
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.size()).toBe(0);
    await pool.dispose();
  });

  it('sweeps an idle entry after TTL without touching a busy entry', async () => {
    let now = 0;
    const pool = new PiRpcPool({ maxConnections: 2, idleTtlMs: 10, now: () => now });
    const make = async () => new StrictPiRpcConnection(new FakeChild() as never, { now: () => now });
    const idle = await pool.acquire('idle', make);
    pool.release(idle.entry);
    await pool.acquire('busy', make);
    now = 11;
    await pool.sweep();
    expect(pool.size()).toBe(1);
    await pool.dispose();
  });

  it('disposes every idle entry while preserving busy entries for retention maintenance', async () => {
    const pool = new PiRpcPool({ maxConnections: 2, idleTtlMs: 1_000_000 });
    const make = async () => new StrictPiRpcConnection(new FakeChild() as never);
    const idle = await pool.acquire('idle', make);
    pool.release(idle.entry);
    const busy = await pool.acquire('busy', make);
    await pool.disposeIdle();
    expect(pool.size()).toBe(1);
    pool.release(busy.entry);
    await pool.disposeIdle();
    expect(pool.size()).toBe(0);
    await pool.dispose();
  });
});
