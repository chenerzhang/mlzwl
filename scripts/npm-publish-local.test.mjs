import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { assertRegistryMatches, expectedDigests, extractReleaseNotes, parseEnv } from './npm-publish-local.mjs';

test('parseEnv parses a quoted npm token without exposing it', () => {
  const values = parseEnv("# local only\nNPM_TOKEN='npm_secret'\n");
  assert.equal(values.get('NPM_TOKEN'), 'npm_secret');
});

test('parseEnv rejects duplicate variables', () => {
  assert.throws(() => parseEnv('NPM_TOKEN=npm_one\nNPM_TOKEN=npm_two\n'), /重复变量/);
});

test('parseEnv rejects malformed lines', () => {
  assert.throws(() => parseEnv('NPM_TOKEN\n'), /格式无效/);
});

test('extractReleaseNotes extracts exactly one matching release', () => {
  const readme = `# Package

<!-- npm-release:start -->

### [0.2.0] - 2026-10-13

#### Fixed

- Fix the thing.

### [0.1.0] - 2026-10-01

#### Added

- Initial release.

<!-- npm-release:end -->
`;
  assert.match(extractReleaseNotes(readme, '0.2.0'), /^### \[0\.2\.0\]/);
  assert.doesNotMatch(extractReleaseNotes(readme, '0.2.0'), /0\.1\.0/);
});

test('extractReleaseNotes rejects a non-empty Unreleased section', () => {
  const readme = `<!-- npm-release:start -->
### Unreleased

#### Fixed

- Pending fix.

### [0.2.0] - 2026-10-13

#### Fixed

- Released fix.
<!-- npm-release:end -->`;
  assert.throws(() => extractReleaseNotes(readme, '0.2.0'), /Unreleased/);
});

test('expectedDigests returns npm-compatible sha512 integrity and sha1 shasum', () => {
  const buffer = Buffer.from('tarball bytes');
  assert.deepEqual(expectedDigests(buffer), {
    integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
    shasum: createHash('sha1').update(buffer).digest('hex'),
  });
});

test('assertRegistryMatches accepts exact dist metadata', () => {
  assert.doesNotThrow(() =>
    assertRegistryMatches(
      { version: '1.2.3', dist: { integrity: 'sha512-value', shasum: 'sha1-value' } },
      {
        name: '@mlzwl/example',
        version: '1.2.3',
        integrity: 'sha512-value',
        shasum: 'sha1-value',
      },
    ),
  );
});

test('assertRegistryMatches rejects mismatched tarball metadata', () => {
  assert.throws(
    () =>
      assertRegistryMatches(
        { version: '1.2.3', dist: { integrity: 'sha512-other', shasum: 'sha1-value' } },
        {
          name: '@mlzwl/example',
          version: '1.2.3',
          integrity: 'sha512-value',
          shasum: 'sha1-value',
        },
      ),
    /integrity/,
  );
});

test('assertRegistryMatches verifies gitHead when expected', () => {
  assert.throws(
    () =>
      assertRegistryMatches(
        {
          version: '1.2.3',
          gitHead: 'old-commit',
          dist: { integrity: 'sha512-value', shasum: 'sha1-value' },
        },
        {
          name: '@mlzwl/example',
          version: '1.2.3',
          integrity: 'sha512-value',
          shasum: 'sha1-value',
          gitHead: 'release-commit',
        },
      ),
    /gitHead/,
  );
});

test('auth-check uses a temporary npmrc and never prints the token', () => {
  const repositoryRoot = resolve(import.meta.dirname, '..');
  const fixture = mkdtempSync(join(tmpdir(), 'mlzwl-npm-auth-test-'));
  const fakeBin = join(fixture, 'bin');
  const capturePath = join(fixture, 'capture.json');
  const fakeNpm = join(fakeBin, 'npm');
  const token = 'npm_test_secret_value';

  try {
    cpSync(join(repositoryRoot, 'scripts'), join(fixture, 'scripts'), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(fixture, '.env'), `NPM_TOKEN=${token}\n`, { mode: 0o600 });
    writeFileSync(join(fixture, 'package.json'), '{"name":"fixture","private":true,"type":"module"}\n');
    writeFileSync(
      fakeNpm,
      `#!/bin/sh
{
  printf '%s\\n' "$NPM_TOKEN"
  printf '%s\\n' "$NPM_CONFIG_USERCONFIG"
  printf '%s\\n' "$*"
  base64 < "$NPM_CONFIG_USERCONFIG" | tr -d '\\n'
  printf '\\n'
} > "$CAPTURE_PATH"
printf 'mlzwl\\n'
`,
      { mode: 0o700 },
    );
    chmodSync(fakeNpm, 0o700);

    const result = spawnSync(process.execPath, ['scripts/npm-publish-local.mjs', 'auth-check'], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CAPTURE_PATH: capturePath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /npm_auth=ok/);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
    const [capturedToken, npmrc, args, encodedNpmrc] = readFileSync(capturePath, 'utf8').split('\n');
    assert.equal(args, 'whoami --registry=https://registry.npmjs.org');
    assert.equal(capturedToken, token);
    assert.match(Buffer.from(encodedNpmrc, 'base64').toString(), /_authToken=\$\{NPM_TOKEN\}/);
    assert.equal(npmrc.includes('mlzwl-npm-release-'), true);
    assert.equal(existsSync(npmrc), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
