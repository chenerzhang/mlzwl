import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultServiceTarget,
  launchdPlist,
  serviceInstallInstructions,
  serviceUninstallInstructions,
  systemdUnit,
  uninstallService,
  writeServiceTemplate,
} from '../dist/service/install.js';

test('launchd service starts the unified daemon on the x-adapter default port', () => {
  const plist = launchdPlist({ scriptPath: '/tmp/x-adapter.js' });
  assert.match(plist, /ai\.x-adapter/);
  assert.match(plist, /__daemon__/);
  assert.match(plist, /X_ADAPTER_PORT/);
  assert.match(plist, /10100/);
});

test('systemd service has unified daemon command and restart policy', () => {
  const unit = systemdUnit({ scriptPath: '/tmp/x-adapter.js' });
  assert.match(unit, /Description=x-adapter local model gateway/);
  assert.match(unit, /ExecStart=.*__daemon__/);
  assert.match(unit, /Restart=on-failure/);
});

test('service template writes requested target with restricted mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-service-'));
  const target = path.join(directory, 'x-adapter.service');
  assert.equal(writeServiceTemplate('systemd', '/tmp/x-adapter.js', target), target);
  assert.match(fs.readFileSync(target, 'utf8'), /x-adapter local model gateway/);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('default targets are unique user-level x-adapter service locations', () => {
  assert.equal(
    defaultServiceTarget('launchd'),
    path.join(os.homedir(), 'Library', 'LaunchAgents', 'ai.x-adapter.plist'),
  );
  assert.equal(
    defaultServiceTarget('systemd'),
    path.join(os.homedir(), '.config', 'systemd', 'user', 'x-adapter.service'),
  );
});

test('service activation and removal instructions use the unified service names', () => {
  assert.ok(
    serviceInstallInstructions('launchd', '/tmp/ai.x-adapter.plist').some((line) => line.includes('launchctl load')),
  );
  assert.ok(
    serviceInstallInstructions('systemd', '/tmp/x-adapter.service').some((line) =>
      line.includes('enable --now x-adapter.service'),
    ),
  );
  assert.ok(
    serviceUninstallInstructions('launchd', '/tmp/ai.x-adapter.plist').some((line) =>
      line.includes('launchctl unload'),
    ),
  );
  assert.ok(
    serviceUninstallInstructions('systemd', '/tmp/x-adapter.service').some((line) =>
      line.includes('disable --now x-adapter.service'),
    ),
  );
});

test('uninstall deactivates and removes an existing systemd unit', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-service-'));
  const target = path.join(directory, 'x-adapter.service');
  fs.writeFileSync(target, 'service');
  const calls = [];
  const result = uninstallService('systemd', target, (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: '', stderr: '' };
  });
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(calls, [
    ['systemctl', ['--user', 'disable', '--now', 'x-adapter.service']],
    ['systemctl', ['--user', 'daemon-reload']],
  ]);
});
