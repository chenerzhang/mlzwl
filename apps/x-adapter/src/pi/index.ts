import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_PROVIDER_ID = 'x-adapter';
const DEFAULT_BASE_URL = 'http://127.0.0.1:10100';
const DEFAULT_API_KEY = 'dummy-token';
const DISCOVERY_USER_AGENT = 'codex-cli';
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const HEALTH_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const MODEL_REQUEST_TIMEOUT_MS = 2_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_ATTEMPTS = 20;
const DISCOVERY_POLL_ATTEMPTS = 20;

interface ExtensionCommandContext {
  cwd: string;
  ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

interface ExtensionExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface ExtensionAPI {
  registerProvider(name: string, config: ProviderConfig): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, context: ExtensionCommandContext): Promise<void>;
    },
  ): void;
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
  ): Promise<ExtensionExecResult>;
}

interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: 'openai-responses';
  headers: Record<string, string>;
  models: ProviderModelConfig[];
  refreshModels(context: { allowNetwork?: boolean; signal: AbortSignal }): Promise<ProviderModelConfig[]>;
}

interface ProviderModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap: Record<string, string | null>;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: { supportsDeveloperRole: false; sessionAffinityFormat: 'openrouter' };
}

type DiscoveredModel = {
  slug: string;
  displayName: string;
  provider?: string;
  contextWindow: number;
  modelLoad?: number;
  reasoningLevels: string[];
};

type XAdapterHealth = {
  ok: true;
  name: 'x-adapter';
  version: string;
  host: string;
  port: number;
};

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  signal: AbortSignal;
  timeout: number;
};

type CommandRunner = (command: string, args: string[], options: CommandOptions) => Promise<void>;

