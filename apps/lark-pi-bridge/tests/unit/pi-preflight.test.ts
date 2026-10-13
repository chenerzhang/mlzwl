import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPiCliCapabilities,
  assertSupportedRuntime,
  checkPiCompatibility,
  parsePiVersion,
  REQUIRED_PI_FLAGS,
} from '../../src/agent/pi/preflight.js';
import { checkPiRpcCompatibility } from '../../src/agent/pi/rpc-preflight.js';

describe('Pi preflight', () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('parses a Pi semantic version from version output', () => {
    expect(parsePiVersion('0.87.1\n')).toBe('0.87.1');
    expect(parsePiVersion('pi v0.85.1-beta.2')).toBe('0.85.1');
    expect(parsePiVersion('not a version')).toBeUndefined();
  });

  it('requires minimum versions without pinning a Pi minor line', () => {
    expect(() => assertSupportedRuntime('22.19.0', '0.85.1')).not.toThrow();
    expect(() => assertSupportedRuntime('22.20.0', '0.87.1')).not.toThrow();
    expect(() => assertSupportedRuntime('22.18.9', '0.87.1')).toThrow(/Node\.js >=22\.19\.0/);
    expect(() => assertSupportedRuntime('22.20.0', '0.85.0')).toThrow(/Pi >=0\.85\.1/);
    expect(() => assertSupportedRuntime('22.20.0', undefined)).toThrow(/semantic version/);
  });

  it('requires every CLI flag used by the bridge', () => {
    const help = REQUIRED_PI_FLAGS.map((flag) => `  ${flag} value`).join('\n');
    expect(() => assertPiCliCapabilities(help)).not.toThrow();
    expect(() => assertPiCliCapabilities(help.replace('--append-system-prompt', '--future-system-prompt'))).toThrow(
      /--append-system-prompt/,
    );
  });

  it('checks the selected binary with an isolated agent_settled protocol probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-preflight-test-'));
    cleanup.push(root);
    const record = join(root, 'record.jsonl');
    const binary = join(root, 'fake-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');
if (process.argv[2] === '--version') process.stdout.write('0.99.1\\n');
else if (process.argv[2] === '--help') process.stdout.write(${JSON.stringify(REQUIRED_PI_FLAGS.join('\n'))});
else {
  const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
  await fetch(models.providers['lark-pi-bridge-probe'].baseUrl + '/chat/completions', { method: 'POST', body: '{}' });
  process.stdout.write(JSON.stringify({ type: 'session', id: 'probe-session' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
}
`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    process.env.APP_SECRET = 'must-not-reach-probe';
    process.env.NODE_EXTRA_CA_CERTS = '/must/not/reach/probe.pem';
    try {
      await expect(checkPiCompatibility({ binary })).resolves.toEqual({ version: '0.99.1' });
      const records = (await readFile(record, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)) as Array<{
        argv: string[];
        env: NodeJS.ProcessEnv;
      }>;
      expect(records.map((value) => value.argv[0])).toEqual(['--version', '--help', '--mode']);
      expect(records[2]!.env.PI_CODING_AGENT_DIR).toContain('lark-pi-bridge-preflight-');
      expect(records[2]!.env.APP_SECRET).toBeUndefined();
      expect(records[2]!.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
      expect(records[2]!.argv).toContain('lark-pi-bridge-probe/loopback');
    } finally {
      delete process.env.APP_SECRET;
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  it('fails closed when the selected binary emits malformed protocol output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-preflight-malformed-'));
    cleanup.push(root);
    const binary = join(root, 'fake-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') process.stdout.write('0.87.1\\n');
else if (process.argv[2] === '--help') process.stdout.write(${JSON.stringify(REQUIRED_PI_FLAGS.join('\n'))});
else {
  const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
  await fetch(models.providers['lark-pi-bridge-probe'].baseUrl + '/chat/completions', { method: 'POST', body: '{}' });
  process.stdout.write('not-json\\n');
  process.stdout.write(JSON.stringify({ type: 'session', id: 'probe-session' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
}
`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    await expect(checkPiCompatibility({ binary })).rejects.toThrow(/malformed JSON line/);
  });

  it('fails closed when agent_settled is not the final protocol event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-preflight-terminal-'));
    cleanup.push(root);
    const binary = join(root, 'fake-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') process.stdout.write('0.87.1\\n');
