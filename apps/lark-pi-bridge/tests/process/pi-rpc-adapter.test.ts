import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiRpcAdapter } from '../../src/agent/pi/rpc-adapter.js';
import { PiRpcFallbackAdapter } from '../../src/agent/pi/fallback-adapter.js';
import { PiAdapter } from '../../src/agent/pi/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

describe('PiRpcAdapter process contract', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('handshakes, streams through agent_settled, reuses the child, and keeps prompt/image off argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-'));
    cleanup.push(root);
    const record = join(root, 'records.jsonl');
    const binary = await fakeRpcPi(root, record);
    const image = join(root, 'image.png');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(image, imageBytes, { mode: 0o600 });
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun();
    const common = {
      scopeId: 'chat-a',
      policyFingerprint: 'fingerprint-a',
      cwd: root,
      accessMode: 'read-only' as const,
    };
    const first = await collect(
      adapter.run({ ...common, runId: 'rpc-1', prompt: 'private prompt one', attachments: [image] }).events,
    );
    expect(first).toEqual([
      { type: 'system', sessionId: 'rpc-session', cwd: root, model: undefined },
      { type: 'text', delta: 'reply-1' },
      { type: 'done', sessionId: 'rpc-session', terminationReason: 'normal' },
    ]);
    const second = await collect(
      adapter.run({ ...common, runId: 'rpc-2', sessionId: 'rpc-session', prompt: 'private prompt two' }).events,
    );
    expect(second.at(-1)).toEqual({ type: 'done', sessionId: 'rpc-session', terminationReason: 'normal' });
    await adapter.dispose();

    const records = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const startup = records.find((item) => item.kind === 'startup')!;
    expect(startup.argv).toEqual(
      expect.arrayContaining(['--mode', 'rpc', '--tools', 'read,grep,find,ls', '--session-dir']),
    );
    const startupArgv = startup.argv as string[];
    expect(startupArgv[startupArgv.indexOf('--session-dir') + 1]).toBe(join(root, 'pi-agent', 'sessions'));
    expect(startupArgv[startupArgv.indexOf('--append-system-prompt') + 1]).toBe(
      join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    );
    expect(JSON.stringify(startup.argv)).not.toContain('private prompt');
    expect(startup.env).not.toHaveProperty('APP_SECRET');
    expect(startup.createdMode).toBe(process.platform === 'win32' ? expect.any(Number) : 0o600);
    const prompts = records.filter((item) => item.type === 'prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.message).toContain('private prompt one');
    expect(prompts[0]?.images).toEqual([{ type: 'image', data: imageBytes.toString('base64'), mimeType: 'image/png' }]);
    expect(JSON.stringify(prompts[0])).not.toContain(image);
    const pids = new Set(records.filter((item) => item.pid).map((item) => item.pid));
    expect(pids.size).toBe(1);
    expect((await stat(join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'))).mode & 0o777).toBe(0o600);
  });

  it('sends explicit Pi commands raw and completes handled commands without a model terminal event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-command-'));
    cleanup.push(root);
    const record = join(root, 'records.jsonl');
    const binary = await fakeCommandPi(root, record);
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    const interactions: unknown[] = [];
    const cancelledRuns: string[] = [];
    adapter.setInteractionPort({
      async handle(_context, request) {
        interactions.push(request);
        return request.method === 'confirm' ? { confirmed: true } : undefined;
      },
      cancelRun(runId) {
        cancelledRuns.push(runId);
      },
      dispose() {},
    });
    await adapter.prepareRun();
    const common = {
      scopeId: 'chat-command',
      policyFingerprint: 'fingerprint-command',
      cwd: root,
      accessMode: 'read-only' as const,
    };
    await expect(adapter.listCommands({ ...common, runId: 'list', prompt: '/pi commands' })).resolves.toEqual([
      { name: 'plan', source: 'extension', description: 'Plan work' },
      { name: 'template', source: 'prompt' },
      { name: 'skill:check', source: 'skill' },
    ]);
    expect(interactions).toEqual([]);
    expect(cancelledRuns).toContain('list');
    const events = await collect(
      adapter.run({
        ...common,
        runId: 'command',
        prompt: '/plan keep  two spaces',
        promptMode: 'pi-command',
      }).events,
    );
    expect(events).toEqual([
      { type: 'system', sessionId: 'rpc-command-session', cwd: root, model: undefined },
      { type: 'done', sessionId: 'rpc-command-session', terminationReason: 'normal' },
    ]);
    await adapter.dispose();
    const records = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const prompt = records.find((entry) => entry.type === 'prompt');
    expect(prompt.message).toBe('/plan keep  two spaces');
    expect(prompt.message).not.toContain('<user_input>');
    expect(records.some((entry) => entry.type === 'agent_settled' && entry.phase === 'delayed-command')).toBe(true);
    const commandStartups = records.filter((entry) => entry.kind === 'startup');
    expect(new Set(commandStartups.map((entry) => entry.pid)).size).toBe(2);
    const discoveryCancellation = records.find(
      (entry) => entry.type === 'extension_ui_response' && entry.id === 'discovery-confirm',
    );
    expect(discoveryCancellation).toEqual(expect.objectContaining({ cancelled: true }));
  });

  it('retires an idle handled-command child before yielding to a cancellable consumer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-command-idle-'));
    cleanup.push(root);
    const record = join(root, 'records.jsonl');
    const binary = await fakeIdleHandledCommandPi(root, record);
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun();
    const common = {
      scopeId: 'chat-idle-command',
      policyFingerprint: 'fingerprint-idle-command',
      cwd: root,
      accessMode: 'read-only' as const,
      sessionId: 'rpc-idle-command-session',
      prompt: '/quiet',
      promptMode: 'pi-command' as const,
    };
    const first = adapter.run({ ...common, runId: 'idle-command-1' }).events[Symbol.asyncIterator]();
    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { type: 'system', sessionId: 'rpc-idle-command-session', cwd: root, model: undefined },
    });
    await first.return?.();
    await collect(adapter.run({ ...common, runId: 'idle-command-2' }).events);
    await adapter.dispose();
    const records = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const startupPids = records.filter((entry) => entry.kind === 'startup').map((entry) => entry.pid);
    expect(new Set(startupPids).size).toBe(2);
  });

  it('does not create or mutate a missing external Pi configuration directory during preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-readonly-config-'));
    cleanup.push(root);
    const piConfigDir = join(root, 'external-user-pi-does-not-exist');
    const adapter = new PiRpcAdapter({
      piConfigDir,
      piSessionDir: join(root, 'profile', 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'profile', 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun();
    await expect(stat(piConfigDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'profile', 'pi-agent', 'lark-pi-bridge-system-prompt.md'), 'utf8')).toContain(
      'lark-pi-bridge 运行约定',
    );
    await adapter.dispose();
  });

  it('replaces a pooled child for /new and for a changed catalog session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-session-identity-'));
    cleanup.push(root);
    const record = join(root, 'records.jsonl');
    const binary = await fakeSessionPi(root, record);
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun();
    const common = {
      scopeId: 'chat-session',
      policyFingerprint: 'fingerprint-session',
      cwd: root,
      accessMode: 'read-only' as const,
    };
    const first = await collect(adapter.run({ ...common, runId: 'one', prompt: 'one' }).events);
    const firstSession = first.find((event) => event.type === 'system')?.sessionId;
    expect(firstSession).toBeTruthy();
    const fresh = await collect(adapter.run({ ...common, runId: 'new', prompt: 'new' }).events);
    const freshSession = fresh.find((event) => event.type === 'system')?.sessionId;
    expect(freshSession).not.toBe(firstSession);
    const resumedElsewhere = await collect(
      adapter.run({ ...common, runId: 'resume-other', sessionId: 'external-session', prompt: 'resume' }).events,
    );
    expect(resumedElsewhere.find((event) => event.type === 'system')?.sessionId).toBe('external-session');
    await adapter.dispose();
    const records = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(new Set(records.filter((item) => item.kind === 'startup').map((item) => item.pid)).size).toBe(3);
  });

  it('accepts a tool-heavy agent_end larger than one MiB and completes at agent_settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-large-agent-end-'));
    cleanup.push(root);
    const binary = await fakeLargeAgentEndPi(root);
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun();
    const events = await collect(
      adapter.run({
        runId: 'rpc-large-agent-end',
        scopeId: 'chat-large-agent-end',
        policyFingerprint: 'fingerprint-large-agent-end',
        prompt: 'test',
        cwd: root,
        accessMode: 'read-only',
      }).events,
    );
    expect(events).toEqual([
      { type: 'system', sessionId: 'rpc-large-session', cwd: root, model: undefined },
      { type: 'text', delta: 'final answer' },
      { type: 'done', sessionId: 'rpc-large-session', terminationReason: 'normal' },
    ]);
    await adapter.dispose();
  });

  it('resets the cumulative stdout budget between pooled RPC turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-output-reset-'));
    cleanup.push(root);
    const binary = await fakeRpcPi(root, join(root, 'records.jsonl'));
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
      connection: { jsonlLimits: { maxLineBytes: 2_048, maxOutputBytes: 2_048 } },
    });
    await adapter.prepareRun();
    const common = {
      scopeId: 'chat-output-reset',
      policyFingerprint: 'fingerprint-output-reset',
      cwd: root,
      accessMode: 'read-only' as const,
    };
    let sessionId: string | undefined;
    for (let index = 0; index < 20; index += 1) {
      const events = await collect(
        adapter.run({
          ...common,
          runId: `rpc-output-reset-${index}`,
          prompt: `turn-${index}`,
          ...(sessionId ? { sessionId } : {}),
        }).events,
      );
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
      sessionId = events.find((event) => event.type === 'system')?.sessionId;
    }
    await adapter.dispose();
    const records = (await readFile(join(root, 'records.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(new Set(records.filter((item) => item.kind === 'startup').map((item) => item.pid)).size).toBe(1);
  });

  it('treats agent_end as non-terminal and safely cancels an unattended extension UI dialog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-ui-'));
    cleanup.push(root);
    const binary = await fakeRpcPi(root, join(root, 'records.jsonl'), { extensionUi: true });
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun();
    const events = await collect(
      adapter.run({
        runId: 'rpc-ui',
        scopeId: 'chat-ui',
        policyFingerprint: 'fingerprint-ui',
        prompt: 'test',
        cwd: root,
        accessMode: 'read-only',
      }).events,
    );
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      terminationReason: 'normal',
    });
    await adapter.dispose();
  });

  it('fails closed when an event follows agent_settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-post-terminal-'));
    cleanup.push(root);
    const binary = await fakePostTerminalPi(root);
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun();
    const events = await collect(
      adapter.run({
        runId: 'rpc-post-terminal',
        scopeId: 'chat-post-terminal',
        policyFingerprint: 'fingerprint-post-terminal',
        prompt: 'test',
        cwd: root,
        accessMode: 'read-only',
      }).events,
    );
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
      message: expect.stringMatching(/after the terminal boundary/),
    });
    await adapter.dispose();
  });

  it('fails closed and reaps the child when the bounded event inbox overflows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-overflow-'));
    cleanup.push(root);
    const binary = await fakeOverflowPi(root);
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
      maxEventQueueItems: 2,
      maxEventQueueBytes: 1_024,
    });
    await adapter.prepareRun();
    const events = await collect(
      adapter.run({
        runId: 'rpc-overflow',
        scopeId: 'chat-overflow',
        policyFingerprint: 'fingerprint-overflow',
        prompt: 'test',
        cwd: root,
        accessMode: 'read-only',
      }).events,
    );
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
      message: expect.stringMatching(/event queue exceeded/),
    });
    await adapter.dispose();
  });

  it('supports steer/follow-up and abort without duplicating a normal prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-control-'));
    cleanup.push(root);
    const record = join(root, 'records.jsonl');
    const binary = await fakeControlPi(root, record);
    const adapter = new PiRpcAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
      stopGraceMs: 500,
    });
    await adapter.prepareRun();
    const run = adapter.run({
      runId: 'rpc-control',
      scopeId: 'chat-control',
      policyFingerprint: 'fingerprint-control',
      prompt: 'initial',
      cwd: root,
      accessMode: 'read-only',
    });
    const iterator = run.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: 'system', sessionId: 'rpc-session' } });
    expect(await adapter.control('rpc-control', 'steer', 'change')).toBe('queued');
    expect(await adapter.control('rpc-control', 'follow-up', 'later')).toBe('queued');
    await run.stop();
    const remaining: AgentEvent[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      remaining.push(next.value);
    }
    expect(remaining.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    const records = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.filter((item) => item.type === 'prompt')).toHaveLength(1);
    expect(records.filter((item) => item.type === 'steer')).toHaveLength(1);
    expect(records.filter((item) => item.type === 'follow_up')).toHaveLength(1);
    expect(records.filter((item) => item.type === 'abort')).toHaveLength(1);
    await adapter.dispose();
  });

  it('falls back only for explicit prompt rejection, not after acceptance uncertainty', async () => {
    const rejectedRoot = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-fallback-'));
    cleanup.push(rejectedRoot);
    const rejectedRecord = join(rejectedRoot, 'records.jsonl');
    const rejectedBinary = await fakeDualModePi(rejectedRoot, rejectedRecord, 'reject');
    const rejected = dualAdapter(rejectedRoot, rejectedBinary, 5_000);
    await rejected.prepareRun?.();
    const rejectedEvents = await collect(rejected.run(runOptions(rejectedRoot, 'reject')).events);
    expect(rejectedEvents.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    const rejectedRecords = await readFile(rejectedRecord, 'utf8');
    expect(rejectedEvents.some((event) => event.type === 'text' && event.delta === 'spawn fallback')).toBe(true);
    expect(rejectedRecords).toContain('"mode":"json"');
    await rejected.dispose?.();

    const uncertainRoot = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-no-replay-'));
    cleanup.push(uncertainRoot);
    const uncertainRecord = join(uncertainRoot, 'records.jsonl');
    const uncertainBinary = await fakeDualModePi(uncertainRoot, uncertainRecord, 'hang');
    const uncertain = dualAdapter(uncertainRoot, uncertainBinary, 5_000, 100);
    await uncertain.prepareRun?.();
    const uncertainEvents = await collect(uncertain.run(runOptions(uncertainRoot, 'hang')).events);
    expect(uncertainEvents.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    const uncertainRecords = await readFile(uncertainRecord, 'utf8');
    expect(uncertainEvents.some((event) => event.type === 'text' && event.delta === 'spawn fallback')).toBe(false);
    expect(uncertainRecords).not.toContain('"mode":"json"');
    await uncertain.dispose?.();
  });
});

