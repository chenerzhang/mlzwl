import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDaemonStatus, startDaemon, stopDaemon } from '../dist/daemon/lifecycle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'bin', 'index.js');

function testEnvironment() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-daemon-'));
  return {
    dataDir,
    port: String(20_000 + Math.floor(Math.random() * 10_000)),
  };
}

async function withDaemonEnvironment(run) {
  const environment = testEnvironment();
  const previous = { data: process.env.X_ADAPTER_DATA_DIR, port: process.env.X_ADAPTER_PORT };
  process.env.X_ADAPTER_DATA_DIR = environment.dataDir;
  process.env.X_ADAPTER_PORT = environment.port;
  try {
    return await run(environment);
  } finally {
    await stopDaemon(1_000).catch(() => undefined);
    if (previous.data === undefined) {
      delete process.env.X_ADAPTER_DATA_DIR;
    } else {
      process.env.X_ADAPTER_DATA_DIR = previous.data;
    }
    if (previous.port === undefined) {
      delete process.env.X_ADAPTER_PORT;
    } else {
      process.env.X_ADAPTER_PORT = previous.port;
    }
    fs.rmSync(environment.dataDir, { recursive: true, force: true });
  }
}

function waitForSocketClose(socket) {
  return new Promise((resolve) => socket.once('close', resolve));
}

test(
  'daemon lifecycle starts, reports isolated realm/provider status, and stops cleanly',
  { concurrency: false },
  async () => {
    await withDaemonEnvironment(async (environment) => {
      const previousMock = process.env.DOUBAO_MOCK;
      process.env.DOUBAO_MOCK = '1';
      try {
        const initial = await getDaemonStatus();
        assert.equal(initial.running, false);

        const started = await startDaemon(cli, root, 10_000);
        assert.equal(started.status, 'started');

        const status = await getDaemonStatus();
        assert.equal(status.running, true);
        assert.equal(status.healthy, true);
        assert.equal(status.daemon.port, Number(environment.port));
        const trae = status.daemon.providers.find((provider) => provider.provider === 'trae');
        const doubao = status.daemon.providers.find((provider) => provider.provider === 'doubao');
        assert.equal(trae.available, false);
        assert.deepEqual(
          trae.realms.map(({ realm, configured, available, modelCount, fromCache }) => ({
            realm,
            configured,
            available,
            modelCount,
            fromCache,
          })),
          [
            { realm: 'global', configured: false, available: false, modelCount: 0, fromCache: false },
            { realm: 'cn', configured: false, available: false, modelCount: 0, fromCache: false },
          ],
        );
        assert.equal(doubao.available, true);
        assert.ok(doubao.modelCount > 0);

        const stopped = await stopDaemon(10_000);
        assert.equal(stopped.status, 'stopped');
        assert.equal((await getDaemonStatus()).running, false);
      } finally {
        if (previousMock === undefined) {
          delete process.env.DOUBAO_MOCK;
        } else {
          process.env.DOUBAO_MOCK = previousMock;
        }
      }
    });
  },
);

test(
  'daemon stop closes incomplete data-plane connections before releasing the daemon lock',
  { concurrency: false },
  async () => {
    await withDaemonEnvironment(async (environment) => {
      await startDaemon(cli, root, 10_000);
      const request = net.createConnection({ host: '127.0.0.1', port: Number(environment.port) });
      await new Promise((resolve, reject) => {
        request.once('connect', resolve);
        request.once('error', reject);
      });
      request.write(
        `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${environment.port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
      );

      const closed = waitForSocketClose(request);
      const stopped = await stopDaemon(3_000);
      await closed;

      assert.equal(stopped.status, 'stopped');
      assert.equal((await getDaemonStatus()).running, false);
      assert.equal(fs.existsSync(path.join(environment.dataDir, 'runtime', 'x-adapter.lock')), false);
    });
  },
);

test(
  'daemon start reports a live orphaned lock owner instead of a generic control socket timeout',
  { concurrency: false },
  async () => {
    await withDaemonEnvironment(async (environment) => {
      const runtimeDir = path.join(environment.dataDir, 'runtime');
      fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(runtimeDir, 'x-adapter.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });

      await assert.rejects(
        () => startDaemon(cli, root, 3_000),
        (error) => error?.code === 'daemon_lock_held' && /still-running daemon pid/.test(error.message),
      );
      await assert.rejects(
        () => stopDaemon(1_000),
        (error) => error?.code === 'daemon_lock_owner_unverified',
      );
      // The synthetic lock belongs to this test process, so remove it before
      // shared lifecycle cleanup decides whether a real orphan needs stopping.
      fs.unlinkSync(path.join(runtimeDir, 'x-adapter.lock'));
    });
  },
);
