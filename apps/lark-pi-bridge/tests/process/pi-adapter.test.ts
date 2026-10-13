import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PiAdapter } from '../../src/agent/pi/adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

describe('PiAdapter process contract', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('uses stdin, a profile-local Pi dir, unattended mode and a restricted environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-adapter-'));
    cleanup.push(root);
    const record = join(root, 'record.json');
    const binary = await fakePi(root, record, [
      { type: 'session', id: 'pi-session', cwd: root },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } },
      { type: 'agent_end', willRetry: false },
      { type: 'agent_settled' },
    ]);
    const previous = process.env.APP_SECRET;
    process.env.APP_SECRET = 'must-not-reach-pi';
    try {
      await mkdir(join(root, 'user-pi-agent'), { recursive: true });
      const adapter = new PiAdapter({
        binary,
        piConfigDir: join(root, 'user-pi-agent'),
        piSessionDir: join(root, 'profile', 'pi-agent', 'sessions'),
        bridgeSystemPromptFile: join(root, 'profile', 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
      });
      await adapter.prepareRun?.({
        runId: 'prepare',
        prompt: '',
        cwd: root,
        accessMode: 'full',
      });
      const run = adapter.run({
        runId: 'run-a',
        prompt: 'private prompt',
        cwd: root,
        accessMode: 'read-only',
        sessionId: 'previous-session',
        model: 'test/model',
        attachments: [join(root, 'profile', 'media', 'image.png')],
      });
      expect(await collect(run.events)).toEqual([
        { type: 'system', sessionId: 'pi-session', cwd: root },
        { type: 'text', delta: 'hello' },
        { type: 'done', sessionId: 'pi-session', terminationReason: 'normal' },
      ]);
      const seen = JSON.parse(await readFile(record, 'utf8')) as {
        argv: string[];
        stdin: string;
        env: NodeJS.ProcessEnv;
        createdMode: number;
      };
      expect(seen.argv).toEqual(
        expect.arrayContaining([
          '--mode',
          'json',
          '--session',
          'previous-session',
          '--model',
          'test/model',
          '--tools',
          'read,grep,find,ls',
        ]),
      );
      expect(seen.argv).toEqual(expect.arrayContaining(['--append-system-prompt', '--session-dir', '--no-approve']));
      expect(seen.argv).not.toContain('private prompt');
      expect(seen.stdin).toContain('private prompt');
      expect(seen.stdin).not.toContain('lark-pi-bridge 运行约定');
      expect(seen.stdin).toContain('<bridge_attachments>');
      expect(seen.stdin).toContain(join(root, 'profile', 'media', 'image.png'));
      expect(seen.env.PI_CODING_AGENT_DIR).toBe(join(root, 'user-pi-agent'));
      expect(await stat(join(root, 'user-pi-agent'))).toBeDefined();
      const sessionFlagIndex = seen.argv.indexOf('--session-dir');
      expect(seen.argv[sessionFlagIndex + 1]).toBe(join(root, 'profile', 'pi-agent', 'sessions'));
      const promptFlagIndex = seen.argv.indexOf('--append-system-prompt');
      expect(promptFlagIndex).toBeGreaterThanOrEqual(0);
      const promptFile = seen.argv[promptFlagIndex + 1];
      expect(promptFile).toBe(join(root, 'profile', 'pi-agent', 'lark-pi-bridge-system-prompt.md'));
      expect(promptFile).toBeDefined();
      expect(await readFile(promptFile!, 'utf8')).toContain('lark-pi-bridge 运行约定');
      expect((await stat(promptFile!)).mode & 0o777).toBe(0o600);
      expect(seen.env.APP_SECRET).toBeUndefined();
      if (process.platform !== 'win32') {
        expect(seen.createdMode).toBe(0o600);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.APP_SECRET;
      } else {
        process.env.APP_SECRET = previous;
      }
    }
  });

  it('does not create or mutate a missing external Pi configuration directory during preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-adapter-readonly-config-'));
    cleanup.push(root);
    const piConfigDir = join(root, 'external-user-pi-does-not-exist');
    const adapter = new PiAdapter({
      piConfigDir,
      piSessionDir: join(root, 'profile', 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'profile', 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun?.({ runId: 'prepare', prompt: '', cwd: root, accessMode: 'full' });
    await expect(stat(piConfigDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'profile', 'pi-agent', 'lark-pi-bridge-system-prompt.md'), 'utf8')).toContain(
      'lark-pi-bridge 运行约定',
    );
  });

  it.each([
    [
      'malformed JSON',
      `process.stdout.write('{bad}\\n');`,
      /Pi JSON protocol error: Pi JSONL line 1 is not valid JSON/,
    ],
    [
      'an event after agent_settled',
      `process.stdout.write(JSON.stringify({ type: 'session', id: 'late-session' }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');`,
      /Pi JSON protocol error: Pi emitted an event after the terminal boundary/,
    ],
  ])('fails closed on %s', async (_name, stdoutCode, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-protocol-'));
    cleanup.push(root);
    const binary = join(root, 'fake-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nreadFileSync(0, 'utf8');\n${stdoutCode}\n`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    const adapter = new PiAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun?.({ runId: 'prepare', prompt: '', cwd: root, accessMode: 'read-only' });
    const events = await collect(
      adapter.run({ runId: 'protocol-error', prompt: 'test', cwd: root, accessMode: 'read-only' }).events,
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', terminationReason: 'failed' });
    expect(events.at(-1)).toHaveProperty('message', expect.stringMatching(expected));
  });

  it('preserves an unrecovered provider failure when late protocol drift follows agent_settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-terminal-failure-'));
    cleanup.push(root);
    const binary = join(root, 'fake-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
for (const event of [
  { type: 'session', id: 'failure-session' },
  { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'original provider failure' } },
  { type: 'agent_end', willRetry: false },
  { type: 'agent_settled' },
  { type: 'future_event' },
]) process.stdout.write(JSON.stringify(event) + '\\n');
process.exitCode = 7;
`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    const adapter = new PiAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
    });
    await adapter.prepareRun?.({ runId: 'prepare', prompt: '', cwd: root, accessMode: 'read-only' });
    const events = await collect(
      adapter.run({ runId: 'terminal-failure', prompt: 'test', cwd: root, accessMode: 'read-only' }).events,
    );
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'original provider failure',
      terminationReason: 'failed',
    });
  });

  it('fails closed on bounded JSONL output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-bounds-'));
    cleanup.push(root);
    const binary = join(root, 'fake-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node\nimport { readFileSync } from 'node:fs';\nreadFileSync(0, 'utf8');\nprocess.stdout.write('123456789');\n`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    const adapter = new PiAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
      jsonlLimits: { maxLineBytes: 8, maxOutputBytes: 64 },
    });
    await adapter.prepareRun?.({ runId: 'prepare', prompt: '', cwd: root, accessMode: 'read-only' });
    const events = await collect(
      adapter.run({ runId: 'bounded-output', prompt: 'test', cwd: root, accessMode: 'read-only' }).events,
    );
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      terminationReason: 'failed',
      message: expect.stringMatching(/line exceeded 8 bytes/),
    });
  });

  it('emits an interrupted terminal event when stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-stop-'));
    cleanup.push(root);
    const binary = await fakePi(
      root,
      join(root, 'record.json'),
      [{ type: 'session', id: 'session-stop', cwd: root }],
      5_000,
    );
    const adapter = new PiAdapter({
      binary,
      piConfigDir: join(root, 'pi-agent'),
      piSessionDir: join(root, 'pi-agent', 'sessions'),
      bridgeSystemPromptFile: join(root, 'pi-agent', 'lark-pi-bridge-system-prompt.md'),
      stopGraceMs: 20,
    });
    await adapter.prepareRun?.({ runId: 'prepare', prompt: '', cwd: root, accessMode: 'full' });
    const run = adapter.run({ runId: 'run-stop', prompt: 'stop', cwd: root, accessMode: 'full' });
    const iterator = run.events[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'system', sessionId: 'session-stop', cwd: root },
    });
    await run.stop();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: 'done', sessionId: 'session-stop', terminationReason: 'interrupted' },
    });
  });
});

async function fakePi(root: string, record: string, lines: unknown[], delayMs = 0): Promise<string> {
  const path = join(root, 'fake-pi.mjs');
  const code = `#!/usr/bin/env node
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stdin = readFileSync(0, 'utf8');
const created = join(process.env.PI_CODING_AGENT_DIR, 'child-created-session.jsonl');
writeFileSync(created, 'session');
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin, env: process.env, createdMode: statSync(created).mode & 0o777 }));
for (const line of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(line) + '\\n');
setTimeout(() => process.exit(0), ${delayMs});
`;
  await writeFile(path, code, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}
