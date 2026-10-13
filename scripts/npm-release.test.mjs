import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  allowedReleaseFiles,
  assertReleasePlan,
  assertReleasePr,
  assertUnpublishedSnapshot,
  classifyMissingTarget,
  collectGithubPages,
  compareSemver,
  extractPrMarkerEntries,
  extractReleaseNotes,
  finalizeTarball,
  loadRegistry,
  parseMarker,
  publishedBaselineVersions,
  selectMarkerPaths,
  snapshotSha,
  validateProvenance,
} from './npm-release.mjs';

const packages = [
  { id: 'second', name: '@x/second', order: 20, directory: 'apps/second', manifest: 'apps/second/package.json' },
  { id: 'first', name: '@x/first', order: 10, directory: 'apps/first', manifest: 'apps/first/package.json' },
].map((item) => ({ ...item, changelog: `${item.directory}/README.md`, verify: [['pnpm', 'verify']] }));

function registryFile(overrides = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'npm-release-test-'));
  const path = resolve(directory, 'registry.json');
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repository: 'chenerzhang/mlzwl',
      defaultBranch: 'master',
      environment: 'npm-release',
      workflowPath: '.github/workflows/npm-publish.yml',
      registry: 'https://registry.npmjs.org',
      npmVersion: '11.6.1',
      npmIntegrity: 'sha512-YQ==',
      nodeVersion: '22.20.0',
      nodeLinuxX64Sha256: '0'.repeat(64),
      repositoryVerify: ['pnpm', 'verify'],
      packages,
      ...overrides,
    }),
  );
  return path;
}

test('registry validation enforces environment and sorts explicit package order', () => {
  assert.deepEqual(
    loadRegistry(registryFile()).packages.map(({ id }) => id),
    ['first', 'second'],
  );
  assert.throws(() => loadRegistry(registryFile({ environment: '' })), /environment/);
  assert.throws(
    () => loadRegistry(registryFile({ packages: packages.map((item) => ({ ...item, order: 10 })) })),
    /order/,
  );
});

test('marker parser accepts only the closed release intent schema', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'npm-marker-test-'));
  const path = resolve(directory, 'first.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, package: 'first', version: '1.2.3', intent: 'minor' }));
  assert.equal(parseMarker(path, packages[1]).version, '1.2.3');
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, package: 'first', version: '1.2.3', intent: 'beta' }));
  assert.throws(() => parseMarker(path, packages[1]));
});

test('immutable snapshot follows event.after for push and GITHUB_SHA for dispatch', () => {
  const after = 'a'.repeat(40);
  const queuedSha = 'b'.repeat(40);
  assert.equal(snapshotSha('push', { after }, queuedSha), after);
  assert.equal(snapshotSha('workflow_dispatch', {}, queuedSha), queuedSha);
});

test('queued push selection never follows a later master or marker update', () => {
  const snapshot = 'a'.repeat(40);
  const calls = [];
  const selected = selectMarkerPaths({
    eventName: 'push',
    event: { before: '0'.repeat(40), after: snapshot },
    snapshot,
    registry: { packages: [packages[1], packages[0]] },
    changedFiles: (before, after) => {
      calls.push([before, after]);
      return ['.release/npm/first.json'];
    },
    listMarkersAt: () => {
      throw new Error('push must not scan moving marker state');
    },
  });
  assert.deepEqual(calls, [[`${snapshot}^`, snapshot]]);
  assert.deepEqual(
    selected.map(({ path }) => path),
    ['.release/npm/first.json'],
  );
});

test('dispatch lists markers only from its frozen GITHUB_SHA', () => {
  const snapshot = 'b'.repeat(40);
  const seen = [];
  const selected = selectMarkerPaths({
    eventName: 'workflow_dispatch',
    event: {},
    snapshot,
    registry: { packages: [packages[1], packages[0]] },
    changedFiles: () => [],
    listMarkersAt: (sha) => {
      seen.push(sha);
      return ['.release/npm/second.json', '.release/npm/first.json'];
    },
  });
  assert.deepEqual(seen, [snapshot]);
  assert.deepEqual(
    selected.map(({ path }) => path),
    ['.release/npm/first.json', '.release/npm/second.json'],
  );
});