else if (process.argv[2] === '--help') process.stdout.write(${JSON.stringify(REQUIRED_PI_FLAGS.join('\n'))});
else {
  const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
  await fetch(models.providers['lark-pi-bridge-probe'].baseUrl + '/chat/completions', { method: 'POST', body: '{}' });
  process.stdout.write(JSON.stringify({ type: 'session', id: 'probe-session' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'future_event' }) + '\\n');
}
`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    await expect(checkPiCompatibility({ binary })).rejects.toThrow(/did not end at.*agent_settled/);
  });

  it('checks the selected binary RPC handshake and agent_settled boundary with a loopback model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-preflight-test-'));
    cleanup.push(root);
    const record = join(root, 'record.jsonl');
    const binary = join(root, 'fake-rpc-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');
const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
let buffered = '';
let uiPromptId;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
send({ type: 'extension_ui_request', id: 'startup-status', method: 'setStatus', statusKey: 'probe', statusText: 'ready' });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
async function handle(command) {
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-probe-session', isStreaming: false } });
  if (command.type === 'get_commands') return send({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'lark-pi-bridge-ui-probe', description: 'probe', source: 'extension' }] } });
  if (command.type === 'prompt' && command.message === '/lark-pi-bridge-ui-probe') {
    uiPromptId = command.id;
    send({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'Bridge RPC UI probe' });
    return send({ type: 'extension_ui_request', id: 'blocking-confirm', method: 'confirm', title: 'Bridge RPC UI probe', message: 'Cancel safely.' });
  }
  if (command.type === 'extension_ui_response' && command.id === 'blocking-confirm') {
    send({ type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm', title: 'Bridge RPC UI probe' });
    return send({ id: uiPromptId, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
  }
  if (command.type === 'prompt') {
    await fetch(models.providers['lark-pi-bridge-rpc-probe'].baseUrl + '/chat/completions', { method: 'POST', body: '{}' });
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    send({ type: 'agent_start' });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'rpc-probe' } });
    send({ type: 'agent_end' });
    return send({ type: 'agent_settled' });
  }
}
`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    process.env.APP_SECRET = 'must-not-reach-rpc-probe';
    process.env.NODE_EXTRA_CA_CERTS = '/must/not/reach/rpc-probe.pem';
    try {
      await expect(checkPiRpcCompatibility({ binary })).resolves.toBeUndefined();
      const entry = JSON.parse((await readFile(record, 'utf8')).trim()) as {
        argv: string[];
        env: NodeJS.ProcessEnv;
      };
      expect(entry.argv).toEqual(expect.arrayContaining(['--mode', 'rpc', '--tools', 'read,grep,find,ls']));
      expect(entry.env.PI_CODING_AGENT_DIR).toContain('lark-pi-bridge-rpc-preflight-');
      expect(entry.env.APP_SECRET).toBeUndefined();
      expect(entry.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    } finally {
      delete process.env.APP_SECRET;
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
  });

  it('fails closed when the selected binary RPC stream omits agent_settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-rpc-preflight-no-settled-'));
    cleanup.push(root);
    const binary = join(root, 'fake-rpc-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
let buffered = '';
let uiPromptId;
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
send({ type: 'extension_ui_request', id: 'startup-status', method: 'setStatus', statusKey: 'probe', statusText: 'ready' });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
function handle(command) {
  if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'rpc-probe-session', isStreaming: false } });
  if (command.type === 'get_commands') return send({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'lark-pi-bridge-ui-probe', source: 'extension' }] } });
  if (command.type === 'prompt' && command.message === '/lark-pi-bridge-ui-probe') {
    uiPromptId = command.id;
    send({ type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title: 'probe' });
    return send({ type: 'extension_ui_request', id: 'confirm', method: 'confirm', title: 'probe', message: 'probe' });
  }
  if (command.type === 'extension_ui_response') {
    send({ type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm', title: 'probe' });
    return send({ id: uiPromptId, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
  }
  if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    send({ type: 'agent_end' });
  }
}
`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    await expect(checkPiRpcCompatibility({ binary, timeoutMs: 5_000, eventTimeoutMs: 100 })).rejects.toThrow(
      /agent_settled/,
    );
  });

  it('fails closed when the selected binary omits agent_settled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-preflight-no-settled-'));
    cleanup.push(root);
    const binary = join(root, 'fake-pi.mjs');
    await writeFile(
      binary,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv[2] === '--version') process.stdout.write('0.87.1\\n');
else if (process.argv[2] === '--help') process.stdout.write(${JSON.stringify(REQUIRED_PI_FLAGS.join('\n'))});
else {
  const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
  await fetch(models.providers['lark-pi-bridge-probe'].baseUrl + '/chat/completions', { method: 'POST', body: '{}' });
  process.stdout.write(JSON.stringify({ type: 'session', id: 'probe-session' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
}
`,
      { mode: 0o755 },
    );
    await chmod(binary, 0o755);
    await expect(checkPiCompatibility({ binary })).rejects.toThrow(/required agent_settled/);
  });
});
