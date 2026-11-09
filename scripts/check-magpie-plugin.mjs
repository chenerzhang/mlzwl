#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dist = path.join(root, 'dist');
let importSequence = 0;

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assertOpenCodeRoute();
assertPublishArtifacts();
await withIsolatedEnvironment(async (sandbox) => {
  await assertPluginShape();
  await assertGatewayBehavior();
  await assertModelProjection();
  await assertStartTimeout(sandbox);
});
console.log('Magpie plugin contracts and isolated behavior checks passed.');

/**
 * magpie reads `exports["./server"]`, then `main`, then `exports["."]`, and
 * switches to pi's loader when the manifest carries a pi marker. Keep the
 * OpenCode route explicit here as well, so a publish fails before magpie
 * silently ignores the entry.
 */
function assertOpenCodeRoute() {
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
  const piDependency = Object.keys(deps).some(
    (name) => name === '@earendil-works/pi-coding-agent' || name === '@mariozechner/pi-coding-agent',
  );
  if (manifest.pi !== undefined || piDependency || (manifest.keywords ?? []).includes('pi-package')) {
    throw new Error('package.json must not carry a pi marker; magpie would load it as a pi extension.');
  }
  const exportsEntry = manifest.exports?.['.'];
  const main = typeof exportsEntry === 'string' ? exportsEntry : exportsEntry?.import;
  if (manifest.main !== './dist/index.js' || main !== './dist/index.js') {
    throw new Error(`Expected main and exports["."] to point at ./dist/index.js; found ${manifest.main} and ${main}.`);
  }
  const files = manifest.files ?? [];
  for (const entry of ['dist', 'docs', 'README.md', 'LICENSE']) {
    if (!files.includes(entry)) {
      throw new Error(`Expected files to include ${entry}; found ${files.join(', ')}.`);
    }
  }
  if (manifest.scripts?.prepack !== 'pnpm build') {
    throw new Error(`Expected prepack to build a fresh bundle; found ${manifest.scripts?.prepack}.`);
  }
  if (
    manifest.publishConfig?.registry !== 'https://registry.npmjs.org' ||
    manifest.publishConfig?.access !== 'public'
  ) {
    throw new Error('Expected a public npm publishConfig for @mlzwl/magpie-x-adapter.');
  }
}

function assertPublishArtifacts() {
  const entries = fs
    .readdirSync(dist, { recursive: true })
    .filter((entry) => typeof entry === 'string')
    .sort();
  const expected = ['index.js'];
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw new Error(`Expected dist to contain only ${expected.join(', ')}; found ${entries.join(', ')}.`);
  }
  if (fs.statSync(path.join(dist, 'index.js')).size === 0) {
    throw new Error('Expected a non-empty bundled plugin entry.');
  }
}

/**
 * magpie treats every exported function as a plugin, so the entry must export
 * exactly the plugin factory and nothing else that could be called as one.
 */
async function assertPluginShape() {
  const module = await import(pathToFileURL(path.join(dist, 'index.js')).href);
  const functions = Object.entries(module).filter(([, value]) => typeof value === 'function');
  const names = functions.map(([name]) => name).sort();
  if (JSON.stringify(names) !== JSON.stringify(['XAdapterPlugin'])) {
    throw new Error(`Expected the bundle to export only XAdapterPlugin; found ${names.join(', ') || 'none'}.`);
  }
  const hooks = await module.XAdapterPlugin();
  if (hooks?.auth?.provider !== 'x-adapter') {
    throw new Error(`Expected the auth hook to serve provider x-adapter; found ${hooks?.auth?.provider}.`);
  }
  if (typeof hooks.provider?.models !== 'function' || typeof hooks.auth?.loader !== 'function') {
    throw new Error('Expected provider.models and auth.loader hooks.');
  }
  if (typeof hooks.config !== 'function') {
    throw new Error('Expected a config hook.');
  }
}

