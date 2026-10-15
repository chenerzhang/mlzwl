#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { VERSION } from '../config/env.js';
import { isControlSocketReachable, requestControl, startControlServer } from '../daemon/control-socket.js';
import { getDaemonStatus, startDaemon, stopDaemon } from '../daemon/lifecycle.js';
import { isXAdapterDaemonProcess } from '../daemon/process.js';
import { log, redactSensitiveText } from '../logging/jsonl.js';
import { acquireDaemonLock, isProcessRunning, readLockPid } from '../daemon/lock.js';
import { startHttpServer } from '../daemon/server.js';
import { getRuntimePaths } from '../daemon/runtime-paths.js';
import {
  annotateModelVisibility,
  filterVisibleModels,
  promptHiddenModels,
  promptHiddenProviders,
} from '../models/visibility.js';
import { ModelRegistry } from '../models/registry.js';
import { clearProviderModelCaches, createProviderAdapters } from '../providers/adapters.js';
import { readDoubaoCredential } from '../providers/doubao/auth/doubao-cookie.js';
import { runDoubaoBrowserLogin } from '../providers/doubao/auth/login.js';
import { importTraeOfficialCredential } from '../providers/trae/auth/native-import.js';
import { refreshTraeCredential, runTraeLogin } from '../providers/trae/auth/oauth.js';
import { TRAE_REALMS, TraeRealm } from '../providers/trae/config/realm.js';
import {
  defaultServiceKind,
  serviceInstallInstructions,
  uninstallService,
  writeServiceTemplate,
} from '../service/install.js';
import { runUpdate } from '../tools/update.js';

function printHelp(): void {
  console.log(
    [
      'Usage:',
      '  x-adapter start [--port <port>]',
      '  x-adapter status',
      '  x-adapter stop',
      '  x-adapter models [--json] [--all]',
      '  x-adapter models refresh',
      '  x-adapter models hide',
      '  x-adapter provider hide',
      '  x-adapter <trae|doubao> models [--json] [--all]',
      '  x-adapter trae login --realm <global|cn>',
      '  x-adapter trae import --realm <global|cn> [--storage <path>] [--force]',
      '  x-adapter trae refresh --realm <global|cn>',
      '  x-adapter doubao login [--chrome <path>] [--timeout-ms <ms>] [--no-save] [--verbose]',
      '  x-adapter doubao refresh',
      '  x-adapter update',
      '  x-adapter install-service [--output <path>]',
      '  x-adapter uninstall-service [--path <path>]',
      '  x-adapter version',
    ].join('\n'),
  );
}

const ORPHAN_LOCK_READY_GRACE_MS = 750;
const ORPHAN_LOCK_TERMINATION_GRACE_MS = 750;