function dualAdapter(root: string, binary: string, timeout: number, promptTimeoutMs?: number) {
  const options = {
    binary,
    piConfigDir: join(root, 'pi-agent'),
    piSessionDir: join(root, 'pi-agent', 'sessions'),
    bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
  };
  return new PiRpcFallbackAdapter(
    new PiRpcAdapter({ ...options, connection: { commandTimeoutMs: timeout }, promptTimeoutMs }),
    new PiAdapter(options),
  );
}

function runOptions(root: string, suffix: string) {
  return {
    runId: `run-${suffix}`,
    scopeId: `scope-${suffix}`,
    policyFingerprint: `fingerprint-${suffix}`,
    prompt: `prompt-${suffix}`,
    cwd: root,
    accessMode: 'read-only' as const,
  };
}

async function fakeCommandPi(root: string, record: string): Promise<string> {
  const path = join(root, 'fake-command-pi.mjs');
  const code = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const record = ${JSON.stringify(record)};
appendFileSync(record, JSON.stringify({ kind: 'startup', pid: process.pid }) + '\\n');
let buffered = '';
let streaming = false;
let commandDiscoveryCount = 0;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  appendFileSync(record, JSON.stringify(command) + '\\n');
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-command-session', isStreaming: streaming } });
  if (command.type === 'get_commands') {
    commandDiscoveryCount += 1;
    if (commandDiscoveryCount === 1) {
      send({ type: 'extension_ui_request', id: 'discovery-status', method: 'setStatus', statusKey: 'discovery', statusText: 'hidden startup status' });
      send({ type: 'extension_ui_request', id: 'discovery-confirm', method: 'confirm', title: 'hidden discovery dialog', message: 'must cancel' });
    }
    return send({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [
      { name: 'plan', description: 'Plan work', source: 'extension', sourceInfo: { path: '/private/plan.ts' } },
      { name: 'template', source: 'prompt', sourceInfo: { path: '/private/template.md' } },
      { name: 'skill:check', source: 'skill', sourceInfo: { path: '/private/SKILL.md' } }
    ] } });
  }
  if (command.type === 'extension_ui_response') return;
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
    return setTimeout(() => {
      streaming = true;
      send({ type: 'agent_start' });
      send({ type: 'agent_end' });
      send({ type: 'agent_settled' });
      appendFileSync(record, JSON.stringify({ type: 'agent_settled', phase: 'delayed-command' }) + '\\n');
      streaming = false;
    }, 50);
  }
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakeIdleHandledCommandPi(root: string, record: string): Promise<string> {
  const path = join(root, 'fake-idle-command-pi.mjs');
  const code = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const record = ${JSON.stringify(record)};
appendFileSync(record, JSON.stringify({ kind: 'startup', pid: process.pid }) + '\\n');
let buffered = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-idle-command-session', isStreaming: false } });
  if (command.type === 'get_commands') return send({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'quiet', source: 'extension' }] } });
  if (command.type === 'prompt') return send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakeSessionPi(root: string, record: string): Promise<string> {
  const path = join(root, 'fake-session-pi.mjs');
  const code = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const record = ${JSON.stringify(record)};
const sessionIndex = process.argv.indexOf('--session');
const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : 'fresh-' + process.pid;
appendFileSync(record, JSON.stringify({ kind: 'startup', pid: process.pid, sessionId }) + '\\n');
let buffered = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId, isStreaming: false } });
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    return send({ type: 'agent_settled' });
  }
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakeRpcPi(root: string, record: string, options: { extensionUi?: boolean } = {}): Promise<string> {
  const path = join(root, 'fake-rpc-pi.mjs');
  const code = `#!/usr/bin/env node
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const record = ${JSON.stringify(record)};
const created = join(process.env.PI_CODING_AGENT_DIR, 'rpc-created-session.jsonl');
writeFileSync(created, 'session');
appendFileSync(record, JSON.stringify({ kind: 'startup', pid: process.pid, argv: process.argv.slice(2), env: process.env, createdMode: statSync(created).mode & 0o777 }) + '\\n');
let count = 0;
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
function finish() {
  send({ type: 'agent_start' });
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'reply-' + count } });
  send({ type: 'agent_end' });
  setTimeout(() => send({ type: 'agent_settled' }), 5);
}
function handle(command) {
  appendFileSync(record, JSON.stringify({ ...command, pid: process.pid }) + '\\n');
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-session', isStreaming: false } });
  if (command.type === 'prompt') {
    count += 1;
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    if (${JSON.stringify(Boolean(options.extensionUi))}) return send({ type: 'extension_ui_request', id: 'ui', method: 'confirm', title: 'x', message: 'x' });
    return finish();
  }
  if (command.type === 'extension_ui_response') return finish();
  if (command.type === 'abort') return send({ id: command.id, type: 'response', command: 'abort', success: true });
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakeLargeAgentEndPi(root: string): Promise<string> {
  const path = join(root, 'fake-large-agent-end-pi.mjs');
  const code = `#!/usr/bin/env node
let buffered = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-large-session', isStreaming: false } });
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'final answer' } });
    const messages = Array.from({ length: 96 }, (_, index) => ({ role: 'toolResult', toolCallId: 'call-' + index, content: [{ type: 'text', text: 'x'.repeat(16 * 1024) }] }));
    send({ type: 'agent_end', messages, willRetry: false });
    return send({ type: 'agent_settled' });
  }
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakePostTerminalPi(root: string): Promise<string> {
  const path = join(root, 'fake-post-terminal-pi.mjs');
  const code = `#!/usr/bin/env node
let buffered = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-session', isStreaming: false } });
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    send({ type: 'agent_settled' });
    send({ type: 'future_event' });
  }
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakeOverflowPi(root: string): Promise<string> {
  const path = join(root, 'fake-overflow-pi.mjs');
  const code = `#!/usr/bin/env node
let buffered = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-session', isStreaming: false } });
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    for (let index = 0; index < 8; index += 1) send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: String(index) } });
  }
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakeControlPi(root: string, record: string): Promise<string> {
  const path = join(root, 'fake-control-pi.mjs');
  const code = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const record = ${JSON.stringify(record)};
let buffered = '';
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  appendFileSync(record, JSON.stringify(command) + '\\n');
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-session', isStreaming: false } });
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    return send({ type: 'agent_start' });
  }
  if (command.type === 'steer') return send({ id: command.id, type: 'response', command: 'steer', success: true, data: { disposition: 'queued' } });
  if (command.type === 'follow_up') return send({ id: command.id, type: 'response', command: 'follow_up', success: true, data: { disposition: 'queued' } });
  if (command.type === 'abort') {
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted', errorMessage: 'aborted by bridge' } });
    send({ type: 'agent_settled' });
    return send({ id: command.id, type: 'response', command: 'abort', success: true });
  }
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function fakeDualModePi(root: string, record: string, behavior: 'reject' | 'hang'): Promise<string> {
  const path = join(root, 'fake-dual-pi.mjs');
  const code = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const mode = process.argv[process.argv.indexOf('--mode') + 1];
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ mode, pid: process.pid }) + '\\n');
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
if (mode === 'json') {
  readFileSync(0, 'utf8');
  send({ type: 'session', id: 'spawn-session' });
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'spawn fallback' } });
  send({ type: 'agent_settled' });
} else {
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
  function handle(command) {
    if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-session', isStreaming: false } });
    if (command.type === 'prompt' && ${JSON.stringify(behavior)} === 'reject') return send({ id: command.id, type: 'response', command: 'prompt', success: false, error: 'rejected before acceptance' });
  }
}
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  try {
    for await (const event of events) {
      result.push(event);
    }
  } catch (error) {
    result.push({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      terminationReason: 'failed',
    });
  }
  return result;
}
