import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { AgentAdapter } from '../agent/types.js';
import type { AppPaths } from '../config/app-paths.js';
import type { PiModelConfigurationStatus } from '../config/pi-models.js';
import { inspectEffectivePiModelConfiguration } from '../config/pi-paths.js';
import type { ProfileConfig } from '../config/profile-schema.js';
import { resolveAppSecret } from '../config/store.js';
import { redactText } from '../core/logger.js';

export interface DoctorCheck {
  name: 'config' | 'app_secret' | 'pi_capability' | 'provider_reachability' | 'model_credentials';
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  profile: string;
  checks: DoctorCheck[];
  model: PiModelConfigurationStatus;
}

export interface DoctorOptions {
  checkProvider?: boolean;
  checkCredentials?: boolean;
  reachabilityTimeoutMs?: number;
  probeReachability?: (url: URL, timeoutMs: number) => Promise<void>;
  probeModel?: () => Promise<void>;
}

export async function runDoctor(
  paths: AppPaths,
  profile: ProfileConfig,
  agent: AgentAdapter,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [{ name: 'config', status: 'pass', detail: 'profile schema is valid' }];
  try {
    await resolveAppSecret(profile.accounts.app, paths.configFile, paths.profileDir);
    checks.push({ name: 'app_secret', status: 'pass', detail: 'profile-local App Secret is readable and private' });
  } catch (error) {
    checks.push({ name: 'app_secret', status: 'fail', detail: safeMessage(error) });
  }

  const availability = await agent.checkAvailability?.();
  if (availability?.ok) {
    checks.push({ name: 'pi_capability', status: 'pass', detail: `Pi ${availability.version ?? 'compatible'}` });
  } else {
    checks.push({
      name: 'pi_capability',
      status: 'fail',
      detail: safeMessage(availability?.error ?? 'Pi check unavailable'),
    });
  }

  const model = await inspectEffectivePiModelConfiguration(profile, paths);
  if (!options.checkProvider) {
    checks.push({
      name: 'provider_reachability',
      status: 'skipped',
      detail: 'not requested; no network connection was attempted',
    });
  } else if (model.scope === 'user' && !model.endpoint) {
    checks.push({
      name: 'provider_reachability',
      status: 'skipped',
      detail: 'user Pi provider endpoint is not exposed by the read-only startup selection',
    });
  } else if (model.state !== 'explicit_profile_model' || !model.endpoint) {
    checks.push({ name: 'provider_reachability', status: 'fail', detail: model.message ?? 'model is not configured' });
  } else {
    try {
      const probe = options.probeReachability ?? probeTcpEndpoint;
      await probe(new URL(model.endpoint), options.reachabilityTimeoutMs ?? 2_000);
      checks.push({ name: 'provider_reachability', status: 'pass', detail: 'TCP endpoint is reachable' });
    } catch (error) {
      checks.push({ name: 'provider_reachability', status: 'fail', detail: safeMessage(error) });
    }
  }

  if (!options.checkCredentials) {
    checks.push({
      name: 'model_credentials',
      status: 'skipped',
      detail: 'not requested; no model request was made',
    });
  } else if (model.state !== 'explicit_profile_model' && model.state !== 'follow_pi_default') {
    checks.push({ name: 'model_credentials', status: 'fail', detail: model.message ?? 'model is not configured' });
  } else if (!options.probeModel) {
    checks.push({
      name: 'model_credentials',
      status: 'fail',
      detail: 'real-model probe implementation is unavailable',
    });
  } else {
    try {
      await options.probeModel();
      checks.push({
        name: 'model_credentials',
        status: 'pass',
        detail: 'selected model completed an isolated live turn',
      });
    } catch (error) {
      checks.push({ name: 'model_credentials', status: 'fail', detail: safeMessage(error) });
    }
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    profile: paths.profile,
    checks,
    model,
  };
}

async function probeTcpEndpoint(url: URL, timeoutMs: number): Promise<void> {
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
  if (!isLoopback(host)) {
    const addresses = await lookup(host, { all: true });
    if (addresses.some((item) => isPrivateOrLocal(item.address))) {
      throw new Error(
        'provider hostname resolves to a private or local address; refusing ambiguous reachability probe',
      );
    }
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(
      () => socket.destroy(new Error(`provider TCP probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1';
}

function isPrivateOrLocal(address: string): boolean {
  return (
    isLoopback(address) ||
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    /^169\.254\./.test(address) ||
    /^f[cd][0-9a-f]{2}:/i.test(address) ||
    /^fe80:/i.test(address)
  );
}

function safeMessage(value: unknown): string {
  return redactText(value instanceof Error ? value.message : String(value));
}
