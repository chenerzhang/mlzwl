import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { log, redactKnownPaths, redactText } from '../../core/logger.js';
import { buildPiChildEnv } from '../../platform/pi-env.js';
import { spawnProcessPrivate, type SpawnedProcessByStdio } from '../../platform/spawn.js';
import { BRIDGE_SYSTEM_PROMPT, buildBridgeUserPrompt } from '../bridge-system-prompt.js';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env.js';
import type {
  AgentAdapter,
  AgentAvailability,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types.js';
import { buildPiArgs } from './argv.js';
import { StrictPiJsonlDecoder, type PiJsonlLimits } from './jsonl.js';
import { PiJsonTranslator, type PiFinishReason } from './json-translator.js';
import { checkPiCompatibility } from './preflight.js';

export interface PiAdapterOptions {
  binary?: string;
  piConfigDir: string;
  handoffPiConfigDir?: string;
  piSessionDir: string;
  bridgeSystemPromptFile: string;
  larkChannel?: LarkChannelEnvContext;
  stopGraceMs?: number;
  /** Test/defence-in-depth overrides; production defaults remain bounded. */
  jsonlLimits?: PiJsonlLimits;
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi coding agent';
  private readonly binary: string;
  private identity: AgentBotIdentity | undefined;
  private readonly graceMs: number;

  constructor(private readonly opts: PiAdapterOptions) {
    this.binary = opts.binary ?? 'pi';
    this.graceMs = opts.stopGraceMs ?? 5_000;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.identity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      const result = await checkPiCompatibility({ binary: this.binary });
      return { ok: true, version: result.version };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  async prepareRun(_opts?: AgentRunOptions): Promise<void> {
    await Promise.all([
      mkdir(dirname(this.opts.bridgeSystemPromptFile), { recursive: true, mode: 0o700 }),
      mkdir(this.opts.piSessionDir, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(this.opts.bridgeSystemPromptFile, BRIDGE_SYSTEM_PROMPT, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.opts.bridgeSystemPromptFile, 0o600);
  }

  async forkSession(opts: AgentRunOptions) {
    if (!opts.handoff?.sourcePath) {
      throw new Error('Pi fork requires an exact source path resolved by the bridge.');
    }
    const args = buildPiArgs({
      accessMode: 'full',
      handoff: true,
      forkPath: opts.handoff.sourcePath,
      sessionDir: this.opts.piSessionDir,
      bridgeSystemPromptFile: this.opts.bridgeSystemPromptFile,
    });
    const child = spawnProcessPrivate(this.binary, args, {
      cwd: opts.cwd,
      env: buildPiChildEnv({
        bridgeEnv: buildLarkChannelEnv(this.opts.larkChannel),
        piConfigDir: this.opts.handoffPiConfigDir ?? join(homedir(), '.pi', 'agent'),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;
    child.stdin.end();
    const decoder = new StrictPiJsonlDecoder();
    const translator = new PiJsonTranslator({
      knownSensitivePaths: [
        opts.cwd,
        this.opts.piSessionDir,
        this.opts.bridgeSystemPromptFile,
        opts.handoff.sourcePath,
      ],
    });
    const deadline = setTimeout(() => child.kill('SIGTERM'), 10_000);
    deadline.unref();
    try {
      for await (const chunk of child.stdout) {
        for (const raw of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))) {
          for (const event of translator.translate(raw)) {
            if (event.type === 'system' && event.sessionId) {
              child.kill('SIGTERM');
              await waitForExit(child, 1_000);
              return { sessionId: event.sessionId, isStreaming: false };
            }
          }
        }
      }
      throw new Error('Pi native fork exited without an authoritative session event.');
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, 1_000);
      }
    }
  }

  async probeModel(opts: Omit<AgentRunOptions, 'runId' | 'prompt' | 'sessionId' | 'attachments'>): Promise<void> {
    await this.prepareRun();
    const run = this.run({
      ...opts,
      runId: `doctor-${Date.now()}`,
      prompt: 'Reply exactly: LARK_PI_BRIDGE_DOCTOR_OK',
    });
    let matched = false;
    let terminal: AgentEvent | undefined;
    for await (const event of run.events) {
      if (event.type === 'text' && event.delta.includes('LARK_PI_BRIDGE_DOCTOR_OK')) {
        matched = true;
      }
      if (event.type === 'done' || event.type === 'error') {
        terminal = event;
      }
    }
    if (terminal?.type === 'error') {
      throw new Error(`Pi model probe failed: ${terminal.message}`);
    }
    if (terminal?.type !== 'done' || terminal.terminationReason !== 'normal') {
      throw new Error('Pi model probe did not complete normally');
    }
    if (!matched) {
      throw new Error('Pi model probe response did not contain the expected marker');
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (opts.promptMode === 'pi-command') {
      return failedRun(opts.runId, '/pi 命令只支持 RPC transport。');
    }
    const args = buildPiArgs({
      accessMode: opts.accessMode,
      handoff: Boolean(opts.handoff),
      forkPath: opts.handoff?.sourcePath,
      sessionDir: this.opts.piSessionDir,
      sessionId: opts.sessionId,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      attachments: opts.attachments,
      bridgeSystemPromptFile: this.opts.bridgeSystemPromptFile,
    });
    const child = spawnProcessPrivate(this.binary, args, {
      cwd: opts.cwd,
      env: buildPiChildEnv({
        bridgeEnv: buildLarkChannelEnv(this.opts.larkChannel),
        piConfigDir: opts.handoff
          ? (this.opts.handoffPiConfigDir ?? join(homedir(), '.pi', 'agent'))
          : this.opts.piConfigDir,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;
    const stderr = new BoundedText(4_096);
    const logSensitivePaths = [opts.cwd, this.opts.piSessionDir, this.opts.bridgeSystemPromptFile];
    if (opts.handoff?.sourcePath) {
      logSensitivePaths.push(opts.handoff.sourcePath);
    }
    let runtimeError: Error | undefined;
    let stopReason: PiFinishReason | undefined;
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr.append(text);
      log.warn('agent', 'pi-stderr', {
        message: truncate(redactText(redactKnownPaths(text, logSensitivePaths)).replace(/[\r\n]+/g, ' '), 500),
      });
    });
    child.on('error', (error) => {
      runtimeError = error;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'pi-exit', { pid: child.pid ?? null, code, signal });
    });
    child.stdin.on('error', (error) => log.warn('agent', 'pi-stdin-error', { message: error.message }));
    child.stdin.end(buildBridgeUserPrompt(withAttachments(opts.prompt, opts.attachments), this.identity), 'utf8');
    log.info('agent', 'pi-spawn', {
      pid: child.pid ?? null,
      hasSession: Boolean(opts.sessionId),
      accessMode: opts.accessMode,
      promptChars: opts.prompt.length,
    });

    const graceMs = opts.stopGraceMs ?? this.graceMs;
    return {
      runId: opts.runId,
      events: eventStream(
        child,
        stderr,
        () => runtimeError,
        () => stopReason,
        logSensitivePaths,
        this.opts.jsonlLimits,
      ),
      async stop(reason = 'interrupted') {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        stopReason = reason;
        child.kill('SIGTERM');
        if (!(await waitForExit(child, graceMs))) {
          child.kill('SIGKILL');
          await waitForExit(child, 1_000);
        }
      },
      waitForExit: (timeoutMs) => waitForExit(child, timeoutMs),
    };
  }

  async dispose(): Promise<void> {
    /* spawn-per-turn mode owns no idle process */
  }
}

async function* eventStream(
  child: PiChild,
  stderr: BoundedText,
  getError: () => Error | undefined,
  getStopReason: () => PiFinishReason | undefined,
  knownSensitivePaths: readonly string[],
  limits?: PiJsonlLimits,
): AsyncGenerator<AgentEvent> {
  const translator = new PiJsonTranslator({ knownSensitivePaths });
  const decoder = new StrictPiJsonlDecoder(limits);
  let terminal: AgentEvent | undefined;
  let protocolError: Error | undefined;
  if (!child.pid) {
    yield failure(getError()?.message ?? 'Pi spawn returned no pid');
    return;
  }

  try {
    for await (const chunk of child.stdout) {
      for (const raw of decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))) {
        for (const event of translator.translate(raw)) {
          if (event.type === 'done' || event.type === 'error') {
            terminal = event;
          } else {
            yield event;
          }
        }
      }
    }
    decoder.finish();
  } catch (error) {
    protocolError = error instanceof Error ? error : new Error(String(error));
    log.warn('pi-json', 'protocol-error', {
      message: truncate(redactText(redactKnownPaths(protocolError.message, knownSensitivePaths)), 500),
    });
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!(await waitForExit(child, 1_000))) {
        child.kill('SIGKILL');
        await waitForExit(child, 1_000);
      }
    }
  }

  const stopReason = getStopReason();
  if (stopReason) {
    if (terminal) {
      yield terminal;
    } else {
      yield* translator.finish(stopReason);
    }
    return;
  }
  if (protocolError) {
    if (terminal?.type === 'error') {
      yield terminal;
    } else {
      yield failure(`Pi JSON protocol error: ${protocolError.message}`);
    }
    return;
  }
  const exitCode = await exitCodeFor(child);
  if (getError()) {
    if (terminal?.type === 'error') {
      yield terminal;
    } else {
      yield failure(`Pi runtime error: ${getError()!.message}`);
    }
    return;
  }
  if (exitCode !== 0 && exitCode !== null) {
    if (terminal?.type === 'error') {
      yield terminal;
    } else {
      yield failure(`Pi exited with code ${exitCode}${stderr.text() ? `: ${stderr.text()}` : ''}`);
    }
    return;
  }
  if (terminal) {
    yield terminal;
    return;
  }
  yield* translator.finish();
}

function withAttachments(prompt: string, attachments: string[] | undefined): string {
  if (!attachments?.length) {
    return prompt;
  }
  return `${prompt}\n\n<bridge_attachments>\n${JSON.stringify(attachments)}\n</bridge_attachments>`;
}

function failedRun(runId: string, message: string): AgentRun {
  return {
    runId,
    events: {
      async *[Symbol.asyncIterator]() {
        yield failure(message);
      },
    },
    async stop() {},
    async waitForExit() {
      return true;
    },
  };
}

function failure(message: string): AgentEvent {
  return { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' };
}
function waitForExit(child: PiChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
function exitCodeFor(child: PiChild): Promise<number | null> {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}
class BoundedText {
  private value = '';
  constructor(private readonly max: number) {}
  append(value: string): void {
    this.value = truncate(`${this.value}${value}`, this.max);
  }
  text(): string {
    return this.value.trim();
  }
}
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}
