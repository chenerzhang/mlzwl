#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' })
  .split('\n')
  .map((file) => file.trim())
  .filter(Boolean);

if (staged.length === 0) {
  process.exit(0);
}

const prettierExtensions = /\.(?:js|cjs|mjs|ts|cts|mts|json|jsonc|ya?ml)$/i;
const eslintTargets = staged.filter((file) =>
  /^(apps\/[^/]+\/src|apps\/[^/]+\/test|scripts)\/.*\.[cm]?[jt]s$/.test(file),
);
const prettierTargets = staged.filter((file) => prettierExtensions.test(file));
const appNames = [
  ...new Set(
    staged.flatMap((file) => {
      const match = /^apps\/([^/]+)\//.exec(file);
      return match ? [match[1]] : [];
    }),
  ),
];

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

for (const appName of appNames) {
  run('pnpm', ['--filter', `./apps/${appName}`, 'typecheck']);
}

if (eslintTargets.length > 0) {
  run('pnpm', ['exec', 'eslint', ...eslintTargets]);
}

if (prettierTargets.length > 0) {
  run('pnpm', ['exec', 'prettier', '--write', ...prettierTargets]);
  run('git', ['add', '--', ...prettierTargets]);
}