test('PR allowlist uses every PR marker while current recovery selection stays separate', () => {
  const pr1Files = [
    { filename: '.release/npm/first.json', status: 'added' },
    { filename: '.release/npm/second.json', status: 'added' },
    { filename: 'apps/first/package.json' },
    { filename: 'apps/first/README.md' },
    { filename: 'apps/second/package.json' },
    { filename: 'apps/second/README.md' },
    { filename: 'pnpm-lock.yaml' },
  ];
  const batch = extractPrMarkerEntries(pr1Files, { packages: [packages[1], packages[0]] });
  const currentRecovery = [batch[1]];
  assert.deepEqual(
    batch.map(({ package: item }) => item.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    currentRecovery.map(({ package: item }) => item.id),
    ['second'],
  );
  const pr = { merged: true, base: { ref: 'master' }, labels: [{ name: 'npm-release' }] };
  assert.doesNotThrow(() => assertReleasePr({ pr, files: pr1Files, batchEntries: batch, branch: 'master' }));
  const pr2Batch = extractPrMarkerEntries([{ filename: '.release/npm/first.json', status: 'modified' }], {
    packages: [packages[1], packages[0]],
  });
  assert.deepEqual(
    pr2Batch.map(({ package: item }) => item.id),
    ['first'],
  );
  assert.deepEqual(
    currentRecovery.map(({ package: item }) => item.id),
    ['second'],
  );
  assert.ok(allowedReleaseFiles(batch).has('apps/second/package.json'));
});

test('release PR label and batch-scoped file allowlist reject renames', () => {
  const batchEntries = [
    { path: '.release/npm/first.json', package: packages[1] },
    { path: '.release/npm/second.json', package: packages[0] },
  ];
  const files = [...allowedReleaseFiles(batchEntries)].map((filename) => ({ filename }));
  const pr = { merged: true, base: { ref: 'master' }, labels: [{ name: 'npm-release' }] };
  assert.doesNotThrow(() => assertReleasePr({ pr, files, batchEntries, branch: 'master' }));
  assert.throws(
    () => assertReleasePr({ pr, files: [...files, { filename: 'src/index.ts' }], batchEntries, branch: 'master' }),
    /disallowed/,
  );
  assert.throws(() => assertReleasePr({ pr: { ...pr, labels: [] }, files, batchEntries, branch: 'master' }), /label/);
  assert.throws(
    () =>
      assertReleasePr({
        pr,
        files: [...files, { filename: 'apps/first/README.md', previous_filename: 'src/secrets.ts', status: 'renamed' }],
        batchEntries,
        branch: 'master',
      }),
    /renamed/,
  );
  assert.throws(
    () =>
      extractPrMarkerEntries(
        [{ filename: '.release/npm/first.json', previous_filename: 'src/secrets.ts', status: 'renamed' }],
        { packages: [packages[1], packages[0]] },
      ),
    /renamed/,
  );
});

test('GitHub pagination collects all PR files and fails closed at its safety limit', async () => {
  const pages = new Map([
    [1, Array.from({ length: 100 }, (_, index) => index)],
    [2, [100, 101]],
  ]);
  assert.deepEqual(
    await collectGithubPages(async (page) => pages.get(page) ?? []),
    Array.from({ length: 102 }, (_, index) => index),
  );
  await assert.rejects(() => collectGithubPages(async () => Array(100).fill(0), 2), /200 item safety limit/);
});

test('release notes require exactly one matching version heading', () => {
  const markdown = `before\n<!-- npm-release:start -->\n### [1.2.3] - 2026-01-02\n\n#### Fixed\n\n- fix\n\n### [1.2.2] - 2026-01-01\n\n- old\n<!-- npm-release:end -->`;
  assert.equal(extractReleaseNotes(markdown, '1.2.3'), '### [1.2.3] - 2026-01-02\n\n#### Fixed\n\n- fix\n');
  assert.throws(() => extractReleaseNotes(markdown, '2.0.0'), /exactly one/);
});

test('SemVer comparison implements stable and prerelease precedence', () => {
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.10.0',
    '9007199254740993.0.0',
  ];
  assert.deepEqual([...ordered].reverse().sort(compareSemver), ordered);
  assert.equal(compareSemver('2.0.0+one', '2.0.0+two'), 0);
  assert.ok(compareSemver('1.0.0-alpha.9007199254740993', '1.0.0-alpha.9007199254740992') > 0);
  assert.throws(() => compareSemver('1.0.0-01', '1.0.0'));
});

test('initial baseline ignores staging placeholder but recovery fails closed while target is hidden', () => {
  const staged = { versions: { '0.0.0-stage': {} } };
  assert.deepEqual(publishedBaselineVersions(staged), []);
  assert.throws(
    () => classifyMissingTarget(staged, { intent: 'initial', version: '1.0.0' }),
    /staged trusted publication may already be pending/,
  );
  assert.deepEqual(classifyMissingTarget(null, { intent: 'initial', version: '1.0.0' }), { baseline: null });
});

