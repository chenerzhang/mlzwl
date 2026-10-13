import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'lark-pi-bridge-smoke-'));
const sourceSecretFile = join(root, 'source-app-secret');
try {
  await writeFile(sourceSecretFile, '${SMOKE_SECRET_NOT_REAL}', { mode: 0o600 });
  const initOutput = await run(
    process.execPath,
    [
      'dist/cli.js',
      '--home',
      root,
      'init',
      '--profile',
      'smoke',
      '--pi-config-scope',
      'profile',
      '--app-id',
      'cli_smoke',
      '--app-secret-file',
      sourceSecretFile,
      '--allow-user',
      'ou_smoke',
    ],
    process.env,
  );
  if (!initOutput.includes('"ok":true') || initOutput.includes('${SMOKE_SECRET_NOT_REAL}')) {
    throw new Error(`unexpected init output: ${initOutput}`);
  }
  const pi = await fakePi(root);
  const output = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'validate', '--profile', 'smoke', '--pi-bin', pi],
    {
      ...process.env,
      APP_SECRET: 'must-not-reach-fake-pi',
      PI_CODING_AGENT_DIR: join(root, 'must-not-be-used-by-bridge'),
      PI_OFFLINE: '1',
    },
  );
  if (!output.includes('"ok":true') || !output.includes('"agent":"pi"')) {
    throw new Error(`unexpected validate output: ${output}`);
  }
  const stoppedRefresh = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'config', 'refresh', '--profile', 'smoke', '--pi-bin', pi],
    process.env,
  );
  if (!stoppedRefresh.includes('"running":false') || !stoppedRefresh.includes('下次启动')) {
    throw new Error(`unexpected stopped runtime refresh output: ${stoppedRefresh}`);
  }
  const profileSecretFile = join(root, 'profiles', 'smoke', 'app-secret');
  await chmod(profileSecretFile, 0o644);
  const rejected = await runResult(
    process.execPath,
    ['dist/cli.js', '--home', root, 'validate', '--profile', 'smoke', '--pi-bin', pi],
    process.env,
  );
  if (rejected.code === 0 || !rejected.output.includes('validation failed: app_secret')) {
    throw new Error(`validate did not fail closed on an over-broad App Secret file: ${rejected.output}`);
  }
  await chmod(profileSecretFile, 0o600);
  const project = join(root, 'project');
  await mkdir(project, { mode: 0o700 });
  const listOutput = await run(process.execPath, ['dist/cli.js', '--home', root, 'profile', 'list'], process.env);
  if (!listOutput.includes('"name":"smoke"') || listOutput.includes('${SMOKE_SECRET_NOT_REAL}')) {
    throw new Error(`unexpected profile list output: ${listOutput}`);
  }
  const scopeStatus = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'pi-config-scope', 'get', '--profile', 'smoke'],
    process.env,
  );
  if (!scopeStatus.includes('"piConfigScope":"profile"')) {
    throw new Error(`unexpected Pi config scope: ${scopeStatus}`);
  }
  const invalidScope = await runResult(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'pi-config-scope', 'set', 'invalid', '--profile', 'smoke'],
    process.env,
  );
  if (
    invalidScope.code === 0 ||
    !invalidScope.output.includes('Pi config scope') ||
    !invalidScope.output.includes('Usage:')
  ) {
    throw new Error(`invalid Pi config scope did not fail with help: ${invalidScope.output}`);
  }
  const unknownScopeCommand = await runResult(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'pi-config-scope', 'unknown'],
    process.env,
  );
  if (
    unknownScopeCommand.code === 0 ||
    !unknownScopeCommand.output.includes('未知命令') ||
    !unknownScopeCommand.output.includes('Usage:')
  ) {
    throw new Error(`unknown Pi config scope command did not fail with help: ${unknownScopeCommand.output}`);
  }
  const transportStatus = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'transport', '--profile', 'smoke'],
    process.env,
  );
  if (!transportStatus.includes('"transport":"rpc"')) {
    throw new Error(`unexpected default transport: ${transportStatus}`);
  }
  const transportSet = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'transport', 'spawn-per-turn', '--profile', 'smoke'],
    process.env,
  );
  if (!transportSet.includes('"transport":"spawn-per-turn"')) {
    throw new Error(`unexpected transport update: ${transportSet}`);
  }
  await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'transport', 'rpc', '--profile', 'smoke'],
    process.env,
  );
  const rpcValidation = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'validate', '--profile', 'smoke', '--pi-bin', pi],
    {
      ...process.env,
      APP_SECRET: 'must-not-reach-fake-pi',
      NODE_EXTRA_CA_CERTS: '/must/not/reach/fake-pi.pem',
    },
  );
  if (!rpcValidation.includes('"ok":true')) {
    throw new Error(`unexpected RPC validate output: ${rpcValidation}`);
  }
  await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'transport', 'spawn-per-turn', '--profile', 'smoke'],
    process.env,
  );
  await run(
    process.execPath,
    [
      'dist/cli.js',
      '--home',
      root,
      'model-config',
      '--profile',
      'smoke',
      '--provider',
      'local',
      '--model',
      'vision-model',
      '--base-url',
      'http://127.0.0.1:12345/v1',
      '--api',
      'openai-responses',
      '--input',
      'text,image',
    ],
    process.env,
  );
  await run(
    process.execPath,
    [
      'dist/cli.js',
      '--home',
      root,
      'init',
      '--profile',
      'smoke',
      '--app-id',
      'cli_smoke',
      '--app-secret-file',
      sourceSecretFile,
      '--allow-user',
      'ou_smoke',
    ],
    process.env,
  );
  const reinitializedStatus = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'status', 'smoke'],
    process.env,
  );
  if (
    !reinitializedStatus.includes('"model":"local/vision-model"') ||
    !reinitializedStatus.includes('"input":["text","image"]') ||
    !reinitializedStatus.includes('"transport":"spawn-per-turn"')
  ) {
    throw new Error(`init did not preserve existing model/transport: ${reinitializedStatus}`);
  }
  const workspaceOutput = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'workspace', 'set', 'project', project, '--profile', 'smoke'],
    process.env,
  );
  if (!workspaceOutput.includes('"alias":"project"')) {
    throw new Error(`unexpected workspace output: ${workspaceOutput}`);
  }
  const defaultSet = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'workspace', 'default', 'set', 'project', '--profile', 'smoke'],
    process.env,
  );
  if (!defaultSet.includes('"alias":"project"')) {
    throw new Error(`unexpected default update: ${defaultSet}`);
  }
  const defaultGet = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'workspace', 'default', 'get', '--profile', 'smoke'],
    process.env,
  );
  if (!defaultGet.includes('"alias":"project"') || !defaultGet.includes('"available":true')) {
    throw new Error(`unexpected default status: ${defaultGet}`);
  }
  const statusOutput = await run(
    process.execPath,
    ['dist/cli.js', '--home', root, 'profile', 'status', 'smoke'],
    process.env,
  );
  if (
    !statusOutput.includes('"project"') ||
    !statusOutput.includes('"defaultAlias":"project"') ||
    statusOutput.includes('credentialSource')
  ) {
    throw new Error(`unexpected profile status output: ${statusOutput}`);
  }
  const protectedRemoval = await runResult(
    process.execPath,
    ['dist/cli.js', '--home', root, 'workspace', 'remove', 'project', '--profile', 'smoke'],
    process.env,
  );
  if (protectedRemoval.code === 0 || !protectedRemoval.output.includes('不能删除当前默认 workspace')) {
    throw new Error(`default workspace removal was not rejected: ${protectedRemoval.output}`);
  }
  const unknown = await runResult(process.execPath, ['dist/cli.js', 'does-not-exist', '--help'], process.env);
  if (unknown.code === 0 || !unknown.output.includes('未知命令')) {
    throw new Error(`unknown command did not fail: ${unknown.output}`);
  }
  await verifyFixtureSecretNotLeaked(root);
  console.log('smoke:local passed (loopback-only Pi probe; no Lark connection, real model, or real credentials)');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}

