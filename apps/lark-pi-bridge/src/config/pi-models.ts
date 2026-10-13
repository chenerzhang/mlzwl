import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileMutationLock } from '../runtime/file-mutation.js';

export type CompatiblePiApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export type PiModelInput = 'text' | 'image';

export interface ConfigurePiModelInput {
  piAgentDir: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  api: CompatiblePiApi;
  input?: PiModelInput[];
  apiKeyFile?: string;
}

export interface PiModelConfigurationStatus {
  state: 'follow_pi_default' | 'explicit_profile_model' | 'not_configured' | 'invalid';
  scope: 'user' | 'profile';
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  api?: CompatiblePiApi;
  endpoint?: string;
  input?: PiModelInput[];
  credentialSource?: 'auth.json' | 'models.json' | 'none';
  message?: string;
}

interface ModelsFile {
  providers: Record<string, ProviderConfig>;
}
interface ProviderConfig {
  baseUrl: string;
  api: CompatiblePiApi;
  apiKey?: string;
  models: Array<{ id: string; name?: string; input?: PiModelInput[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

export async function configurePiModel(
  input: ConfigurePiModelInput,
  commitSelection?: () => Promise<void>,
): Promise<void> {
  const providerId = validIdentifier(input.providerId, 'provider ID');
  const modelId = validModelId(input.modelId);
  const endpoint = normalizeProviderUrl(input.baseUrl);
  if (!isCompatibleApi(input.api)) {
    throw new Error(`unsupported Pi compatible API: ${input.api}`);
  }
  const modelInput = input.input === undefined ? undefined : normalizeModelInput(input.input);
  const importedKey = input.apiKeyFile ? await readPrivateSecretFile(input.apiKeyFile) : undefined;
  await ensurePrivateDirectory(input.piAgentDir);

  await withFileMutationLock(join(input.piAgentDir, '.lark-pi-model-config'), async () => {
    const modelsPath = join(input.piAgentDir, 'models.json');
    const authPath = join(input.piAgentDir, 'auth.json');
    const current = await readModelsFile(modelsPath, true);
    const previous = current.providers[providerId];
    const previousModels = Array.isArray(previous?.models) ? previous.models : [];
    const existingModel = previousModels.find((model) => model.id === modelId);
    const auth = importedKey === undefined ? undefined : await readJsonObject(authPath, true);
    const previousWithoutModels: Record<string, unknown> = { ...previous };
    delete previousWithoutModels.models;
    current.providers[providerId] = {
      ...previousWithoutModels,
      baseUrl: endpoint,
      api: input.api,
      models: [
        ...previousModels.filter((model) => model.id !== modelId),
        modelInput === undefined
          ? (existingModel ?? { id: modelId })
          : { ...(existingModel ?? {}), id: modelId, input: modelInput },
      ],
    };
    if (auth && importedKey !== undefined) {
      auth[providerId] = { type: 'api_key', key: importedKey };
    }

    const snapshots = await Promise.all([snapshotFile(modelsPath), snapshotFile(authPath)]);
    try {
      await writePrivateJson(modelsPath, current);
      if (auth) {
        await writePrivateJson(authPath, auth);
      }
      await commitSelection?.();
    } catch (error) {
      await Promise.all([restoreFile(modelsPath, snapshots[0]), restoreFile(authPath, snapshots[1])]);
      throw error;
    }
  });
}

export async function inspectPiModelConfiguration(
  piAgentDir: string,
  selectedModel: string | undefined,
): Promise<PiModelConfigurationStatus> {
  if (!selectedModel?.trim()) {
    return { state: 'not_configured', scope: 'profile', message: 'profile preferences.model is not set' };
  }
  const parsed = parseSelectedModel(selectedModel);
  if (!parsed) {
    return { state: 'invalid', scope: 'profile', message: 'preferences.model must use provider/model' };
  }
  try {
    const models = await readModelsFile(join(piAgentDir, 'models.json'), false);
    const provider = models.providers[parsed.providerId];
    if (!provider) {
      return {
        state: 'not_configured',
        scope: 'profile',
        ...parsed,
        message: 'provider is absent from profile-local models.json',
      };
    }
    const endpoint = normalizeProviderUrl(provider.baseUrl);
    if (!isCompatibleApi(provider.api)) {
      return { state: 'invalid', scope: 'profile', ...parsed, message: 'provider API is unsupported' };
    }
    const model = provider.models.find((candidate) => candidate.id === parsed.modelId);
    if (!model) {
      return {
        state: 'not_configured',
        scope: 'profile',
        ...parsed,
        api: provider.api,
        endpoint,
        message: 'model is absent from provider',
      };
    }
    const input = model.input === undefined ? ['text' as const] : normalizeModelInput(model.input);
    const auth = await readJsonObject(join(piAgentDir, 'auth.json'), true);
    const credentialSource = isAuthEntry(auth[parsed.providerId])
      ? 'auth.json'
      : typeof provider.apiKey === 'string' && provider.apiKey.trim()
        ? 'models.json'
        : 'none';
    return {
      state: 'explicit_profile_model',
      scope: 'profile',
      ...parsed,
      api: provider.api,
      endpoint,
      input,
      credentialSource,
      ...(credentialSource === 'none' ? { message: 'no profile-local credential is configured' } : {}),
    };
  } catch (error) {
    return {
      state: 'invalid',
      scope: 'profile',
      ...parsed,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read only Pi's non-secret startup selection from the user configuration source. */
export async function inspectUserPiModelConfiguration(piConfigDir: string): Promise<PiModelConfigurationStatus> {
  try {
    const settings = await readJsonObject(join(piConfigDir, 'settings.json'), true);
    const providerId = optionalNonEmptyString(settings.defaultProvider);
    const modelId = optionalNonEmptyString(settings.defaultModel);
    const thinkingLevel = optionalNonEmptyString(settings.defaultThinkingLevel);
    if (!providerId && !modelId) {
      return { state: 'not_configured', scope: 'user', message: 'Pi default provider/model is automatic' };
    }
    if (!providerId || !modelId) {
      return {
        state: 'invalid',
        scope: 'user',
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
        message: 'Pi settings must define defaultProvider and defaultModel together',
      };
    }
    return {
      state: 'follow_pi_default',
      scope: 'user',
      providerId,
      modelId,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      message: 'new sessions follow the user Pi startup model',
    };
  } catch (error) {
    return {
      state: 'invalid',
      scope: 'user',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Validate any present profile-local model/auth files, even when no model is selected. */
export async function validatePiModelFiles(piAgentDir: string): Promise<void> {
  await Promise.all([
    readModelsFile(join(piAgentDir, 'models.json'), true),
    readJsonObject(join(piAgentDir, 'auth.json'), true),
  ]);
}

export function normalizeModelInput(value: readonly string[]): PiModelInput[] {
  const unique = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (!unique.length || unique[0] !== 'text' || unique.some((item) => item !== 'text' && item !== 'image')) {
    throw new Error('model input must be text or text,image');
  }
  return unique as PiModelInput[];
}

export function parseSelectedModel(value: string): { providerId: string; modelId: string } | undefined {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return undefined;
  }
  const providerId = value.slice(0, slash);
  const withThinking = value.slice(slash + 1);
  const modelId = withThinking.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, '');
  try {
    return { providerId: validIdentifier(providerId, 'provider ID'), modelId: validModelId(modelId) };
  } catch {
    return undefined;
  }
}

export function normalizeProviderUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('provider base URL is invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('provider base URL cannot contain credentials or query data');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('provider base URL must use HTTPS, except for an HTTP loopback endpoint');
  }
  return url.toString().replace(/\/$/, '');
}

async function readModelsFile(path: string, allowMissing: boolean): Promise<ModelsFile> {
  const raw = await readJsonObject(path, allowMissing);
  if (Object.keys(raw).length === 0 && allowMissing) {
    return { providers: {} };
  }
  if (!raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
    throw new Error('profile-local models.json must contain a providers object');
  }
  return raw as unknown as ModelsFile;
}

async function readJsonObject(path: string, allowMissing: boolean): Promise<Record<string, unknown>> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${path} must be a regular file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${path} changed while opening`);
    }
    const raw = JSON.parse(await handle.readFile('utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    return raw as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

async function readPrivateSecretFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('provider API key path must be a regular file');
  }
  if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) {
    throw new Error('provider API key file must not be accessible by group/others');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('provider API key file changed while opening');
    }
    const value = (await handle.readFile('utf8')).trim();
    if (!value) {
      throw new Error('provider API key file is empty');
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

interface FileSnapshot {
  content?: Buffer;
  mode?: number;
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
    return { content: await readFile(path), mode: metadata.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function restoreFile(path: string, snapshot: FileSnapshot): Promise<void> {
  if (snapshot.content === undefined) {
    await rm(path, { force: true });
    return;
  }
  await ensurePrivateDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.rollback`;
  try {
    await writeFile(temp, snapshot.content, { mode: 0o600, flag: 'wx' });
    await chmod(temp, process.platform === 'win32' ? 0o600 : (snapshot.mode ?? 0o600));
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a directory, not a symlink`);
  }
  if (process.platform !== 'win32') {
    await chmod(path, 0o700);
  }
}

function isCompatibleApi(value: unknown): value is CompatiblePiApi {
  return value === 'openai-completions' || value === 'openai-responses' || value === 'anthropic-messages';
}

function validIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) {
    throw new Error(`invalid ${label}`);
  }
  return trimmed;
}

function validModelId(value: string): string {
  const trimmed = value.trim();
  const hasControlCharacter = [...trimmed].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 || codePoint === 127;
  });
  if (!trimmed || trimmed.length > 256 || hasControlCharacter) {
    throw new Error('invalid model ID');
  }
  return trimmed;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isAuthEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const raw = value as { type?: unknown; key?: unknown };
  return raw.type === 'api_key' && typeof raw.key === 'string' && raw.key.trim().length > 0;
}
