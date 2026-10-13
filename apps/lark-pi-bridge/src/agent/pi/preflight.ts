import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPiChildEnv } from '../../platform/pi-env.js';
import { spawnProcess } from '../../platform/spawn.js';

export const MIN_PI_VERSION = [0, 85, 1] as const;
export const MIN_NODE_VERSION = [22, 19, 0] as const;
export const REQUIRED_PI_FLAGS = [
  '--mode',
  '--model',
  '--session',
  '--session-dir',
  '--tools',
  '--append-system-prompt',
  '--no-approve',
] as const;

const MAX_CAPTURE_CHARS = 256 * 1024;
const MAX_PROTOCOL_LINES = 4096;
const PROBE_PROVIDER = 'lark-pi-bridge-probe';
const PROBE_MODEL = 'loopback';

type Version = readonly [number, number, number];

export interface PiCompatibilityOptions {
  binary?: string;
  timeoutMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface PiCompatibilityResult {
  version: string;
}

/** Parse the semver emitted by `pi --version`, allowing an optional `v` prefix. */
export function parsePiVersion(output: string): string | undefined {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/m.exec(output.trim());
  if (!match) {
    return undefined;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Reject runtimes older than the bridge's minimum, without pinning a Pi minor line. */
export function assertSupportedRuntime(nodeVersion = process.versions.node, piVersion?: string): void {
  const node = parseVersion(nodeVersion);
  if (!node || compare(node, MIN_NODE_VERSION) < 0) {
    throw new Error(`Node.js >=${MIN_NODE_VERSION.join('.')} is required; found ${nodeVersion || 'unknown'}`);
  }
  if (!piVersion) {
    throw new Error('Pi version output did not contain a semantic version');
  }
  const pi = parseVersion(piVersion);
  if (!pi || compare(pi, MIN_PI_VERSION) < 0) {
    throw new Error(`Pi >=${MIN_PI_VERSION.join('.')} is required; found ${piVersion}`);
  }
}

/** Confirm that the selected binary exposes every CLI switch used by the bridge. */
export function assertPiCliCapabilities(helpOutput: string): void {
  const missing = REQUIRED_PI_FLAGS.filter(
    (flag) => !new RegExp(`(^|\\s)${escapeRegExp(flag)}(?=\\s|,|$)`, 'm').test(helpOutput),
  );
  if (missing.length) {
    throw new Error(`Pi CLI is missing required flags: ${missing.join(', ')}`);
  }
}

/**
 * Validate the Pi found on PATH (or an explicit binary) by capability rather
 * than minor-version allowlist. The JSON probe uses a fresh PI_CODING_AGENT_DIR
 * and a model endpoint bound only to 127.0.0.1, so it cannot read the user's Pi
 * credentials or contact a real provider.
 */
export async function checkPiCompatibility(options: PiCompatibilityOptions = {}): Promise<PiCompatibilityResult> {
  const binary = options.binary ?? 'pi';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const root = await mkdtemp(join(tmpdir(), 'lark-pi-bridge-preflight-'));
  const piAgentDir = join(root, 'pi-agent');
  const piSessionDir = join(root, 'sessions');
  let server: Server | undefined;
  try {
    await Promise.all([
      mkdir(piAgentDir, { recursive: true, mode: 0o700 }),
      mkdir(piSessionDir, { recursive: true, mode: 0o700 }),
    ]);
    const env = buildPiChildEnv({
      bridgeEnv: {},
      piConfigDir: piAgentDir,
      baseEnv: { ...(options.baseEnv ?? process.env), HOME: root },
    });
    delete env.SSL_CERT_FILE;
    delete env.SSL_CERT_DIR;
    delete env.NODE_EXTRA_CA_CERTS;
    const versionResult = await capture(binary, ['--version'], env, '', 5_000);
    if (versionResult.code !== 0) {
      throw new Error(`Pi version check exited with ${versionResult.code ?? 'signal'}`);
    }
    const version = parsePiVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    assertSupportedRuntime(process.versions.node, version);

    const helpResult = await capture(binary, ['--help'], env, '', 5_000);
    if (helpResult.code !== 0) {
      throw new Error(`Pi help check exited with ${helpResult.code ?? 'signal'}`);
    }
    assertPiCliCapabilities(`${helpResult.stdout}\n${helpResult.stderr}`);

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
          request.destroy(new Error('probe request exceeded 1 MiB'));
        }
      });
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close',
        });
        response.write(`data: ${JSON.stringify(probeChunk('probe', null))}\n\n`);
        response.write(`data: ${JSON.stringify(probeChunk(undefined, 'stop'))}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    await listenLoopback(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Pi protocol probe could not allocate a loopback port');
    }
    await writeFile(
      join(piAgentDir, 'models.json'),
      `${JSON.stringify(
        {
          providers: {
            [PROBE_PROVIDER]: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'local-probe-key-not-real',
              api: 'openai-completions',
              models: [{ id: PROBE_MODEL, name: 'Local protocol probe', contextWindow: 4096, maxTokens: 64 }],
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const probe = await capture(
      binary,
      ['--mode', 'json', '--model', `${PROBE_PROVIDER}/${PROBE_MODEL}`, '--session-dir', piSessionDir, '--no-approve'],
      env,
      'Reply exactly: probe\n',
      timeoutMs,
    );
    const stream = inspectProtocolStream(probe.stdout);
    if (probe.code !== 0) {
      throw new Error(
        `Pi JSON protocol probe exited with ${probe.code ?? 'signal'}${probe.stderr.trim() ? `: ${truncate(probe.stderr.trim(), 500)}` : ''}`,
      );
    }
    if (requestCount < 1) {
      throw new Error('Pi JSON protocol probe did not call the isolated loopback model');
    }
    if (stream.malformedLines > 0) {
      throw new Error(`Pi JSON protocol probe emitted ${stream.malformedLines} malformed JSON line(s)`);
    }
    if (!stream.eventTypes.includes('session')) {
      throw new Error('Pi JSON protocol probe did not emit a session event');
    }
    if (stream.eventTypes.at(-1) !== 'agent_settled') {
      throw new Error('Pi JSON protocol probe did not end at the required agent_settled terminal event');
    }
    return { version: version! };
  } finally {
    if (server) {
      await closeServer(server);
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

function probeChunk(content: string | undefined, finishReason: string | null): Record<string, unknown> {
  return {
    id: 'lark-pi-bridge-probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: `${PROBE_PROVIDER}/${PROBE_MODEL}`,
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

function capture(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk.toString('utf8'));
    });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (timedOut) {
        reject(new Error(`Pi capability check timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(stdin, 'utf8');
  });
}

function inspectProtocolStream(stdout: string): { eventTypes: string[]; malformedLines: number } {
  const lines = stdout.split('\n').filter((line) => line.trim());
  if (lines.length > MAX_PROTOCOL_LINES) {
    throw new Error(`Pi JSON protocol probe exceeded ${MAX_PROTOCOL_LINES} output lines`);
  }
  const eventTypes: string[] = [];
  let malformedLines = 0;
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as { type?: unknown };
      if (typeof value.type === 'string') {
        eventTypes.push(value.type);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }
  return { eventTypes, malformedLines };
}

function boundedAppend(current: string, next: string): string {
  const combined = `${current}${next}`;
  return combined.length > MAX_CAPTURE_CHARS ? combined.slice(combined.length - MAX_CAPTURE_CHARS) : combined;
}

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index++) {
    const delta = left[index]! - right[index]!;
    if (delta) {
      return delta;
    }
  }
  return 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}
