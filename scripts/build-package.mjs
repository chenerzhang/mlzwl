#!/usr/bin/env node

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const testBuild = process.argv.includes('--test');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

fs.rmSync(dist, { recursive: true, force: true });

if (testBuild) {
  execFileSync(pnpm, ['exec', 'tsc'], { stdio: 'inherit' });
} else {
  await Promise.all([
    buildBundle('bin/index.ts', path.join(dist, 'bin', 'index.js')),
    buildBundle('pi/index.ts', path.join(dist, 'pi', 'index.js')),
  ]);
}

const bin = path.join(dist, 'bin', 'index.js');
if (process.platform !== 'win32' && fs.existsSync(bin)) {
  fs.chmodSync(bin, 0o755);
}

async function buildBundle(entryPoint, outfile) {
  await build({
    absWorkingDir: root,
    entryPoints: [path.join('src', entryPoint)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    packages: 'external',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
  });
}