test('prepared tarball uses an absolute package path and embeds the release gitHead', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'npm-tarball-test-'));
  const packageDirectory = resolve(directory, 'apps/example');
  const outputDirectory = resolve(directory, 'output');
  mkdirSync(packageDirectory, { recursive: true });
  mkdirSync(outputDirectory);
  writeFileSync(
    resolve(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@x/example', version: '1.2.3', files: ['index.js'] }),
  );
  writeFileSync(resolve(packageDirectory, 'index.js'), 'export const value = 1;\n');
  const releaseSha = 'a'.repeat(40);
  try {
    const result = finalizeTarball(packageDirectory, outputDirectory, releaseSha);
    assert.match(result.file, /^x-example-1\.2\.3\.tgz$/);
    assert.match(result.integrity, /^sha512-/);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', result.source, 'package/package.json'], { encoding: 'utf8' }),
    );
    assert.equal(manifest.name, '@x/example');
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.gitHead, releaseSha);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('publish command starts from an artifact-only cwd without a repository checkout', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'npm-publish-startup-test-'));
  const artifactDirectory = resolve(directory, '.tmp/npm-release-artifact');
  const trustedDirectory = resolve(directory, 'trusted');
  mkdirSync(artifactDirectory, { recursive: true });
  mkdirSync(trustedDirectory);
  cpSync('scripts/npm-release.mjs', resolve(trustedDirectory, 'npm-release.mjs'));
  cpSync('.release/npm-packages.json', resolve(trustedDirectory, 'npm-packages.json'));
  cpSync('.release/npm-packages.json', resolve(artifactDirectory, 'registry.json'));
  writeFileSync(
    resolve(artifactDirectory, 'plan.json'),
    JSON.stringify({
      schemaVersion: 1,
      repository: 'chenerzhang/mlzwl',
      workflowPath: '.github/workflows/npm-publish.yml',
      eventName: 'push',
      snapshot: 'a'.repeat(40),
      ref: 'refs/heads/master',
      packages: [],
    }),
  );
  try {
    const result = spawnSync(process.execPath, ['trusted/npm-release.mjs', 'publish'], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/master',
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_TOKEN: 'test-token',
        NPM_RELEASE_REGISTRY: resolve(trustedDirectory, 'npm-packages.json'),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release plan contains no packages/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release artifact plan is bound to the current workflow event and package order', () => {
  const snapshot = 'a'.repeat(40);
  const registry = { repository: 'chenerzhang/mlzwl', workflowPath: '.github/workflows/npm-publish.yml' };
  const env = { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: snapshot, GITHUB_REF: 'refs/heads/master' };
  const plan = {
    schemaVersion: 1,
    repository: registry.repository,
    workflowPath: registry.workflowPath,
    eventName: env.GITHUB_EVENT_NAME,
    snapshot,
    ref: env.GITHUB_REF,
    packages: [
      { snapshot, package: { order: 10 } },
      { snapshot, package: { order: 20 } },
    ],
  };
  assert.doesNotThrow(() => assertReleasePlan(plan, registry, env));
  assert.throws(() => assertReleasePlan({ ...plan, snapshot: 'b'.repeat(40) }, registry, env), /strictly equal/);
  assert.throws(
    () => assertReleasePlan({ ...plan, packages: [...plan.packages].reverse() }, registry, env),
    /package order/,
  );
});

test('unpublished recovery cannot attest an older release commit from a newer dispatch snapshot', () => {
  const oldRelease = 'a'.repeat(40);
  const newerSnapshot = 'b'.repeat(40);
  assert.doesNotThrow(() => assertUnpublishedSnapshot(oldRelease, oldRelease, false));
  assert.doesNotThrow(() => assertUnpublishedSnapshot(newerSnapshot, oldRelease, true));
  assert.throws(
    () => assertUnpublishedSnapshot(newerSnapshot, oldRelease, false),
    /original immutable workflow snapshot/,
  );
});