async function runDaemon(): Promise<void> {
  const lock = await acquireDaemonLockWithRecovery();
  const http = startHttpServer();
  log('info', 'x-adapter daemon started', { pid: process.pid, host: http.host, port: http.port });
  let shuttingDown = false;
  const control = startControlServer(async (request) => {
    if (request.command === 'daemon.status') {
      const registry = new ModelRegistry(createProviderAdapters());
      const catalog = await registry.discover();
      return {
        version: VERSION,
        pid: process.pid,
        host: http.host,
        port: http.port,
        url: `http://${http.host}:${http.port}`,
        ...getRuntimePaths(),
        providers: catalog.providerStatuses,
      };
    }
    if (request.command === 'daemon.shutdown') {
      // Defer until the control response has been queued. `shutdown` closes
      // this server too, and callers need the accepted response to identify
      // and wait for this exact daemon process.
      setImmediate(() => shutdown('control'));
      return { accepted: true, pid: process.pid };
    }
    if (request.command === 'providers.refresh') {
      clearProviderModelCaches();
      const catalog = await new ModelRegistry(createProviderAdapters()).discover();
      return { refreshed: true, providers: catalog.providerStatuses };
    }
    const error = new Error(`unknown control command: ${String(request.command)}`);
    (error as NodeJS.ErrnoException).code = 'unknown_command';
    throw error;
  });
  const shutdown = (signal: 'control' | 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    control.close();
    http.server.close(() => {
      log('info', 'x-adapter daemon stopped', { pid: process.pid, signal });
      lock.release();
      process.exit(0);
    });
    // A local update/stop must not leave the old daemon holding its lock while
    // an incomplete request or SSE stream prevents server.close() from firing.
    // The daemon is stateless at this boundary, so active data-plane requests
    // are deliberately interrupted before the replacement daemon starts.
    closeHttpConnections(http.server);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function closeHttpConnections(server: unknown): void {
  // `serve()` is typed as an HTTP/1-or-HTTP/2 union, but this daemon invokes
  // the HTTP/1 path. Keep the optional methods behind one narrow runtime
  // boundary so Node versions without either method still shut down normally.
  const closeable = server as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
  closeable.closeIdleConnections?.();
  closeable.closeAllConnections?.();
}

async function acquireDaemonLockWithRecovery() {
  try {
    return acquireDaemonLock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'daemon_lock_held') {
      throw error;
    }
    const paths = getRuntimePaths();
    const ownerPid = readLockPid(paths.lockPath);
    if (
      !ownerPid ||
      !isProcessRunning(ownerPid) ||
      (await waitForControlSocket(ownerPid, ORPHAN_LOCK_READY_GRACE_MS)) ||
      !(await isXAdapterDaemonProcess(ownerPid))
    ) {
      throw error;
    }

    // The lock lives in x-adapter's owner-only runtime directory. A verified
    // x-adapter daemon with no control socket after the grace period is an
    // orphan (for example, an older release stuck behind an incomplete HTTP/
    // SSE request). Recover only that verified daemon so a new release can
    // complete an update without risking an unrelated local process.
    process.kill(ownerPid, 'SIGTERM');
    if (!(await waitForProcessExit(ownerPid, ORPHAN_LOCK_TERMINATION_GRACE_MS))) {
      process.kill(ownerPid, 'SIGKILL');
      await waitForProcessExit(ownerPid, ORPHAN_LOCK_TERMINATION_GRACE_MS);
    }
    return acquireDaemonLock();
  }
}

async function waitForControlSocket(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return false;
    }
    if (await isControlSocketReachable(150)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessRunning(pid);
}

async function runProviderLogin(provider: 'trae' | 'doubao', args: string[]): Promise<void> {
  if (provider === 'doubao') {
    const chromeIndex = args.indexOf('--chrome');
    const timeoutIndex = args.indexOf('--timeout-ms');
    const result = await runDoubaoBrowserLogin({
      chrome: chromeIndex >= 0 ? args[chromeIndex + 1] : undefined,
      timeoutMs: timeoutIndex >= 0 && args[timeoutIndex + 1] ? Number(args[timeoutIndex + 1]) : undefined,
      noSave: args.includes('--no-save'),
      verbose: args.includes('--verbose'),
    });
    console.log(JSON.stringify({ provider, login: 'completed', ...result }, null, 2));
    return;
  }
  const realm = await requestedTraeRealm(args);
  await runTraeLogin(realm, { onEvent: renderTraeAuthEvent });
  console.log(JSON.stringify({ login: 'completed', provider, realm }, null, 2));
}

async function importTraeCredential(args: string[]): Promise<void> {
  const realm = await requestedTraeRealm(args);
  const storageIndex = args.indexOf('--storage');
  if (storageIndex >= 0 && !args[storageIndex + 1]) {
    const error = new Error('Trae import --storage requires a file path.');
    (error as NodeJS.ErrnoException).code = 'missing_trae_storage_path';
    throw error;
  }
  const imported = importTraeOfficialCredential(realm, {
    storagePath: storageIndex >= 0 ? args[storageIndex + 1] : undefined,
    force: args.includes('--force'),
  });
  console.log(
    JSON.stringify(
      {
        imported: true,
        provider: 'trae',
        realm,
        region: imported.region,
        source: 'official-client',
        expires_at: imported.credential.auth.expiresAt,
      },
      null,
      2,
    ),
  );
}

async function refreshProvider(provider: 'trae' | 'doubao', args: string[]): Promise<void> {
  if (provider === 'trae') {
    const realm = await requestedTraeRealm(args);
    const credential = await refreshTraeCredential(realm);
    console.log(JSON.stringify({ refreshed: true, provider, realm, expires_at: credential.auth.expiresAt }, null, 2));
    return;
  }
  const credential = readDoubaoCredential();
  if (!credential) {
    throw new Error('Doubao Work credentials are unavailable. Run `x-adapter doubao login`.');
  }
  console.log(
    JSON.stringify(
      { refreshed: true, provider, credential: { present: true, source: credential.source, ...credential.summary } },
      null,
      2,
    ),
  );
}

async function requestedTraeRealm(args: string[]): Promise<TraeRealm> {
  const index = args.indexOf('--realm');
  const configured = index >= 0 ? args[index + 1] : undefined;
  if (configured && (TRAE_REALMS as readonly string[]).includes(configured)) {
    return configured as TraeRealm;
  }
  if (configured || !process.stdin.isTTY || !process.stderr.isTTY) {
    const error = new Error('Trae commands require `--realm global` or `--realm cn`.');
    (error as NodeJS.ErrnoException).code = 'missing_trae_realm';
    throw error;
  }
  const { select } = await import('@inquirer/prompts');
  return select({
    message: 'Select the Trae account realm',
    choices: [
      { name: 'Trae Global (trae.ai)', value: 'global' },
      { name: 'Trae CN (trae.cn)', value: 'cn' },
    ],
  }) as Promise<TraeRealm>;
}

async function renderTraeAuthEvent(event: { type: string; realm: TraeRealm; open?: () => void }): Promise<void> {
  if (event.type === 'auth.login.url') {
    event.open?.();
    process.stderr.write(
      `Opened the Trae ${event.realm} authorization page in the default browser; the security-sensitive URL is not printed.\n`,
    );
  } else if (event.type === 'auth.login.waiting') {
    process.stderr.write(`Waiting for Trae ${event.realm} sign-in confirmation...\n`);
  } else if (event.type === 'auth.login.completed') {
    process.stderr.write(`Trae ${event.realm} sign-in completed.\n`);
  }
}

async function discoverModels(provider?: string) {
  const adapters = createProviderAdapters();
  const selected = provider ? adapters.filter((adapter) => adapter.id === provider) : adapters;
  if (!selected.length) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return new ModelRegistry(selected).discover();
}

async function refreshModels(provider?: string): Promise<void> {
  if (!provider) {
    try {
      console.log(JSON.stringify(await requestControl('providers.refresh', {}, 10_000), null, 2));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'daemon_unreachable') {
        throw error;
      }
    }
  }
  clearProviderModelCaches(provider as 'trae' | 'doubao' | undefined);
  const catalog = await discoverModels(provider);
  console.log(
    JSON.stringify(
      { refreshed: true, daemon: provider ? undefined : 'not_running', providers: catalog.providerStatuses },
      null,
      2,
    ),
  );
}

