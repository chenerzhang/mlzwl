#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const buildScript = path.resolve(root, '../../scripts/build-package.mjs');
const testFiles = fs
  .readdirSync(path.join(root, 'test'))
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => path.join('test', file));

let failure;
try {
  run(process.execPath, [buildScript, '--test']);
  run(process.execPath, ['--test', '--test-concurrency=1', ...testFiles]);
} catch (error) {
  failure = error;
}

try {
  run(process.execPath, [buildScript]);
  await verifyPublishArtifacts();
} catch (error) {
  failure ??= error;
}

if (failure) {
  throw failure;
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

async function verifyPublishArtifacts() {
  const dist = path.join(root, 'dist');
  const files = fs
    .readdirSync(dist, { recursive: true })
    .filter((file) => typeof file === 'string')
    .sort();
  const expected = ['bin', 'bin/index.js', 'pi', 'pi/index.js'];
  if (JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`Expected publish dist to contain only ${expected.join(', ')}; found ${files.join(', ')}`);
  }
  const bin = path.join(dist, 'bin', 'index.js');
  if (!fs.readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')) {
    throw new Error('Expected bundled CLI to retain a Node shebang.');
  }
  run(process.execPath, [bin, 'version']);
  const extension = await import(pathToFileURL(path.join(dist, 'pi', 'index.js')).href);
  if (typeof extension.default !== 'function') {
    throw new Error('Expected bundled Pi extension default export.');
  }
}
