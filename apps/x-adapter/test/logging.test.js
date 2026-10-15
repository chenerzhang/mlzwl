import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function withLogEnvironment(fn) {
  const previous = {
    X_ADAPTER_LOG_FILE: process.env.X_ADAPTER_LOG_FILE,
    X_ADAPTER_LOG_RETENTION_DAYS: process.env.X_ADAPTER_LOG_RETENTION_DAYS,
    X_ADAPTER_LOG_MAX_FILE_BYTES: process.env.X_ADAPTER_LOG_MAX_FILE_BYTES,
    X_ADAPTER_LOG_MAX_TOTAL_BYTES: process.env.X_ADAPTER_LOG_MAX_TOTAL_BYTES,
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-logs-'));
  process.env.X_ADAPTER_LOG_FILE = path.join(directory, 'x-adapter.jsonl');
  try {
    return fn(directory);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('daily JSONL logs rotate by date and shard at the configured file size', async () => {
  const logging = await import('../dist/logging/jsonl.js');
  withLogEnvironment((directory) => {
    process.env.X_ADAPTER_LOG_MAX_FILE_BYTES = '1';
    const first = logging.logFile(new Date('2026-09-03T01:00:00.000Z'));
    fs.writeFileSync(first, 'x\n');
    const sharded = logging.logFile(new Date('2026-09-03T02:00:00.000Z'));
    const nextDay = logging.logFile(new Date('2026-09-04T01:00:00.000Z'));
    assert.equal(path.basename(first), 'x-adapter-2026-09-03.jsonl');
    assert.equal(path.basename(sharded), 'x-adapter-2026-09-03.1.jsonl');
    assert.equal(path.basename(nextDay), 'x-adapter-2026-09-04.jsonl');
    assert.equal(path.dirname(first), directory);
  });
});

test('pruning retains recent daily files and enforces an aggregate size budget', async () => {
  const logging = await import('../dist/logging/jsonl.js');
  withLogEnvironment((directory) => {
    process.env.X_ADAPTER_LOG_RETENTION_DAYS = '2';
    process.env.X_ADAPTER_LOG_MAX_TOTAL_BYTES = '6';
    const old = path.join(directory, 'x-adapter-2026-09-01.jsonl');
    const recent = path.join(directory, 'x-adapter-2026-09-02.jsonl');
    const active = path.join(directory, 'x-adapter-2026-09-03.jsonl');
    fs.writeFileSync(old, 'old');
    fs.writeFileSync(recent, 'recent');
    fs.writeFileSync(active, 'active');
    fs.utimesSync(recent, new Date('2026-09-02T01:00:00.000Z'), new Date('2026-09-02T01:00:00.000Z'));
    fs.utimesSync(active, new Date('2026-09-03T01:00:00.000Z'), new Date('2026-09-03T01:00:00.000Z'));
    logging.pruneLogFiles(new Date('2026-09-03T12:00:00.000Z'), active);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), false);
    assert.equal(fs.existsSync(active), true);
  });
});

test('logger redacts sensitive nested fields and token-looking error strings', async () => {
  const logging = await import('../dist/logging/jsonl.js');
  withLogEnvironment(() => {
    logging.log('error', 'request failed', {
      authorization: 'Bearer definitely-secret',
      nested: { cookie: 'session=definitely-secret' },
      error_message: 'upstream authorization=definitely-secret bearer very-secret-token',
    });
    const entry = JSON.parse(fs.readFileSync(logging.logFile(), 'utf8'));
    assert.equal(entry.authorization, '<redacted>');
    assert.equal(entry.nested.cookie, '<redacted>');
    assert.match(entry.error_message, /<redacted>/);
    assert.doesNotMatch(entry.error_message, /definitely-secret|very-secret-token/);
  });
});