async function withIsolatedEnvironment(run) {
  const temporaryRoot = path.resolve(root, '../../.tmp');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(temporaryRoot, 'magpie-plugin-check-'));
  const overrides = {
    HOME: path.join(sandbox, 'home'),
    XDG_CONFIG_HOME: path.join(sandbox, 'home/.config'),
    XDG_CACHE_HOME: path.join(sandbox, 'home/.cache'),
    X_ADAPTER_DATA_DIR: path.join(sandbox, 'data'),
    X_ADAPTER_RUNTIME_DIR: path.join(sandbox, 'runtime'),
    X_ADAPTER_BASE_URL: 'http://127.0.0.1:1',
    X_ADAPTER_PORT: '1',
    X_ADAPTER_CLIENT_TOKEN: undefined,
    PATH: process.env.PATH,
    MAGPIE_CHECK_MODE: undefined,
    MAGPIE_CHECK_SANDBOX: sandbox,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.mkdirSync(overrides.HOME, { recursive: true });
  try {
    return await run(sandbox);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

async function freshPlugin() {
  const entry = pathToFileURL(path.join(dist, 'index.js'));
  entry.searchParams.set('check', String(++importSequence));
  return (await import(entry.href)).XAdapterPlugin;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function assertGatewayBehavior() {
  const keyA = 'mock-account-a';
  const keyB = 'mock-account-b';
  const secret = 'FAKE_CHECK_SECRET';
  let mode = 'models';
  let modelRequests = 0;
  let targetHits = 0;
  const requests = [];
  const model = {
    slug: 'mock-model',
    display_name: 'Mock',
    model_load_percent: 0,
    context_window: 128000,
    max_output_tokens: 32000,
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    input_modalities: ['text', 'image'],
  };
  const target = http.createServer((_request, response) => {
    targetHits++;
    response.end();
  });
  const targetBase = await listen(target);
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    requests.push({ path: request.url, headers: request.headers });
    if (mode === 'health-redirect' || (mode === 'models-redirect' && request.url === '/v1/models')) {
      response.writeHead(302, { location: `${targetBase}/?token=${secret}` });
      response.end();
      return;
    }
    if (request.url === '/health') {
      response.end(
        JSON.stringify({
          ok: true,
          name: 'x-adapter',
          version: 'mock',
          host: '127.0.0.1',
          port: server.address().port,
        }),
      );
      return;
    }
    const token = request.headers.authorization;
    if (token !== `Bearer ${keyA}` && token !== `Bearer ${keyB}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: { message: secret } }));
      return;
    }
    if (request.url === '/v1/models') {
      modelRequests++;
      if (mode === 'unavailable' || mode === 'unknown-503') {
        response.statusCode = 503;
        response.end(
          JSON.stringify({ error: { code: mode === 'unavailable' ? 'all_providers_unavailable' : 'unknown' } }),
        );
      } else if (mode === 'upstream-500') {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { code: 'upstream_error' } }));
      } else if (mode === 'invalid-json') {
        response.end(secret);
      } else if (mode === 'malformed') {
        response.end(JSON.stringify({ data: [] }));
      } else {
        response.end(
          JSON.stringify({
            models:
              mode === 'empty'
                ? []
                : [{ ...model, display_name: token === `Bearer ${keyB}` ? 'Other account' : 'Mock' }],
          }),
        );
      }
      return;
    }
    response.end(JSON.stringify({ ok: true }));
  });
  let base;
  try {
    base = await listen(server);
    process.env.X_ADAPTER_BASE_URL = base;
    process.env.X_ADAPTER_PORT = String(server.address().port);
    const factory = await freshPlugin();
    const hooks = await factory();
    const rejected = await hooks.auth.methods[0].authorize();
    assert.equal(rejected.type, 'failed', 'A healthy gateway must not accept an invalid client token.');
    assert.match(rejected.error, /rejected the client token/);
    assert.ok(!rejected.error.includes(secret));

    const provider = { id: 'x-adapter', models: { old: { id: 'old' } } };
    const authA = { type: 'api', key: keyA };
    const authB = { type: 'api', key: keyB };
    assert.equal(await hooks.provider.models(provider), provider.models);
    const first = await hooks.provider.models(provider, { auth: authA });
    assert.equal(first['mock-model'].name, 'Mock');
    assert.deepEqual(first['mock-model'].limit, { context: 128000, output: 32000 });
    assert.deepEqual(Object.keys(first['mock-model'].variants), ['low', 'high']);
    assert.equal(first['mock-model'].capabilities.input.image, true);
    const count = modelRequests;
    await hooks.provider.models(provider, { auth: authA });
    assert.equal(modelRequests, count, 'The same account should reuse its catalogue.');
    const other = await hooks.provider.models(provider, { auth: authB });
    assert.equal(other['mock-model'].name, 'Other account');
    assert.equal(modelRequests, count + 1, 'A different account must not reuse the cached catalogue.');
    await assert.rejects(hooks.provider.models(provider, { auth: { key: 'invalid' } }), /HTTP 401/);

    const loader = await hooks.auth.loader(async () => authA);
    assert.equal(loader.apiKey, keyA);
    const chat = await loader.fetch(`${loader.baseURL}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': loader.apiKey },
      body: '{}',
    });
    assert.equal(chat.status, 200);
    assert.equal(requests.at(-1).headers.authorization, `Bearer ${keyA}`);
    assert.equal(requests.at(-1).headers['x-api-key'], undefined);
    assert.equal(
      (await loader.fetch(`${loader.baseURL}/messages`)).status,
      200,
      'Fetch fallback must use the saved account key too.',
    );

    const output = { headers: {} };
    await hooks['chat.headers']({ sessionID: 'mock-session' }, output);
    assert.equal(output.headers['x-session-id'], 'mock-session');

    // A cancelled request must stay an AbortError: cancellation is the caller's
    // decision, not a gateway fault.
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      () => loader.fetch(`${loader.baseURL}/messages`, { method: 'POST', body: '{}', signal: aborted.signal }),
      (error) => error.name === 'AbortError',
    );

    // A configured token is used byte for byte, as the daemon reads it.
    process.env.X_ADAPTER_CLIENT_TOKEN = `  ${keyA}  `;
    try {
      const padded = await (await freshPlugin())();
      const paddedAuth = await padded.auth.methods[0].authorize();
      assert.equal(paddedAuth.type, 'failed', 'A padded token must not be trimmed into a valid one.');
      assert.match(paddedAuth.error, /rejected the client token/);
    } finally {
      process.env.X_ADAPTER_CLIENT_TOKEN = keyA;
    }
    for (const url of [
      `${targetBase}/v1/messages?token=${secret}`,
      `${base}/outside?token=${secret}`,
      `${base.replace('://', `://user:${secret}@`)}/v1/messages`,
      `invalid-${secret}`,
    ]) {
      const denied = await loader.fetch(url);
      assert.equal(denied.status, 400);
      assert.ok(!(await denied.text()).includes(secret));
    }
    assert.equal(targetHits, 0);

    process.env.X_ADAPTER_CLIENT_TOKEN = keyA;
    for (const [scenario, succeeds] of [
      ['models', true],
      ['empty', true],
      ['unavailable', true],
      // The daemon checks the client token before routing, so an upstream 5xx or
      // a broken catalogue proves the token was accepted. Only 401/403 (and a
      // redirect this plugin refuses to follow) may fail a sign-in.
      ['unknown-503', true],
      ['upstream-500', true],
      ['malformed', true],
      ['invalid-json', true],
      ['models-redirect', false],
    ]) {
      mode = scenario;
      const current = await (await freshPlugin())();
      const result = await current.auth.methods[0].authorize();
      assert.equal(result.type, succeeds ? 'success' : 'failed', `Unexpected login result for ${scenario}.`);
      if (succeeds) {
        assert.equal(result.key, keyA);
      } else {
        assert.ok(!result.error.includes(secret));
      }
      if (scenario === 'empty') {
        assert.deepEqual(await current.provider.models(provider, { auth: authA }), {});
      }
      if (scenario === 'unavailable') {
        await assert.rejects(current.provider.models(provider, { auth: authA }), /HTTP 503/);
      }
      if (scenario === 'upstream-500') {
        await assert.rejects(current.provider.models(provider, { auth: authA }), /HTTP 500/);
      }
      if (scenario === 'invalid-json') {
        await assert.rejects(current.provider.models(provider, { auth: authA }), /invalid JSON/);
      }
      if (scenario === 'malformed') {
        await assert.rejects(current.provider.models(provider, { auth: authA }), /models array/);
      }
    }
    assert.equal(targetHits, 0, 'Model discovery must not follow redirects.');
    mode = 'health-redirect';
    const redirectHooks = await (await freshPlugin())();
    assert.equal((await redirectHooks.auth.methods[0].authorize()).type, 'failed');
    assert.equal(targetHits, 0, 'Health probes must not follow redirects.');

    // Reusing a module for a second factory must not share its first gateway's
    // model cache or silently retarget the existing factory after env changes.
    mode = 'models';
    const captured = await factory();
    await captured.provider.models(provider, { auth: authA });
    process.env.X_ADAPTER_BASE_URL = targetBase;
    const second = await factory();
    await assert.rejects(second.provider.models(provider, { auth: authA }), /healthy x-adapter/);
    const capturedLoader = await captured.auth.loader(async () => authA);
    assert.equal(capturedLoader.baseURL, `${base}/v1`);
    assert.equal((await captured.auth.methods[0].authorize()).type, 'success');

    for (const invalid of [
      `http://user:${secret}@127.0.0.1:1234/v1`,
      `http://user:${secret}@example.invalid/v1`,
      `http://example.invalid/v1?token=${secret}`,
      `${base}/custom?token=${secret}`,
      `invalid-${secret}`,
    ]) {
      process.env.X_ADAPTER_BASE_URL = invalid;
      await assert.rejects(factory(), (error) => !error.message.includes(secret));
    }
  } finally {
    await Promise.all([closeServer(server), closeServer(target)]);
  }
  console.log(
    'Checked saved credentials, protected login, cache isolation, catalogue mapping, redirects and safe URL errors.',
  );
}