async function hideProviders(): Promise<void> {
  const providers = createProviderAdapters().map(({ id, displayName }) => ({ id, displayName }));
  const result = await promptHiddenProviders(providers);
  console.log(result.saved ? `Hidden providers saved: ${result.hidden.length}` : 'Cancelled.');
}

async function models(provider?: string): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('refresh')) {
    return refreshModels(provider);
  }
  const catalog = await discoverModels(provider);
  if (args.includes('hide')) {
    const result = await promptHiddenModels(catalog.models);
    console.log(result.saved ? `Hidden models saved: ${result.hidden.length}` : 'Cancelled.');
    return;
  }
  const output = args.includes('--all') ? annotateModelVisibility(catalog.models) : filterVisibleModels(catalog.models);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ models: output, providers: catalog.providerStatuses }, null, 2));
    return;
  }
  for (const model of output) {
    const load = typeof model.modelLoad === 'number' ? `\tload=${model.modelLoad}` : '';
    const hidden = 'hidden' in model && model.hidden ? '\thidden' : '';
    console.log(`${model.id}\t${model.displayName}${load}${hidden}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, subcommand] = args;
  if (command === '__daemon__') {
    return runDaemon();
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return printHelp();
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    return console.log(VERSION);
  }
  if (command === 'start') {
    const portIndex = args.indexOf('--port');
    if (portIndex >= 0) {
      const requestedPort = args[portIndex + 1];
      if (!requestedPort || !/^\d+$/.test(requestedPort)) {
        throw new Error('start --port requires an integer port.');
      }
      process.env.X_ADAPTER_PORT = requestedPort;
    }
    console.log(JSON.stringify(await startDaemon(fileURLToPath(import.meta.url)), null, 2));
    return;
  }
  if (command === 'status') {
    return console.log(JSON.stringify(await getDaemonStatus(), null, 2));
  }
  if (command === 'stop') {
    return console.log(JSON.stringify(await stopDaemon(), null, 2));
  }
  if (command === 'models') {
    return models();
  }
  if (command === 'provider' && subcommand === 'hide') {
    return hideProviders();
  }
  if (command === 'update') {
    // After a global install the currently executing bundle may belong to the
    // old package directory. Resolve the globally installed x-adapter bin so
    // a running daemon is restarted with the new version.
    const result = await runUpdate();
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'check_failed' || result.status === 'update_failed' || result.status === 'restart_failed') {
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'install-service') {
    const outputIndex = args.indexOf('--output');
    const target = writeServiceTemplate(
      defaultServiceKind(),
      fileURLToPath(import.meta.url),
      outputIndex >= 0 ? args[outputIndex + 1] : undefined,
    );
    const kind = defaultServiceKind();
    console.log(
      JSON.stringify({ ok: true, kind, path: target, next_steps: serviceInstallInstructions(kind, target) }, null, 2),
    );
    return;
  }
  if (command === 'uninstall-service') {
    const pathIndex = args.indexOf('--path');
    const outputIndex = args.indexOf('--output');
    const target = pathIndex >= 0 ? args[pathIndex + 1] : outputIndex >= 0 ? args[outputIndex + 1] : undefined;
    console.log(JSON.stringify(uninstallService(defaultServiceKind(), target), null, 2));
    return;
  }
  if (['trae', 'doubao'].includes(command) && subcommand === 'models') {
    return models(command);
  }
  if (['trae', 'doubao'].includes(command) && subcommand === 'login') {
    return runProviderLogin(command as 'trae' | 'doubao', args.slice(2));
  }
  if (command === 'trae' && subcommand === 'import') {
    return importTraeCredential(args.slice(2));
  }
  if (['trae', 'doubao'].includes(command) && subcommand === 'refresh') {
    return refreshProvider(command as 'trae' | 'doubao', args.slice(2));
  }
  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