async function defaultCommandRunner(command: string, args: string[], options: CommandOptions): Promise<void> {
  await execFileAsync(command, args, {
    env: options.env,
    signal: withTimeout(options.signal, options.timeout),
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
}

let commandRunner: CommandRunner = defaultCommandRunner;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    signal.throwIfAborted();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function baseUrl(): URL {
  const url = new URL(process.env.X_ADAPTER_BASE_URL?.trim() || DEFAULT_BASE_URL);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLoopbackHost(url.hostname)) {
    throw new Error(`x-adapter Pi extension only accepts a loopback http(s) URL: ${url}`);
  }
  if (url.pathname !== '/' && url.pathname !== '/v1' && url.pathname !== '/v1/') {
    throw new Error(`x-adapter Pi extension base URL must not contain a custom path: ${url}`);
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function expectedPort(base: URL): number {
  if (base.port) {
    return Number(base.port);
  }
  return base.protocol === 'https:' ? 443 : 80;
}

function isEnabledEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no' && normalized !== 'off';
}

function autoStartEnabled(base: URL): boolean {
  return base.protocol === 'http:' && isEnabledEnvValue(process.env.X_ADAPTER_AUTO_START);
}

function autoInstallEnabled(): boolean {
  return isEnabledEnvValue(process.env.X_ADAPTER_AUTO_INSTALL);
}

function offlineModeEnabled(): boolean {
  return process.env.PI_OFFLINE === '1';
}

function apiKey(): string {
  return process.env.X_ADAPTER_CLIENT_TOKEN?.trim() || DEFAULT_API_KEY;
}

function providerId(): string {
  return process.env.X_ADAPTER_PROVIDER_ID?.trim() || DEFAULT_PROVIDER_ID;
}

export function parseXAdapterCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: 'single' | 'double' | undefined;

  const finishToken = (): void => {
    if (!tokenStarted) {
      return;
    }
    args.push(current);
    current = '';
    tokenStarted = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote === 'single') {
      if (character === "'") {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === 'double') {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === '\\') {
        index += 1;
        if (index >= input.length) {
          throw new Error('Trailing escape in x-adapter arguments.');
        }
        current += input[index];
        continue;
      }
      current += character;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    tokenStarted = true;
    if (character === "'") {
      quote = 'single';
      continue;
    }
    if (character === '"') {
      quote = 'double';
      continue;
    }
    if (character === '\\') {
      index += 1;
      if (index >= input.length) {
        throw new Error('Trailing escape in x-adapter arguments.');
      }
      current += input[index];
      continue;
    }
    current += character;
  }

  if (quote) {
    throw new Error(`Unterminated ${quote} quote in x-adapter arguments.`);
  }
  finishToken();
  return args;
}

function xAdapterCliInvocation(args: string[]): { command: string; args: string[] } {
  const bundledCli = fileURLToPath(new URL('../bin/index.js', import.meta.url));
  return existsSync(bundledCli)
    ? { command: process.execPath, args: [bundledCli, ...args] }
    : { command: 'x-adapter', args };
}

function renderCommandResult(result: ExtensionExecResult): { message: string; type: 'info' | 'error' } {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  if (result.code === 0 && !result.killed) {
    return { message: output || 'x-adapter completed successfully.', type: 'info' };
  }
  const failure = result.killed ? 'x-adapter was terminated.' : `x-adapter exited with code ${result.code}.`;
  return { message: output ? `${output}\n${failure}` : failure, type: 'error' };
}

function registerXAdapterCommand(pi: ExtensionAPI): void {
  pi.registerCommand('x-adapter', {
    description: 'Run the local x-adapter CLI',
    handler: async (input, context) => {
      let args: string[];
      try {
        args = parseXAdapterCommandArgs(input);
      } catch (error) {
        context.ui.notify(errorMessage(error), 'error');
        return;
      }

      const invocation = xAdapterCliInvocation(args);
      try {
        const result = await pi.exec(invocation.command, invocation.args, { cwd: context.cwd });
        const rendered = renderCommandResult(result);
        context.ui.notify(rendered.message, rendered.type);
      } catch (error) {
        context.ui.notify(`Unable to run x-adapter: ${errorMessage(error)}`, 'error');
      }
    },
  });
}

async function execXAdapter(args: string[], options: CommandOptions): Promise<void> {
  await commandRunner('x-adapter', args, options);
}

async function hasXAdapterBinary(signal: AbortSignal): Promise<boolean> {
  try {
    await execXAdapter(['version'], { signal, timeout: HEALTH_TIMEOUT_MS, maxBuffer: 256 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function installXAdapter(signal: AbortSignal): Promise<void> {
  try {
    await commandRunner('npm', ['i', '-g', '@mlzwl/x-adapter@latest', '--registry=https://registry.npmjs.org'], {
      signal,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Unable to install x-adapter with npm: ${errorMessage(error)}`, { cause: error });
  }
}

async function ensureXAdapterInstalled(signal: AbortSignal): Promise<void> {
  if (await hasXAdapterBinary(signal)) {
    return;
  }
  if (!autoInstallEnabled()) {
    throw new Error('x-adapter CLI is not installed and auto-install is disabled');
  }
  await installXAdapter(signal);
  if (!(await hasXAdapterBinary(signal))) {
    throw new Error('x-adapter install finished, but the `x-adapter` binary is still not available on PATH');
  }
}

function daemonEnv(base: URL): NodeJS.ProcessEnv {
  return {
    ...process.env,
    X_ADAPTER_HOST: base.hostname.replace(/^\[|\]$/g, ''),
    X_ADAPTER_PORT: String(expectedPort(base)),
  };
}

async function startXAdapter(base: URL, signal: AbortSignal): Promise<void> {
  await ensureXAdapterInstalled(signal);
  try {
    await execXAdapter(['start'], {
      env: daemonEnv(base),
      signal,
      timeout: START_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Unable to start x-adapter with \`x-adapter start\`: ${errorMessage(error)}`, { cause: error });
  }
}

function parseHealth(value: unknown, base: URL): XAdapterHealth | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.ok !== true ||
    value.name !== 'x-adapter' ||
    typeof value.version !== 'string' ||
    typeof value.host !== 'string' ||
    typeof value.port !== 'number' ||
    !Number.isFinite(value.port) ||
    !isLoopbackHost(value.host) ||
    value.port !== expectedPort(base)
  ) {
    return undefined;
  }
  return { ok: true, name: 'x-adapter', version: value.version, host: value.host, port: value.port };
}

async function getHealth(base: URL, signal: AbortSignal): Promise<XAdapterHealth> {
  const response = await fetch(`${base.origin}/health`, {
    method: 'GET',
    signal: withTimeout(signal, HEALTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`x-adapter health check returned HTTP ${response.status}`);
  }
  const health = parseHealth(await response.json(), base);
  if (!health) {
    throw new Error(`x-adapter health response is invalid or not bound to ${base.origin}`);
  }
  return health;
}

async function ensureXAdapter(base: URL, signal: AbortSignal): Promise<XAdapterHealth> {
  try {
    return await getHealth(base, signal);
  } catch (healthError) {
    if (!autoStartEnabled(base)) {
      const reason =
        base.protocol === 'https:'
          ? 'x-adapter auto-start only supports direct http loopback URLs'
          : 'auto-start is disabled';
      throw new Error(`x-adapter is unavailable and ${reason}: ${errorMessage(healthError)}`, {
        cause: healthError,
      });
    }
  }

  await startXAdapter(base, signal);
  let lastError: unknown;
  for (let attempt = 0; attempt < HEALTH_POLL_ATTEMPTS; attempt += 1) {
    try {
      return await getHealth(base, signal);
    } catch (error) {
      lastError = error;
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
  }
  throw new Error(`x-adapter did not become healthy after \`x-adapter start\`: ${errorMessage(lastError)}`, {
    cause: lastError,
  });
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function optionalNumberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  }
  const levels = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.effort !== 'string' || !entry.effort) {
      return [];
    }
    return [entry.effort];
  });
  return levels.length ? levels : ['low', 'medium', 'high', 'xhigh', 'max'];
}

function parseModel(value: unknown): DiscoveredModel | undefined {
  if (!isRecord(value) || typeof value.slug !== 'string' || !value.slug) {
    return undefined;
  }
  const provider = typeof value.provider === 'string' ? value.provider : undefined;
  return {
    slug: value.slug,
    displayName: typeof value.display_name === 'string' && value.display_name ? value.display_name : value.slug,
    provider,
    contextWindow: numberField(value.context_window ?? value.max_context_window, DEFAULT_CONTEXT_WINDOW),
    modelLoad: optionalNumberField(value.model_load_percent ?? value.model_load ?? value.hot),
    reasoningLevels: parseReasoningLevels(value.supported_reasoning_levels),
  };
}

function thinkingLevelMap(levels: string[]): Record<string, string | null> {
  const available = new Set(levels);
  return {
    off: available.has('none') ? 'none' : null,
    minimal: available.has('minimal') ? 'minimal' : null,
    low: available.has('low') ? 'low' : null,
    medium: available.has('medium') ? 'medium' : null,
    high: available.has('high') ? 'high' : null,
    xhigh: available.has('xhigh') ? 'xhigh' : null,
    max: available.has('max') ? 'max' : null,
  };
}

/** Keep model_load visible in Pi's standard model selector without changing its ID. */
export function providerModelName(model: DiscoveredModel): string {
  return model.modelLoad === undefined
    ? model.displayName
    : `${model.displayName} · Model load: ${Math.round(model.modelLoad)}%`;
}

function toProviderModel(model: DiscoveredModel): ProviderModelConfig {
  return {
    id: model.slug,
    name: providerModelName(model),
    reasoning: model.reasoningLevels.length > 0,
    thinkingLevelMap: thinkingLevelMap(model.reasoningLevels),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    compat: { supportsDeveloperRole: false, sessionAffinityFormat: 'openrouter' },
  };
}

async function fetchModels(base: URL, token: string, signal: AbortSignal): Promise<ProviderModelConfig[]> {
  const response = await fetch(`${base.origin}/v1/models`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': DISCOVERY_USER_AGENT },
    signal: withTimeout(signal, MODEL_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`x-adapter model discovery returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error('x-adapter Codex model discovery response does not contain a models array');
  }
  const models = payload.models.map(parseModel).filter((model): model is DiscoveredModel => model !== undefined);
  if (!models.length) {
    throw new Error('x-adapter model discovery returned no models');
  }
  return [...new Map(models.map((model) => [model.slug, toProviderModel(model)])).values()];
}

async function discoverModels(base: URL, token: string, signal: AbortSignal): Promise<ProviderModelConfig[]> {
  await ensureXAdapter(base, signal);
  const discoverySignal = withTimeout(signal, DISCOVERY_TIMEOUT_MS);
  let lastError: unknown;
  for (let attempt = 0; attempt < DISCOVERY_POLL_ATTEMPTS; attempt += 1) {
    try {
      return await fetchModels(base, token, discoverySignal);
    } catch (error) {
      discoverySignal.throwIfAborted();
      lastError = error;
      await sleep(HEALTH_POLL_INTERVAL_MS, discoverySignal);
    }
  }
  throw new Error(`x-adapter model discovery did not become ready: ${errorMessage(lastError)}`);
}

export default async function xAdapterPiExtension(pi: ExtensionAPI): Promise<void> {
  const base = baseUrl();
  const token = apiKey();
  registerXAdapterCommand(pi);
  let currentModels: ProviderModelConfig[] = [];
  if (!offlineModeEnabled()) {
    try {
      currentModels = await discoverModels(base, token, new AbortController().signal);
    } catch (error) {
      console.warn(`[x-adapter] ${errorMessage(error)}`);
    }
  }

  pi.registerProvider(providerId(), {
    name: 'x-adapter',
    baseUrl: `${base.origin}/v1`,
    apiKey: token,
    api: 'openai-responses',
    headers: { 'User-Agent': DISCOVERY_USER_AGENT },
    models: currentModels,
    async refreshModels({ allowNetwork, signal }) {
      if (!allowNetwork) {
        return currentModels;
      }
      try {
        currentModels = await discoverModels(base, token, signal);
      } catch (error) {
        console.warn(`[x-adapter] Model refresh failed: ${errorMessage(error)}`);
      }
      return currentModels;
    },
  });
}

export const __testHooks = {
  setCommandRunner(runner: CommandRunner | null): void {
    commandRunner = runner ?? defaultCommandRunner;
  },
};
