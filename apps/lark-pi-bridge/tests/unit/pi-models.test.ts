import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  configurePiModel,
  inspectPiModelConfiguration,
  inspectUserPiModelConfiguration,
  normalizeProviderUrl,
  validatePiModelFiles,
} from '../../src/config/pi-models.js';

describe('profile-local Pi model configuration', () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('writes model and optional credential only inside the selected Pi agent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-model-config-'));
    paths.push(root);
    const piAgentDir = join(root, 'profile', 'pi-agent');
    const keyFile = join(root, 'input-key');
    await writeFile(keyFile, 'test-key-not-real\n', { mode: 0o600 });
    await configurePiModel({
      piAgentDir,
      providerId: 'local-provider',
      modelId: 'model-one',
      baseUrl: 'http://127.0.0.1:12345/v1/',
      api: 'openai-responses',
      input: ['text', 'image'],
      apiKeyFile: keyFile,
    });
    const models = JSON.parse(await readFile(join(piAgentDir, 'models.json'), 'utf8'));
    const auth = JSON.parse(await readFile(join(piAgentDir, 'auth.json'), 'utf8'));
    expect(models.providers['local-provider']).toMatchObject({
      baseUrl: 'http://127.0.0.1:12345/v1',
      api: 'openai-responses',
      models: [{ id: 'model-one', input: ['text', 'image'] }],
    });
    expect(auth['local-provider']).toEqual({ type: 'api_key', key: 'test-key-not-real' });
    expect(await inspectPiModelConfiguration(piAgentDir, 'local-provider/model-one:high')).toMatchObject({
      state: 'explicit_profile_model',
      credentialSource: 'auth.json',
      providerId: 'local-provider',
      modelId: 'model-one',
      input: ['text', 'image'],
    });
    if (process.platform !== 'win32') {
      expect((await stat(join(piAgentDir, 'models.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(piAgentDir, 'auth.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('rolls model and credential files back if selection commit fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-model-rollback-'));
    paths.push(root);
    const piAgentDir = join(root, 'pi-agent');
    const keyFile = join(root, 'input-key');
    await writeFile(keyFile, 'new-private-key\n', { mode: 0o600 });
    await configurePiModel({
      piAgentDir,
      providerId: 'existing',
      modelId: 'old-model',
      baseUrl: 'http://127.0.0.1:12345/v1',
      api: 'openai-responses',
    });
    const originalModels = await readFile(join(piAgentDir, 'models.json'), 'utf8');
    await expect(
      configurePiModel(
        {
          piAgentDir,
          providerId: 'next',
          modelId: 'new-model',
          baseUrl: 'https://example.com/v1',
          api: 'openai-completions',
          apiKeyFile: keyFile,
        },
        async () => {
          throw new Error('selection commit failed');
        },
      ),
    ).rejects.toThrow(/selection commit failed/);
    expect(await readFile(join(piAgentDir, 'models.json'), 'utf8')).toBe(originalModels);
    await expect(readFile(join(piAgentDir, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not expose a secret in models.json and rejects an over-broad key file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-model-key-'));
    paths.push(root);
    const keyFile = join(root, 'input-key');
    await writeFile(keyFile, 'private', { mode: 0o644 });
    if (process.platform !== 'win32') {
      await expect(
        configurePiModel({
          piAgentDir: join(root, 'pi-agent'),
          providerId: 'provider',
          modelId: 'model',
          baseUrl: 'https://example.com/v1',
          api: 'openai-completions',
          apiKeyFile: keyFile,
        }),
      ).rejects.toThrow(/group\/others/);
    }
    await chmod(keyFile, 0o600);
  });

  it('preserves existing input metadata and treats omitted input as text-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-model-input-'));
    paths.push(root);
    await configurePiModel({
      piAgentDir: root,
      providerId: 'provider',
      modelId: 'model',
      baseUrl: 'https://example.com/v1',
      api: 'openai-responses',
      input: ['text', 'image'],
    });
    await configurePiModel({
      piAgentDir: root,
      providerId: 'provider',
      modelId: 'model',
      baseUrl: 'https://example.com/v1',
      api: 'openai-responses',
    });
    expect(await inspectPiModelConfiguration(root, 'provider/model')).toMatchObject({ input: ['text', 'image'] });

    await writeFile(
      join(root, 'models.json'),
      JSON.stringify({
        providers: {
          provider: { baseUrl: 'https://example.com/v1', api: 'openai-responses', models: [{ id: 'model' }] },
        },
      }),
      { mode: 0o600 },
    );
    expect(await inspectPiModelConfiguration(root, 'provider/model')).toMatchObject({ input: ['text'] });
  });

  it('rejects invalid or image-only input declarations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-model-invalid-input-'));
    paths.push(root);
    await expect(
      configurePiModel({
        piAgentDir: root,
        providerId: 'provider',
        modelId: 'model',
        baseUrl: 'https://example.com/v1',
        api: 'openai-responses',
        input: ['image'],
      }),
    ).rejects.toThrow(/text or text,image/);
  });

  it('allows HTTP only for an explicit loopback endpoint', () => {
    expect(normalizeProviderUrl('http://localhost:10010/v1')).toBe('http://localhost:10010/v1');
    expect(() => normalizeProviderUrl('http://example.com/v1')).toThrow(/HTTPS/);
    expect(() => normalizeProviderUrl('https://user:secret@example.com/v1')).toThrow(/credentials/);
  });

  it('validates present model/auth files even when no model is selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-model-file-validation-'));
    paths.push(root);
    await writeFile(join(root, 'models.json'), '{bad json', { mode: 0o600 });
    await expect(validatePiModelFiles(root)).rejects.toThrow();
  });

  it('reads only non-secret user Pi startup defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-user-model-status-'));
    paths.push(root);
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'x-connect',
        defaultModel: 'trae-gpt-5.6-sol',
        defaultThinkingLevel: 'high',
        apiKey: 'must-not-be-returned',
      }),
      { mode: 0o644 },
    );
    expect(await inspectUserPiModelConfiguration(root)).toEqual({
      state: 'follow_pi_default',
      scope: 'user',
      providerId: 'x-connect',
      modelId: 'trae-gpt-5.6-sol',
      thinkingLevel: 'high',
      message: 'new sessions follow the user Pi startup model',
    });
  });

  it('reports configuration and credential state separately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-model-status-'));
    paths.push(root);
    expect(await inspectPiModelConfiguration(root, undefined)).toMatchObject({ state: 'not_configured' });
    await writeFile(join(root, 'models.json'), JSON.stringify({ providers: {} }), { mode: 0o600 });
    expect(await inspectPiModelConfiguration(root, 'missing/model')).toMatchObject({
      state: 'not_configured',
      providerId: 'missing',
    });
  });
});