/**
 * What the picker shows must survive both x-adapter releases.
 *
 * Two `supported_reasoning_levels` shapes reach this plugin and both are covered
 * here: the Codex dialect's `{ effort }` objects, and the bare string array an
 * older gateway emits when an upstream metadata key overwrote the dialect
 * field. A string array read as "no levels" silently removes the reasoning
 * picker.
 *
 * Display names carry a provider prefix because Trae and Doubao Work publish
 * their own upstream names. A gateway that predates the prefix fix sends the
 * bare name, so the plugin adds the prefix; a name that already carries it must
 * not get it twice.
 *
 * Every mock entry carries `model_load_percent`, so the "the picker name has no
 * model-load suffix" assertion tests a real payload field instead of passing
 * because the field is absent. `0` is included because it is a valid load.
 *
 * The mock listens on a loopback port this script owns, so it never touches a
 * developer's running gateway or data directory.
 */
async function assertModelProjection() {
  const payload = {
    models: [
      {
        slug: 'trae-global-deepseek-v4.1-flash',
        display_name: 'Global DeepSeek-V4.1-Flash',
        provider: 'trae',
        model_load_percent: 42.6,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
        input_modalities: ['text', 'image'],
      },
      {
        // An older gateway lets metadata win, so the levels arrive as strings.
        slug: 'doubao-work-pro',
        display_name: 'Doubao Work Pro',
        provider: 'doubao',
        model_load_percent: 0,
        supported_reasoning_levels: ['low', 'medium', 'high', 'max'],
        input_modalities: ['text'],
      },
      {
        // A gateway that already prefixes the name must not be prefixed twice.
        slug: 'trae-global-gpt-5.6-sol',
        display_name: 'Trae Global GPT-5.6-Sol',
        provider: 'trae',
        model_load_percent: 17.5,
        supported_reasoning_levels: [{ effort: 'high' }],
        input_modalities: ['text'],
      },
    ],
  };

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const body =
      pathname === '/health'
        ? {
            ok: true,
            name: 'x-adapter',
            version: 'test',
            host: '127.0.0.1',
            port: server.address().port,
          }
        : pathname === '/v1/models'
          ? payload
          : undefined;
    response.setHeader('content-type', 'application/json');
    if (!body) {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify(body));
  });

  const previousBaseUrl = process.env.X_ADAPTER_BASE_URL;
  const previousPort = process.env.X_ADAPTER_PORT;
  try {
    const base = await listen(server);
    process.env.X_ADAPTER_BASE_URL = base;
    process.env.X_ADAPTER_PORT = String(server.address().port);
    const hooks = await (await freshPlugin())();
    const models = await hooks.provider.models(
      { id: 'x-adapter', models: {} },
      { auth: { type: 'api', key: 'projection-check-token' } },
    );

    const byId = (id) => {
      const model = models[id];
      if (!model) {
        throw new Error(`Expected the mock catalogue to project ${id}; found ${Object.keys(models).join(', ')}.`);
      }
      return model;
    };

    const trae = byId('trae-global-deepseek-v4.1-flash');
    // The mock carries `model_load_percent`, so a suffix would show up here.
    assert.ok(!String(trae.name).includes('Model load'), 'The picker name must not carry a model-load suffix.');
    assert.equal(trae.name, 'Trae Global DeepSeek-V4.1-Flash');
    assert.equal(trae.reasoning, true);
    assert.deepEqual(Object.keys(trae.variants), ['low', 'high']);

    const doubao = byId('doubao-work-pro');
    assert.equal(doubao.name, 'Doubao Work Pro');
    assert.equal(doubao.reasoning, true);
    assert.deepEqual(Object.keys(doubao.variants), ['low', 'medium', 'high', 'max']);

    const prefixed = byId('trae-global-gpt-5.6-sol');
    assert.equal(prefixed.name, 'Trae Global GPT-5.6-Sol');
    assert.deepEqual(Object.keys(prefixed.variants), ['high']);
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.X_ADAPTER_BASE_URL;
    } else {
      process.env.X_ADAPTER_BASE_URL = previousBaseUrl;
    }
    if (previousPort === undefined) {
      delete process.env.X_ADAPTER_PORT;
    } else {
      process.env.X_ADAPTER_PORT = previousPort;
    }
    await closeServer(server);
  }
  console.log('Checked the Magpie model projection: provider prefix, both reasoning-level shapes and no name suffix.');
}

