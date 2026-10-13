import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/agent/types.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { resolveAppPaths } from '../../src/config/app-paths.js';
import { configurePiModel } from '../../src/config/pi-models.js';
import { createProfileConfig } from '../../src/config/profile-schema.js';
import { saveAppSecret } from '../../src/config/store.js';

describe('doctor diagnostics', () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('separates structural, capability, reachability and credential/model checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-doctor-'));
    paths.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'test' });
    await saveAppSecret(appPaths.appSecretFile, 'app-secret-not-real');
    await configurePiModel({
      piAgentDir: appPaths.profilePiAgentDir,
      providerId: 'provider',
      modelId: 'model',
      baseUrl: 'http://127.0.0.1:12345/v1',
      api: 'openai-responses',
    });
    const profile = createProfileConfig({
      app: { id: 'cli_test', secretFile: 'profiles/test/app-secret', tenant: 'feishu' },
      permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' },
      preferences: { piConfigScope: 'profile', model: 'provider/model' },
    });
    const agent: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi',
      async isAvailable() {
        return true;
      },
      async checkAvailability() {
        return { ok: true, version: '0.99.0' };
      },
      run() {
        throw new Error('not used');
      },
    };
    const reachability = vi.fn(async () => {});
    const modelProbe = vi.fn(async () => {});
    const report = await runDoctor(appPaths, profile, agent, {
      checkProvider: true,
      checkCredentials: true,
      probeReachability: reachability,
      probeModel: modelProbe,
    });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      expect.objectContaining({ name: 'config', status: 'pass' }),
      expect.objectContaining({ name: 'app_secret', status: 'pass' }),
      expect.objectContaining({ name: 'pi_capability', status: 'pass' }),
      expect.objectContaining({ name: 'provider_reachability', status: 'pass' }),
      expect.objectContaining({ name: 'model_credentials', status: 'pass' }),
    ]);
    expect(reachability).toHaveBeenCalledOnce();
    expect(modelProbe).toHaveBeenCalledOnce();
  });

  it('performs no provider or model request by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-doctor-offline-'));
    paths.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'test' });
    await saveAppSecret(appPaths.appSecretFile, 'app-secret-not-real');
    const profile = createProfileConfig({
      app: { id: 'cli_test', secretFile: 'profiles/test/app-secret', tenant: 'feishu' },
    });
    const agent: AgentAdapter = {
      id: 'pi',
      displayName: 'Pi',
      async isAvailable() {
        return true;
      },
      async checkAvailability() {
        return { ok: true, version: '0.99.0' };
      },
      run() {
        throw new Error('not used');
      },
    };
    const report = await runDoctor(appPaths, profile, agent);
    expect(report.checks.find((check) => check.name === 'provider_reachability')?.status).toBe('skipped');
    expect(report.checks.find((check) => check.name === 'model_credentials')?.status).toBe('skipped');
  });
});