test('SLSA provenance must verify its Sigstore bundle and bind workflow, commit, and package', async () => {
  const bytes = Buffer.from('tarball bytes');
  const integrity = `sha512-${bytes.toString('base64')}`;
  const sha = 'c'.repeat(40);
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'pkg:npm/%40x/first@1.2.3', digest: { sha512: bytes.toString('hex') } }],
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            ref: 'refs/heads/master',
            repository: 'https://github.com/chenerzhang/mlzwl',
            path: '.github/workflows/npm-publish.yml',
          },
        },
        resolvedDependencies: [
          {
            uri: 'git+https://github.com/chenerzhang/mlzwl@refs/heads/master',
            digest: { gitCommit: sha },
          },
        ],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
        metadata: { invocationId: 'https://github.com/chenerzhang/mlzwl/actions/runs/123/attempts/1' },
      },
    },
  };
  const document = {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: {
            payloadType: 'application/vnd.in-toto+json',
            payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
          },
        },
      },
    ],
  };
  const expected = {
    integrity,
    packageName: '@x/first',
    version: '1.2.3',
    repository: 'chenerzhang/mlzwl',
    workflowPath: '.github/workflows/npm-publish.yml',
    sha,
  };
  const validVerifier = async (_bundle, options) => {
    assert.equal(options.certificateIssuer, 'https://token.actions.githubusercontent.com');
    assert.equal(
      options.certificateIdentityURI,
      'https://github.com/chenerzhang/mlzwl/.github/workflows/npm-publish.yml@refs/heads/master',
    );
    assert.equal(options.ctLogThreshold, 1);
    assert.equal(options.tlogThreshold, 1);
  };
  await assert.doesNotReject(() => validateProvenance(document, expected, validVerifier));
  await assert.rejects(
    () => validateProvenance(document, expected, async () => Promise.reject(new Error('invalid signature'))),
    /invalid signature/,
  );
  const conflict = structuredClone(document);
  const payload = JSON.parse(Buffer.from(conflict.attestations[0].bundle.dsseEnvelope.payload, 'base64').toString());
  payload.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'd'.repeat(40);
  conflict.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64');
  await assert.rejects(() => validateProvenance(conflict, expected, validVerifier), /release commit/);
  const wrongType = structuredClone(document);
  const wrongTypePayload = JSON.parse(
    Buffer.from(wrongType.attestations[0].bundle.dsseEnvelope.payload, 'base64').toString(),
  );
  wrongTypePayload._type = 'https://in-toto.io/Statement/v0.1';
  wrongType.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(wrongTypePayload)).toString(
    'base64',
  );
  await assert.rejects(() => validateProvenance(wrongType, expected, validVerifier), /strictly equal/);
});

test('workflow scopes OIDC, uses the environment, and remains marker-only and SHA-pinned', () => {
  const workflow = readFileSync('.github/workflows/npm-publish.yml', 'utf8');
  assert.match(workflow, /paths:\n\s+- '\.release\/npm\/\*\.json'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.equal((workflow.match(/id-token: write/g) ?? []).length, 1);
  assert.match(workflow, /publish:[\s\S]*environment: npm-release[\s\S]*id-token: write/);
  assert.doesNotMatch(
    workflow.match(/prepare:[\s\S]*?publish:/)?.[0] ?? '',
    /id-token: write|environment: npm-release/,
  );
  assert.match(workflow, /npm install --global npm@11\.6\.1 --ignore-scripts/);
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(workflow, /npm-release\.mjs prepare/);
  assert.match(workflow, /npm-release\.mjs publish/);
  assert.match(workflow, /NPM_RELEASE_REGISTRY/);
  assert.match(workflow, /NPM_CLI_JS/);
  assert.match(
    workflow,
    /api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/contents\/scripts\/npm-release\.mjs\?ref=\$\{GITHUB_SHA\}/,
  );
  const scriptDigest = createHash('sha256').update(readFileSync('scripts/npm-release.mjs')).digest('hex');
  const registryDigest = createHash('sha256').update(readFileSync('.release/npm-packages.json')).digest('hex');
  assert.match(workflow, new RegExp(`RELEASE_SCRIPT_SHA256: ${scriptDigest}`));
  assert.match(workflow, new RegExp(`RELEASE_REGISTRY_SHA256: ${registryDigest}`));
  assert.doesNotMatch(workflow.match(/publish:[\s\S]*/)?.[0] ?? '', /actions\/checkout|download-artifact/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|npm whoami|pnpm publish/);
  for (const action of [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])) {
    assert.match(action, /@[0-9a-f]{40}$/);
  }
  const implementation = readFileSync('scripts/npm-release.mjs', 'utf8');
  assert.match(implementation, /'npm',\s*\[\s*'publish'/);
  assert.match(implementation, /const packageDirectory = resolve\(item\.directory\)/);
  assert.match(implementation, /'publish',\s*tarball/);
  assert.match(implementation, /'pack',\s*packageDirectory/);
  assert.match(implementation, /packedManifest\.gitHead = releaseSha/);
  assert.doesNotMatch(implementation, /'publish',\s*(?:item\.directory|packageDirectory)/);
  assert.match(implementation, /delete env\.ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.match(implementation, /delete env\.GITHUB_TOKEN/);
  assert.match(implementation, /delete process\.env\.ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.match(implementation, /delete process\.env\.GITHUB_TOKEN/);
  assert.match(implementation, /unpublished package can only be published by the original immutable workflow snapshot/);
  assert.doesNotMatch(implementation, /npm whoami|pnpm publish|origin\/\$\{registry\.defaultBranch\}/);
});