async function assertStartTimeout(sandbox) {
  // A fake CLI is the only executable on PATH. It never starts a real daemon.
  const bin = path.join(sandbox, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'x-adapter.cjs'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const sandbox = process.env.MAGPIE_CHECK_SANDBOX;
fs.appendFileSync(path.join(sandbox, 'commands'), process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'capabilities') {
  console.log(JSON.stringify({ noOrphanRecovery: true, startNoOrphanRecoveryFlag: true }));
} else if (process.env.MAGPIE_CHECK_MODE === 'fail') {
  console.log('FAKE_CLI_SECRET');
  console.error('FAKE_CLI_SECRET');
  process.exit(1);
} else {
  fs.writeFileSync(path.join(sandbox, 'pid'), String(process.pid));
  process.on('SIGTERM', () => {});
  console.error('FAKE_CLI_SECRET');
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o700 },
  );
  fs.symlinkSync('x-adapter.cjs', path.join(bin, 'x-adapter'));
  process.env.PATH = bin;
  const reserved = net.createServer();
  const base = await listen(reserved);
  await closeServer(reserved);
  process.env.X_ADAPTER_BASE_URL = base;
  process.env.X_ADAPTER_PORT = new URL(base).port;
  delete process.env.X_ADAPTER_CLIENT_TOKEN;
  process.env.MAGPIE_CHECK_MODE = 'hang';
  const hooks = await (await freshPlugin())();
  let guard;
  const originalNow = Date.now;
  try {
    const started = Date.now();
    const result = await Promise.race([
      hooks.auth.methods[0].authorize(),
      new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error('CLI timeout regression: login is still pending after 40s.')), 40000);
      }),
    ]);
    clearTimeout(guard);
    assert.equal(result.type, 'failed');
    assert.match(result.error, /start.*timed out after 30s/);
    assert.ok(Date.now() - started < 40000);
    assert.ok(!result.error.includes('FAKE_CLI_SECRET'));
    const pid = Number(fs.readFileSync(path.join(sandbox, 'pid'), 'utf8'));
    const exitDeadline = Date.now() + 2000;
    while (processRunning(pid) && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(processRunning(pid), false, 'The timed-out CLI must exit even if it ignores SIGTERM.');
    const commands = fs.readFileSync(path.join(sandbox, 'commands'), 'utf8');
    assert.match(commands, /start --no-orphan-recovery/);
    const cooled = await hooks.auth.methods[0].authorize();
    assert.equal(cooled.error, result.error);
    assert.equal(
      fs.readFileSync(path.join(sandbox, 'commands'), 'utf8'),
      commands,
      'Cooldown must not launch another CLI.',
    );

    // Advance only the parent clock, not the real child-process deadline.
    const afterCooldown = originalNow() + 61000;
    Date.now = () => afterCooldown;
    process.env.MAGPIE_CHECK_MODE = 'fail';
    const retried = await hooks.auth.methods[0].authorize();
    assert.match(retried.error, /exited with code 1/);
    assert.ok(!retried.error.includes('FAKE_CLI_SECRET'));
    assert.equal(
      fs.readFileSync(path.join(sandbox, 'commands'), 'utf8').split('start --no-orphan-recovery').length,
      3,
      'A finished timeout must release inflight so a retry can run.',
    );
  } finally {
    clearTimeout(guard);
    Date.now = originalNow;
    const pidFile = path.join(sandbox, 'pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (processRunning(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  }
  console.log('Checked the real 30s CLI timeout, child cleanup, cooldown, retry and CLI error redaction.');
}

function processRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
