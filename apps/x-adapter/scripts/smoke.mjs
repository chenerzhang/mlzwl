#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(root, 'dist', 'bin', 'index.js');
const baseUrl = (process.env.X_ADAPTER_BASE_URL || 'http://127.0.0.1:10010').replace(/\/$/, '');
const timeoutMs = Number(process.env.X_ADAPTER_SMOKE_TIMEOUT_MS || 120000);
let startedBySmoke = false;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`x-adapter ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
      }
    });
  });
}

async function daemonRunning() {
  try {
    const { stdout } = await runCli(['status']);
    return json(stdout).running === true;
  } catch {
    return false;
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  return { status: response.status, text: await response.text() };
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Expected JSON response: ${text.slice(0, 300)}`, { cause: error });
  }
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

let passed = false;
try {
  const alreadyRunning = await daemonRunning();
  if (!alreadyRunning) {
    await runCli(['start']);
    startedBySmoke = true;
  }

  const results = [];
  results.push(
    await check('health', async () => {
      const response = await request('/health');
      assert(response.status === 200, `HTTP ${response.status}: ${response.text}`);
      const body = json(response.text);
      assert(body.ok === true, 'health.ok must be true');
      assert(body.name === 'x-adapter', 'health.name must be x-adapter');
    }),
  );

  results.push(
    await check('providers', async () => {
      const response = await request('/v1/providers');
      assert(response.status === 200, `HTTP ${response.status}: ${response.text}`);
      const body = json(response.text);
      assert(Array.isArray(body.data) && body.data.length === 2, 'providers must report both adapters');
    }),
  );

  results.push(
    await check('models-codex', async () => {
      const response = await request('/v1/models', { headers: { 'user-agent': 'codex-cli' } });
      assert(response.status === 200, `HTTP ${response.status}: ${response.text}`);
      const body = json(response.text);
      assert(Array.isArray(body.models), 'Codex discovery must return a model list');
      assert(
        body.models.every((model) => /^(?:trae-(?:global|cn)-|doubao-work-)/.test(model.slug)),
        'visible model IDs must use an explicit Trae realm or Doubao Work prefix',
      );
      for (const model of body.models) {
        if (model.model_load !== null && model.model_load !== undefined) {
          assert(model.model_load_percent === model.model_load, 'model_load_percent must preserve model_load');
        }
      }

      // Visibility is a model-list preference, not a provider availability or
      // routing gate. Use --all so hiding every provider cannot break smoke.
      const all = json((await runCli(['models', '--json', '--all'])).stdout);
      assert(
        Array.isArray(all.models) && all.models.length > 0,
        'at least one provider model must remain discoverable',
      );
      assert(
        all.models.every((model) => /^(?:trae-(?:global|cn)-|doubao-work-)/.test(model.id)),
        'all model IDs must use an explicit Trae realm or Doubao Work prefix',
      );
    }),
  );

  passed = results.every(Boolean);
  console.log(`\n${passed ? 'PASS' : 'FAIL'} smoke summary: ${results.filter(Boolean).length}/${results.length}`);
} catch (error) {
  console.error(`FAIL smoke setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (startedBySmoke) {
    try {
      await runCli(['stop']);
    } catch (error) {
      console.error(`FAIL daemon cleanup: ${error instanceof Error ? error.message : String(error)}`);
      passed = false;
    }
  }
}
process.exitCode = passed ? 0 : 2;
