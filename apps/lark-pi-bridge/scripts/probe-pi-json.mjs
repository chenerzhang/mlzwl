import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--') {
  args.shift();
}
const [piBin = 'pi'] = args;
const root = await mkdtemp(join(tmpdir(), 'lark-pi-bridge-json-probe-'));
const agentDir = join(root, 'pi-agent');
const sessionDir = join(root, 'sessions');
let requestCount = 0;
const server = createServer((request, response) => {
  const remote = request.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') {
    response.writeHead(403).end();
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }
  requestCount += 1;
  request.resume();
  request.once('end', () => {
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    response.write(`data: ${JSON.stringify(chunk('probe', null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(undefined, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
});

try {
  await Promise.all([
    mkdir(agentDir, { recursive: true, mode: 0o700 }),
    mkdir(sessionDir, { recursive: true, mode: 0o700 }),
  ]);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('could not allocate loopback port');
  }
  await writeFile(
    join(agentDir, 'models.json'),
    `${JSON.stringify(
      {
        providers: {
          'bridge-probe': {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'probe-key-not-real',
            api: 'openai-completions',
            models: [{ id: 'loopback', name: 'Loopback probe', contextWindow: 4096, maxTokens: 64 }],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEMETRY: '0',
    PI_SKIP_VERSION_CHECK: '1',
  };
  const versionResult = await capture(piBin, ['--version'], env);
  const version = /(?:^|\s)v?(\d+\.\d+\.\d+)/m.exec(versionResult.stdout)?.[1];
  if (!version) {
    throw new Error(`could not parse Pi version: ${versionResult.stdout.trim()}`);
  }
  const run = await capture(
    piBin,
    [
      '--mode',
      'json',
      '--model',
      'bridge-probe/loopback',
      '--session-dir',
      sessionDir,
      '--no-approve',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
    ],
    env,
    'Reply exactly: probe\n',
  );
  const events = run.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const eventTypes = events.map((event) => event.type);
  const summary = {
    piBin,
    version,
    exitCode: run.code,
    loopbackRequests: requestCount,
    eventTypes,
    sawSession: eventTypes.includes('session'),
    sawAgentEnd: eventTypes.includes('agent_end'),
    sawAgentSettled: eventTypes.includes('agent_settled'),
    stderrBytes: Buffer.byteLength(run.stderr),
    stderrExcerpt: truncate(run.stderr.replace(/[\r\n]+/g, ' '), 500),
  };
  console.log(JSON.stringify(summary));
  if (run.code !== 0 || requestCount < 1 || !summary.sawSession || eventTypes.at(-1) !== 'agent_settled') {
    throw new Error('Pi JSON stream failed the isolated loopback agent_settled terminal probe');
  }
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}

function chunk(content, finishReason) {
  return {
    id: 'bridge-probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'bridge-probe/loopback',
    choices: [
      { index: 0, delta: content === undefined ? {} : { role: 'assistant', content }, finish_reason: finishReason },
    ],
    ...(finishReason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  };
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function capture(command, args, env, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (value) => {
      stdout += value;
    });
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
