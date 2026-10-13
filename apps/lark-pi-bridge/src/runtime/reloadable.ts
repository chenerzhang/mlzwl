import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentAdapter } from '../agent/types.js';
import type { BridgeChannel } from '../bot/channel.js';
import type { AppPaths } from '../config/app-paths.js';
import { validatePiModelFiles } from '../config/pi-models.js';
import { inspectEffectivePiModelConfiguration, resolveEffectivePiPaths } from '../config/pi-paths.js';
import type { ProfileConfig } from '../config/profile-schema.js';
import { resolveAppSecret } from '../config/store.js';
import type { RuntimeControlStatus, RuntimeRefreshResult } from './control.js';

export interface ReloadableRuntimeOptions {
  profile: string;
  initialProfile: ProfileConfig;
  loadProfile(): Promise<ProfileConfig>;
  /** Supplies secret and effective Pi resource metadata to the refresh fingerprint. */
  loadRuntimeFingerprint?(profile: ProfileConfig): Promise<unknown>;
  createAgent(profile: ProfileConfig): AgentAdapter;
  startChannel(profile: ProfileConfig, agent: AgentAdapter): Promise<BridgeChannel>;
}

/** Owns one complete channel+agent generation and swaps it only at a safe idle boundary. */
export class ReloadableBridgeRuntime {
  private profile: ProfileConfig;
  private agent: AgentAdapter | undefined;
  private channel: BridgeChannel | undefined;
  private generation = 0;
  private refreshing = false;
  private runtimeFingerprint = '';
  private rejectFailure: (reason?: unknown) => void = () => {};
  private readonly failure = new Promise<never>((_resolve, reject) => {
    this.rejectFailure = reject;
  });

  constructor(private readonly options: ReloadableRuntimeOptions) {
    this.profile = options.initialProfile;
    void this.failure.catch(() => {});
  }

  async start(): Promise<void> {
    if (this.channel) {
      throw new Error('runtime 已启动');
    }
    const agent = this.options.createAgent(this.profile);
    const available = await agent.checkAvailability?.();
    if (available && !available.ok) {
      throw available.error ?? new Error('Pi binary 不可用');
    }
    try {
      this.runtimeFingerprint = await this.loadFingerprint(this.profile);
      this.channel = await this.options.startChannel(this.profile, agent);
      this.observeFailure(this.channel);
      this.agent = agent;
      this.generation = 1;
    } catch (error) {
      await agent.dispose?.().catch(() => {});
      throw error;
    }
  }

  status(): RuntimeControlStatus {
    const activity = this.channel?.activity() ?? { active: 0, starting: this.refreshing ? 1 : 0 };
    const health = this.channel?.health();
    const ready = health?.channel?.state === 'connected' && !health.failed;
    return {
      profile: this.options.profile,
      generation: this.generation,
      active: activity.active,
      starting: activity.starting,
      ready,
      health: health?.failed ? 'failed' : ready ? 'ready' : 'degraded',
      ...(health?.channel ? { channel: health.channel } : {}),
      ...(health?.lastInboundTime ? { lastInboundTime: health.lastInboundTime } : {}),
    };
  }

  /** Resolves only when the active channel reports an unrecoverable failure. */
  waitForFailure(): Promise<never> {
    if (!this.channel) {
      return Promise.reject(new Error('runtime 尚未启动'));
    }
    return this.failure;
  }

