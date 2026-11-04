#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');

assertNotPiPackage();

fs.rmSync(dist, { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: [path.join('src', 'index.ts')],
  outfile: path.join(dist, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
});

/**
 * magpie loads a package through pi's loader as soon as its manifest carries a
 * pi marker, and then never reads `main`. This plugin must stay on the OpenCode
 * route, so the build refuses a manifest that would silently move it.
 */
function assertNotPiPackage() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
  const piDependency = Object.keys(deps).some(
    (name) => name === '@earendil-works/pi-coding-agent' || name === '@mariozechner/pi-coding-agent',
  );
  if (manifest.pi !== undefined || piDependency || (manifest.keywords ?? []).includes('pi-package')) {
    throw new Error(
      'magpie would load this package as a pi extension and ignore its OpenCode entry; ' +
        'remove the pi manifest field, the pi-package keyword and any pi-coding-agent dependency.',
    );
  }
}
