import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireDaemonLock, readLockPid } from '../dist/daemon/lock.js';

test('x-adapter daemon lock writes, rejects a live owner, and releases', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-lock-'));
  const lockPath = path.join(directory, 'daemon.lock');
  const lock = acquireDaemonLock(lockPath);
  try {
    assert.equal(readLockPid(lockPath), process.pid);
    assert.throws(() => acquireDaemonLock(lockPath), { code: 'daemon_lock_held' });
  } finally {
    lock.release();
  }
  assert.equal(fs.existsSync(lockPath), false);
});