  async refresh(): Promise<RuntimeRefreshResult> {
    if (!this.channel) {
      throw new Error('runtime 尚未启动');
    }
    if (this.refreshing) {
      throw new Error('runtime refresh 已在进行中');
    }
    this.refreshing = true;
    const previousChannel = this.channel;
    const previousProfile = this.profile;
    const activity = previousChannel.quiesce();
    if (activity.active || activity.starting) {
      previousChannel.resume();
      this.refreshing = false;
      throw new Error(`runtime busy: active=${activity.active}, starting=${activity.starting}`);
    }
    try {
      const nextProfile = await this.options.loadProfile();
      const nextFingerprint = await this.loadFingerprint(nextProfile);
      const nextAgent = this.options.createAgent(nextProfile);
      const available = await nextAgent.checkAvailability?.();
      if (available && !available.ok) {
        previousChannel.resume();
        await nextAgent.dispose?.().catch(() => {});
        throw available.error ?? new Error('新配置的 Pi runtime 不可用');
      }
      if (nextFingerprint === this.runtimeFingerprint) {
        await nextAgent.dispose?.().catch(() => {});
        this.profile = nextProfile;
        previousChannel.resume();
        return { ...this.status(), refreshed: true, changed: false };
      }
      await previousChannel.disconnect();
      try {
        const nextChannel = await this.options.startChannel(nextProfile, nextAgent);
        this.profile = nextProfile;
        this.agent = nextAgent;
        this.channel = nextChannel;
        this.observeFailure(nextChannel);
        try {
          this.runtimeFingerprint = await this.loadFingerprint(nextProfile);
        } catch (error) {
          await nextChannel.disconnect().catch(() => {});
          throw error;
        }
        this.generation += 1;
        return { ...this.status(), refreshed: true, changed: true };
      } catch (error) {
        await nextAgent.dispose?.().catch(() => {});
        const rollbackAgent = this.options.createAgent(previousProfile);
        try {
          this.channel = await this.options.startChannel(previousProfile, rollbackAgent);
          this.observeFailure(this.channel);
          this.profile = previousProfile;
          this.agent = rollbackAgent;
          this.runtimeFingerprint = await this.loadFingerprint(previousProfile);
        } catch (rollbackError) {
          await rollbackAgent.dispose?.().catch(() => {});
          this.channel = undefined;
          this.agent = undefined;
          throw new AggregateError([error, rollbackError], '新配置启动失败且旧运行配置恢复失败', {
            cause: rollbackError,
          });
        }
        throw new Error('新配置启动失败，已恢复旧运行配置', { cause: error });
      }
    } catch (error) {
      if (this.channel === previousChannel) {
        previousChannel.resume();
      }
      throw error;
    } finally {
      this.refreshing = false;
    }
  }

  async stop(): Promise<void> {
    const channel = this.channel;
    this.channel = undefined;
    this.agent = undefined;
    if (channel) {
      await channel.disconnect();
    }
  }

  private observeFailure(channel: BridgeChannel): void {
    void channel.failure.catch((error) => {
      if (this.channel === channel) {
        this.rejectFailure(error);
      }
    });
  }

  private async loadFingerprint(profile: ProfileConfig): Promise<string> {
    return JSON.stringify({
      profile: runtimeProfileConfig(profile),
      external: await this.options.loadRuntimeFingerprint?.(profile),
    });
  }
}

function runtimeProfileConfig(profile: ProfileConfig): Omit<ProfileConfig, 'workspaces'> {
  const { workspaces: _perUseWorkspaces, ...runtime } = profile;
  return runtime;
}

/** Validate and fingerprint secret/effective Pi files without exposing their contents. */
export async function loadProfileRuntimeFingerprint(paths: AppPaths, profile: ProfileConfig): Promise<unknown> {
  const appSecret = await resolveAppSecret(profile.accounts.app, paths.configFile, paths.profileDir);
  const effective = resolveEffectivePiPaths(profile, paths);
  if (effective.scope === 'profile') {
    await validatePiModelFiles(effective.configDir);
  }
  await inspectEffectivePiModelConfiguration(profile, paths).then((status) => {
    if (status.state === 'invalid') {
      throw new Error(status.message ?? 'Pi model 配置无效');
    }
  });
  return {
    piConfigScope: effective.scope,
    configDirHash: secretHash(effective.configDir),
    appSecretHash: secretHash(appSecret),
    settingsHash: secretHash(await readOptionalPrivateFile(join(effective.configDir, 'settings.json'))),
    modelsHash: secretHash(await readOptionalPrivateFile(join(effective.configDir, 'models.json'))),
    authHash: secretHash(await readOptionalPrivateFile(join(effective.configDir, 'auth.json'))),
    resourcesHash: await boundedResourceMetadataHash(effective.configDir),
  };
}

function secretHash(value: string | null): string | null {
  return value === null ? null : createHash('sha256').update(value, 'utf8').digest('hex');
}

async function boundedResourceMetadataHash(configDir: string): Promise<string> {
  const resources = ['AGENTS.md', 'extensions', 'skills', 'prompts', 'packages'];
  const metadata: string[] = [];
  for (const resource of resources) {
    const path = join(configDir, resource);
    try {
      const info = await lstat(path);
      metadata.push(`${resource}:${info.isDirectory() ? 'd' : 'f'}:${info.size}:${Math.floor(info.mtimeMs)}`);
      if (info.isDirectory()) {
        const names = (await readdir(path)).sort().slice(0, 256);
        metadata.push(`${resource}:entries:${names.join('\u0000')}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      metadata.push(`${resource}:missing`);
    }
  }
  return createHash('sha256').update(metadata.join('\n'), 'utf8').digest('hex');
}

async function readOptionalPrivateFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
