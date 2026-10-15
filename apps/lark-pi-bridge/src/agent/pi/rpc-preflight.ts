import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { buildPiChildEnv } from '../../platform/pi-env.js';
import { spawnProcessPrivate, type SpawnedProcessByStdio } from '../../platform/spawn.js';
import { buildPiRpcArgs } from './rpc-argv.js';
import { StrictPiRpcConnection } from './rpc-connection.js';
import { PiJsonTranslator } from './json-translator.js';

const PROVIDER = 'lark-pi-bridge-rpc-probe';
const MODEL = 'loopback';

type PiRpcChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

/** Exercise the installed Pi RPC command/response/event contract using only a loopback model. */
export async function checkPiRpcCompatibility(input: {
  binary: string;
  timeoutMs?: number;
  eventTimeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const eventTimeoutMs = input.eventTimeoutMs ?? timeoutMs;
  const root = await mkdtemp(join(tmpdir(), 'lark-pi-bridge-rpc-preflight-'));
  const piAgentDir = join(root, 'pi-agent');
  const piSessionDir = join(piAgentDir, 'sessions');
  const piExtensionsDir = join(piAgentDir, 'extensions');
  const promptFile = join(piAgentDir, 'rpc-probe-system.md');
  let server: Server | undefined;
  let connection: StrictPiRpcConnection | undefined;
  try {
    await Promise.all([
      mkdir(piAgentDir, { recursive: true, mode: 0o700 }),
      mkdir(piSessionDir, { recursive: true, mode: 0o700 }),
      mkdir(piExtensionsDir, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(promptFile, 'Reply to the probe only.\n', { mode: 0o600 }),
      writeFile(join(piExtensionsDir, 'lark-pi-bridge-rpc-probe.ts'), RPC_UI_PROBE_EXTENSION, { mode: 0o600 }),
    ]);
    let requestCount = 0;
    server = createServer((request, response) => {
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
      let received = 0;
      request.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > 1024 * 1024) {
          request.destroy(new Error('RPC probe request exceeded 1 MiB'));
        }
      });
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close',
        });
        response.write(`data: ${JSON.stringify(probeChunk('rpc-probe', null))}\n\n`);
        response.write(`data: ${JSON.stringify(probeChunk(undefined, 'stop'))}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    await listenLoopback(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Pi RPC probe could not allocate a loopback port');
    }
    await writeFile(
      join(piAgentDir, 'models.json'),
      `${JSON.stringify(
        {
          providers: {
            [PROVIDER]: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'local-rpc-probe-key-not-real',
              api: 'openai-completions',
              models: [
                {
                  id: MODEL,
                  name: 'Local RPC protocol probe',
                  reasoning: true,
                  contextWindow: 4096,
                  maxTokens: 64,
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const env = buildPiChildEnv({ piConfigDir: piAgentDir, bridgeEnv: {}, baseEnv: { ...process.env, HOME: root } });
    delete env.SSL_CERT_FILE;
    delete env.SSL_CERT_DIR;
    delete env.NODE_EXTRA_CA_CERTS;
    const child = spawnProcessPrivate(
      input.binary,
      buildPiRpcArgs({
        accessMode: 'read-only',
        sessionDir: piSessionDir,
        model: `${PROVIDER}/${MODEL}`,
        bridgeSystemPromptFile: promptFile,
      }),
      { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as PiRpcChild;
    if (!child.pid) {
      throw new Error('Pi RPC protocol probe returned no pid');
    }
    const uiMethods: string[] = [];
    connection = new StrictPiRpcConnection(child, {
      commandTimeoutMs: timeoutMs,
      extensionUIHandler: {
        async onRequest(request) {
          uiMethods.push(request.request.method);
          return request.request.method === 'confirm' ? { confirmed: false } : undefined;
        },
        onPromptLifecycle() {
          // Current Pi builds accept these official lifecycle events, although
          // they do not emit them for every RPC dialog.
        },
      },
    });
    const events: unknown[] = [];
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const unsubscribe = connection.onEvent((event) => {
      events.push(event);
      if (recordType(event) === 'agent_settled') {
        resolveSettled();
      }
    });
    const state = await connection.getState();
    if (state.isStreaming || state.model?.provider !== PROVIDER || state.model.id !== MODEL || !state.thinkingLevel) {
      throw new Error('Pi RPC protocol probe started with invalid model state');
    }
    const models = await connection.getAvailableModels();
    if (!models.some((model) => model.provider === PROVIDER && model.id === MODEL)) {
      throw new Error('Pi RPC protocol probe did not list its isolated model');
    }
    const thinkingLevels = await connection.getAvailableThinkingLevels();
    if (!thinkingLevels.includes('off')) {
      throw new Error('Pi RPC protocol probe returned invalid thinking levels');
    }
    await connection.setModel(PROVIDER, MODEL);
    await connection.setThinkingLevel('off');
    const selectedState = await connection.getState();
    if (
      selectedState.model?.provider !== PROVIDER ||
      selectedState.model.id !== MODEL ||
      selectedState.thinkingLevel !== 'off'
    ) {
      throw new Error('Pi RPC protocol probe could not control model and thinking state');
    }
    const commands = await connection.getCommands();
    if (!commands.some((command) => command.name === 'lark-pi-bridge-ui-probe' && command.source === 'extension')) {
      throw new Error('Pi RPC protocol probe did not discover its isolated extension command');
    }
    const uiDisposition = await connection.prompt('/lark-pi-bridge-ui-probe');
    if (uiDisposition !== 'handled') {
      throw new Error(`Pi RPC extension UI probe returned ${uiDisposition}`);
    }
    await nextTurn();
    if (!uiMethods.includes('setStatus') || !uiMethods.includes('confirm')) {
      throw new Error('Pi RPC extension UI probe did not observe startup status and blocking confirmation');
    }
    const disposition = await connection.prompt('Reply exactly: rpc-probe');
    if (disposition !== 'started') {
      throw new Error(`Pi RPC protocol probe returned ${disposition}`);
    }
    await withTimeout(
      settled,
      eventTimeoutMs,
      `Pi RPC protocol probe did not emit agent_settled within ${eventTimeoutMs}ms`,
    );
    const finalState = await connection.getState();
    if (finalState.sessionId !== state.sessionId || finalState.isStreaming) {
      throw new Error('Pi RPC protocol probe ended with inconsistent session state');
    }
    unsubscribe();
    const translator = new PiJsonTranslator();
    translator.primeSession(state.sessionId);
    const translated = events.flatMap((event) => translator.translate(event));
    const terminal = translated.at(-1);
    if (terminal?.type !== 'done' || terminal.terminationReason !== 'normal') {
      throw new Error('Pi RPC protocol probe did not end at the required agent_settled terminal event');
    }
    if (requestCount !== 1) {
      throw new Error(`Pi RPC protocol probe expected one loopback request; saw ${requestCount}`);
    }
  } finally {
    await connection?.dispose().catch(() => {});
    if (server) {
      await closeServer(server);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

const RPC_UI_PROBE_EXTENSION = `export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.setStatus('lark-pi-bridge-probe', 'ready');
  });
  pi.registerCommand('lark-pi-bridge-ui-probe', {
    description: 'Isolated Bridge RPC UI compatibility probe',
    handler: async (_args, ctx) => {
      await ctx.ui.confirm('Bridge RPC UI probe', 'Cancel this isolated compatibility probe safely.');
    },
  });
}\n`;

function probeChunk(content: string | undefined, finishReason: string | null): Record<string, unknown> {
  return {
    id: 'lark-pi-bridge-rpc-probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: `${PROVIDER}/${MODEL}`,
    choices: [
      {
        index: 0,
        delta: content === undefined ? {} : { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    ...(finishReason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  };
}

function recordType(value: unknown): string | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? typeof (value as { type?: unknown }).type === 'string'
      ? (value as { type: string }).type
      : undefined
    : undefined;
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function withTimeout<T>(value: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    value,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref();
    }),
  ]);
}