async function fakePi(root) {
  const path = join(root, 'fake-pi.mjs');
  const record = join(root, 'fake-pi-record.jsonl');
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const flags = ${JSON.stringify([
      '--mode',
      '--model',
      '--session',
      '--session-dir',
      '--tools',
      '--append-system-prompt',
      '--no-approve',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
    ])};
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');
if (process.argv[2] === '--version') process.stdout.write('0.99.1\\n');
else if (process.argv[2] === '--help') process.stdout.write(flags.join('\\n'));
else if (process.argv.includes('rpc')) {
  const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
  let buffered = '';
  let uiPromptId;
  function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
  send({ type: 'extension_ui_request', id: 'startup-status', method: 'setStatus', statusKey: 'probe', statusText: 'ready' });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buffered += chunk; let index; while ((index = buffered.indexOf('\\n')) >= 0) { const line = buffered.slice(0, index); buffered = buffered.slice(index + 1); if (line) handle(JSON.parse(line)); } });
  async function handle(command) {
    if (command.type === 'get_state') return send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'smoke-rpc-probe', isStreaming: false } });
    if (command.type === 'get_commands') return send({ id: command.id, type: 'response', command: 'get_commands', success: true, data: { commands: [{ name: 'lark-pi-bridge-ui-probe', description: 'probe', source: 'extension' }] } });
    if (command.type === 'prompt' && command.message === '/lark-pi-bridge-ui-probe') {
      uiPromptId = command.id;
      return send({ type: 'extension_ui_request', id: 'blocking-confirm', method: 'confirm', title: 'Bridge RPC UI probe', message: 'Cancel safely.' });
    }
    if (command.type === 'extension_ui_response' && command.id === 'blocking-confirm') {
      return send({ id: uiPromptId, type: 'response', command: 'prompt', success: true, data: { disposition: 'handled' } });
    }
    if (command.type === 'prompt') {
      await fetch(models.providers['lark-pi-bridge-rpc-probe'].baseUrl + '/chat/completions', { method: 'POST', body: '{}' });
      send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'rpc-probe' } });
      send({ type: 'agent_end' });
      return send({ type: 'agent_settled' });
    }
  }
} else {
  const models = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
  await fetch(models.providers['lark-pi-bridge-probe'].baseUrl + '/chat/completions', { method: 'POST', body: '{}' });
  process.stdout.write(JSON.stringify({ type: 'session', id: 'smoke-probe' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
}
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

async function verifyFixtureSecretNotLeaked(home) {
  const packageRoot = process.cwd();
  const audit = join(home, 'audit');
  await mkdir(audit, { recursive: true, mode: 0o700 });
  await cp(join(packageRoot, 'dist'), join(audit, 'dist'), { recursive: true });
  await cp(join(packageRoot, 'README.md'), join(audit, 'README.md'));
  const files = await walk(audit);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.includes('${SMOKE_SECRET_NOT_REAL}')) {
      throw new Error(`fixture secret leaked into ${file}`);
    }
  }
  const configText = await readFile(join(home, 'config.json'), 'utf8');
  if (configText.includes('${SMOKE_SECRET_NOT_REAL}')) {
    throw new Error('fixture secret leaked into config.json');
  }
  const record = await readFile(join(home, 'fake-pi-record.jsonl'), 'utf8');
  if (
    record.includes('${SMOKE_SECRET_NOT_REAL}') ||
    record.includes('must-not-reach-fake-pi') ||
    record.includes('/must/not/reach/fake-pi.pem')
  ) {
    throw new Error('secret leaked into Pi capability probe argv or environment');
  }
  for (const file of [join(home, 'config.json'), join(home, 'profiles', 'smoke', 'app-secret')]) {
    if (((await stat(file)).mode & 0o777) !== 0o600) {
      throw new Error(`expected private mode for ${file}`);
    }
  }
}

async function walk(root) {
  const names = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const name of names) {
    const path = join(root, name.name);
    if (name.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (name.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function run(command, args, env) {
  const result = await runResult(command, args, env);
  if (result.code !== 0) {
    throw new Error(`${command} exited ${result.code}: ${result.output}`);
  }
  return result.output;
}

function runResult(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
}
