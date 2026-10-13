#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER_PATTERN = /^\.release\/npm\/([a-z0-9][a-z0-9-]*)\.json$/;
const CHANGELOG_START = '<!-- npm-release:start -->';
const CHANGELOG_END = '<!-- npm-release:end -->';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const GITHUB_WORKFLOW_BUILD = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const GITHUB_HOSTED_BUILDER = 'https://github.com/actions/runner/github-hosted';
const STAGED_PLACEHOLDER = '0.0.0-stage';
const ARTIFACT_DIRECTORY = '.tmp/npm-release-artifact';
let githubAccessToken;
let oidcPublishEnvironment;

export function loadRegistry(path = '.release/npm-packages.json') {
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(registry.schemaVersion, 1, 'unsupported registry schema');
  assert.equal(registry.repository, 'chenerzhang/mlzwl', 'unexpected GitHub repository');
  assert.equal(registry.defaultBranch, 'master', 'unexpected default branch');
  assert.equal(registry.environment, 'npm-release', 'unexpected publishing environment');
  assert.equal(registry.workflowPath, '.github/workflows/npm-publish.yml', 'unexpected publishing workflow path');
  assert.equal(registry.registry, 'https://registry.npmjs.org', 'public npm registry is required');
  assert.match(registry.npmVersion, /^11\.(?:[5-9]|\d{2,})\.\d+$/, 'npm >=11.5.1 is required');
  assert.match(registry.npmIntegrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, 'invalid npm tarball integrity');
  assert.match(registry.nodeVersion, /^22\.\d+\.\d+$/, 'Node.js 22 is required');
  assert.match(registry.nodeLinuxX64Sha256, /^[0-9a-f]{64}$/, 'invalid Node.js archive digest');
  assert.ok(Array.isArray(registry.packages) && registry.packages.length > 0, 'no npm packages registered');
  const ids = new Set();
  const names = new Set();
  const orders = new Set();
  for (const item of registry.packages) {
    assert.match(item.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(!ids.has(item.id), `duplicate package id ${item.id}`);
    assert.ok(!names.has(item.name), `duplicate package name ${item.name}`);
    assert.ok(!orders.has(item.order), `duplicate package order ${item.order}`);
    ids.add(item.id);
    names.add(item.name);
    orders.add(item.order);
    assert.equal(item.manifest, `${item.directory}/package.json`);
    assert.ok(Array.isArray(item.verify) && item.verify.length > 0, `${item.id} has no verification commands`);
  }
  registry.packages.sort((left, right) => left.order - right.order);
  return registry;
}

export function parseMarkerText(text, packageConfig) {
  const marker = JSON.parse(text);
  assert.deepEqual(Object.keys(marker).sort(), ['intent', 'package', 'schemaVersion', 'version']);
  assert.equal(marker.schemaVersion, 1);
  assert.equal(marker.package, packageConfig.id);
  assert.match(marker.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(['initial', 'only-publish', 'patch', 'minor', 'major'].includes(marker.intent));
  return marker;
}

export function parseMarker(path, packageConfig) {
  return parseMarkerText(readFileSync(path, 'utf8'), packageConfig);
}

export function snapshotSha(eventName, event, githubSha) {
  const sha = eventName === 'push' ? event.after : githubSha;
  assert.match(sha ?? '', /^[0-9a-f]{40}$/, 'event has no immutable snapshot SHA');
  return sha;
}

export function selectMarkerPaths({ eventName, event, snapshot, registry, listMarkersAt, changedFiles }) {
  const known = new Map(registry.packages.map((item) => [item.id, item]));
  const candidates =
    eventName === 'push'
      ? changedFiles(/^0+$/.test(event.before) ? `${snapshot}^` : event.before, snapshot)
      : listMarkersAt(snapshot);
  const paths = [...new Set(candidates.filter((path) => MARKER_PATTERN.test(path)))];
  const selected = paths.map((path) => {
    const id = MARKER_PATTERN.exec(path)[1];
    assert.ok(known.has(id), `marker references unregistered package ${id}`);
    return { path, package: known.get(id) };
  });
  selected.sort((left, right) => left.package.order - right.package.order);
  return selected;
}

export function extractPrMarkerEntries(files, registry) {
  const known = new Map(registry.packages.map((item) => [item.id, item]));
  const entries = [];
  for (const { filename, status } of files) {
    assert.notEqual(status, 'renamed', `release PR contains renamed file ${filename}`);
    const match = MARKER_PATTERN.exec(filename);
    if (!match) {
      continue;
    }
    assert.notEqual(status, 'removed', `release PR removes marker ${filename}`);
    assert.ok(known.has(match[1]), `release PR contains unregistered marker ${filename}`);
    entries.push({ path: filename, package: known.get(match[1]) });
  }
  assert.ok(entries.length > 0, 'release PR contains no registered marker');
  entries.sort((left, right) => left.package.order - right.package.order);
  return entries;
}

export function extractReleaseNotes(markdown, version) {
  const start = markdown.indexOf(CHANGELOG_START);
  const end = markdown.indexOf(CHANGELOG_END);
  assert.ok(start >= 0 && end > start, 'Changelog release markers are missing or reversed');
  const body = markdown.slice(start + CHANGELOG_START.length, end);
  const escaped = version.replaceAll('.', '\\.');
  const heading = new RegExp(`^### \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, 'gm');
  const matches = [...body.matchAll(heading)];
  assert.equal(matches.length, 1, `Changelog must contain exactly one ${version} heading`);
  const from = matches[0].index;
  const rest = body.slice(from + matches[0][0].length);
  const next = rest.search(/^### /m);
  return body.slice(from, next < 0 ? undefined : from + matches[0][0].length + next).trim() + '\n';
}

export function allowedReleaseFiles(batchEntries) {
  return new Set([
    'pnpm-lock.yaml',
    ...batchEntries.flatMap(({ path, package: item }) => [path, item.manifest, item.changelog]),
  ]);
}

export function assertReleasePr({ pr, files, batchEntries, branch }) {
  assert.equal(pr.merged, true, 'release PR is not merged');
  assert.equal(pr.base.ref, branch, `release PR must target ${branch}`);
  assert.ok(
    pr.labels.some(({ name }) => name === 'npm-release'),
    'release PR is missing npm-release label',
  );
  const allowed = allowedReleaseFiles(batchEntries);
  for (const file of files) {
    assert.notEqual(file.status, 'renamed', `release PR contains renamed file ${file.filename}`);
    assert.ok(allowed.has(file.filename), `release PR contains disallowed file ${file.filename}`);
  }
  for (const { path } of batchEntries) {
    assert.ok(
      files.some(({ filename }) => filename === path),
      `release PR does not change ${path}`,
    );
  }
}

function parseSemver(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  assert.ok(match, `invalid semantic version ${version}`);
  return {
    core: match.slice(1, 4),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumericIdentifiers(a.core[index], b.core[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined || b.prerelease[index] === undefined) {
      return a.prerelease[index] === undefined ? -1 : 1;
    }
    if (a.prerelease[index] === b.prerelease[index]) {
      continue;
    }
    const aNumeric = /^\d+$/.test(a.prerelease[index]);
    const bNumeric = /^\d+$/.test(b.prerelease[index]);
    if (aNumeric && bNumeric) {
      return compareNumericIdentifiers(a.prerelease[index], b.prerelease[index]);
    }
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

export function publishedBaselineVersions(packument) {
  return Object.keys(packument?.versions ?? {}).filter((version) => version !== STAGED_PLACEHOLDER);
}

export function assertUnpublishedSnapshot(snapshot, releaseSha, published) {
  if (!published) {
    assert.equal(
      snapshot,
      releaseSha,
      'unpublished package can only be published by the original immutable workflow snapshot',
    );
  }
}

export function classifyMissingTarget(packument, marker) {
  const allVersions = Object.keys(packument?.versions ?? {});
  const versions = publishedBaselineVersions(packument);
  if (allVersions.includes(STAGED_PLACEHOLDER) && versions.length === 0) {
    throw new Error('npm only exposes 0.0.0-stage; a staged trusted publication may already be pending');
  }
  if (versions.length === 0) {
    assert.equal(marker.intent, 'initial', 'only initial intent may publish a package with no versions');
    return { baseline: null };
  }
  const highest = versions.sort(compareSemver).at(-1);
  assert.ok(
    compareSemver(marker.version, highest) > 0,
    `target ${marker.version} does not follow all published versions`,
  );
  assert.notEqual(marker.intent, 'initial', 'initial intent conflicts with existing package versions');
  return { baseline: highest };
}

function loadSigstoreVerifier() {
  const npmCli = process.env.NPM_CLI_JS;
  assert.ok(npmCli, 'NPM_CLI_JS is required to verify npm provenance');
  return createRequire(npmCli)('sigstore').verify;
}

export async function validateProvenance(
  attestationsDocument,
  { integrity, packageName, version, repository, workflowPath, defaultBranch = 'master', sha },
  verifyBundle = loadSigstoreVerifier(),
) {
  const attestation = attestationsDocument?.attestations?.find(
    ({ predicateType }) => predicateType === SLSA_PROVENANCE,
  );
  assert.ok(attestation, 'npm attestations contain no SLSA provenance');
  await verifyBundle(attestation.bundle, {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    certificateIdentityURI: `https://github.com/${repository}/${workflowPath}@refs/heads/${defaultBranch}`,
    ctLogThreshold: 1,
    tlogThreshold: 1,
  });
  const envelope = attestation.bundle?.dsseEnvelope;
  assert.equal(envelope?.payloadType, 'application/vnd.in-toto+json');
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
  assert.equal(statement.predicateType, SLSA_PROVENANCE);
  const expectedDigest = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  const purlName = packageName.startsWith('@') ? `%40${packageName.slice(1)}` : packageName;
  assert.ok(
    statement.subject?.some(
      (subject) => subject.name === `pkg:npm/${purlName}@${version}` && subject.digest?.sha512 === expectedDigest,
    ),
    'provenance subject does not match the published package integrity',
  );
  const definition = statement.predicate?.buildDefinition;
  assert.equal(definition?.buildType, GITHUB_WORKFLOW_BUILD);
  assert.deepEqual(definition.externalParameters?.workflow, {
    ref: `refs/heads/${defaultBranch}`,
    repository: `https://github.com/${repository}`,
    path: workflowPath,
  });
  assert.ok(
    definition.resolvedDependencies?.some(
      (dependency) =>
        dependency.uri === `git+https://github.com/${repository}@refs/heads/${defaultBranch}` &&
        dependency.digest?.gitCommit === sha,
    ),
    'provenance does not resolve to the release commit',
  );
  assert.equal(statement.predicate?.runDetails?.builder?.id, GITHUB_HOSTED_BUILDER);
  assert.match(
    statement.predicate?.runDetails?.metadata?.invocationId ?? '',
    new RegExp(`^https://github\\.com/${repository.replace('/', '\\/')}/actions/runs/\\d+/attempts/\\d+$`),
  );
  return statement;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
}

function assertSafeArtifactName(value, label) {
  assert.match(value, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, `unsafe ${label}`);
  return value;
}

function readArtifactJson(path) {
  return JSON.parse(readFileSync(resolve(ARTIFACT_DIRECTORY, path), 'utf8'));
}

function writeArtifactJson(path, value) {
  writeFileSync(resolve(ARTIFACT_DIRECTORY, path), `${JSON.stringify(value, null, 2)}\n`);
}

function withoutGithubWriteToken() {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  return env;
}

function isolatePublishCredentials() {
  githubAccessToken = process.env.GITHUB_TOKEN;
  assert.ok(githubAccessToken, 'GITHUB_TOKEN is required');
  oidcPublishEnvironment = {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    ACTIONS_ID_TOKEN_REQUEST_URL: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  };
  assert.ok(oidcPublishEnvironment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'OIDC request token is required');
  assert.ok(oidcPublishEnvironment.ACTIONS_ID_TOKEN_REQUEST_URL, 'OIDC request URL is required');
  delete process.env.GITHUB_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
}

function withoutPublishingCredentials() {
  const env = withoutGithubWriteToken();
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  return env;
}

function git(args) {
  return run('git', args, { env: withoutPublishingCredentials() });
}

function gitFile(sha, path) {
  return git(['show', `${sha}:${path}`]);
}

async function github(path, options = {}) {
  const token = githubAccessToken ?? process.env.GITHUB_TOKEN;
  assert.ok(token, 'GITHUB_TOKEN is required');
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (response.status === 404 && options.allow404) {
    return null;
  }
  const text = await response.text();
  assert.ok(response.ok, `GitHub ${options.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

export async function collectGithubPages(fetchPage, maximumPages = 30) {
  const values = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const current = await fetchPage(page);
    assert.ok(Array.isArray(current), 'paginated GitHub response is not an array');
    values.push(...current);
    if (current.length < 100) {
      return values;
    }
  }
  throw new Error(`paginated GitHub response reached ${maximumPages * 100} item safety limit`);
}

async function githubPaginated(path) {
  const separator = path.includes('?') ? '&' : '?';
  return collectGithubPages((page) => github(`${path}${separator}per_page=100&page=${page}`));
}

async function npmPackument(name) {
  const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  if (response.status === 404) {
    return null;
  }
  assert.ok(response.ok, `npm registry query failed (${response.status})`);
  return response.json();
}

function packageIntegrity(tarball) {
  return `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
}

export function finalizeTarball(packageDirectory, directory, releaseSha) {
  const firstPack = resolve(directory, 'first-pack');
  const unpacked = resolve(directory, 'unpacked');
  const finalPack = resolve(directory, 'final-pack');
  mkdirSync(firstPack);
  mkdirSync(unpacked);
  mkdirSync(finalPack);
  const firstOutput = JSON.parse(
    run('npm', ['pack', packageDirectory, '--ignore-scripts', '--json', '--pack-destination', firstPack], {
      env: withoutPublishingCredentials(),
    }),
  );
  assert.equal(firstOutput.length, 1);
  run('tar', ['-xzf', resolve(firstPack, firstOutput[0].filename), '-C', unpacked], {
    env: withoutPublishingCredentials(),
  });
  const packedManifestPath = resolve(unpacked, 'package/package.json');
  const packedManifest = JSON.parse(readFileSync(packedManifestPath, 'utf8'));
  assert.ok(
    !packedManifest.gitHead || packedManifest.gitHead === releaseSha,
    'packed manifest has a conflicting gitHead',
  );
  packedManifest.gitHead = releaseSha;
  writeFileSync(packedManifestPath, `${JSON.stringify(packedManifest, null, 2)}\n`);
  const finalOutput = JSON.parse(
    run('npm', ['pack', resolve(unpacked, 'package'), '--ignore-scripts', '--json', '--pack-destination', finalPack], {
      env: withoutPublishingCredentials(),
    }),
  );
  assert.equal(finalOutput.length, 1);
  const source = resolve(finalPack, finalOutput[0].filename);
  return {
    source,
    file: assertSafeArtifactName(basename(source), 'tarball filename'),
    integrity: packageIntegrity(source),
  };
}

function assertRegistryConfiguration(item, registry) {
  const options = { env: withoutPublishingCredentials() };
  assert.equal(run('npm', ['--version'], options), registry.npmVersion, 'unexpected npm CLI version');
  assert.equal(run('npm', ['config', 'get', 'registry'], options).replace(/\/$/, ''), registry.registry);
  const scope = item.name.startsWith('@') ? item.name.split('/')[0] : null;
  if (scope) {
    assert.equal(run('npm', ['config', 'get', `${scope}:registry`], options).replace(/\/$/, ''), registry.registry);
  }
  const manifest = JSON.parse(readFileSync(item.manifest, 'utf8'));
  assert.equal(manifest.name, item.name);
  assert.equal(manifest.publishConfig?.registry, registry.registry);
  assert.equal(manifest.publishConfig?.access, 'public');
  return manifest;
}

function assertCommitInSnapshot(sha, snapshot) {
  run('git', ['merge-base', '--is-ancestor', sha, snapshot], { env: withoutPublishingCredentials() });
  assert.equal(git(['rev-parse', `${sha}^{commit}`]), sha, 'release SHA is not a commit');
}

async function resolveReleasePr(registry, entry, snapshot) {
  const releaseSha = git(['log', '-1', '--format=%H', snapshot, '--', entry.path]);
  assert.ok(releaseSha, `cannot find release commit for ${entry.path} in ${snapshot}`);
  assertCommitInSnapshot(releaseSha, snapshot);
  const pulls = await github(`/repos/${registry.repository}/commits/${releaseSha}/pulls`);
  const candidates = [];
  for (const candidate of pulls.filter((pr) => pr.merged_at && pr.base.ref === registry.defaultBranch)) {
    const full = await github(`/repos/${registry.repository}/pulls/${candidate.number}`);
    if (full.labels.some(({ name }) => name === 'npm-release')) {
      candidates.push(full);
    }
  }
  assert.equal(candidates.length, 1, `expected one merged npm-release PR for ${entry.path}`);
  const pr = candidates[0];
  const files = await githubPaginated(`/repos/${registry.repository}/pulls/${pr.number}/files`);
  const batchEntries = extractPrMarkerEntries(files, registry);
  assert.ok(
    batchEntries.some(({ path }) => path === entry.path),
    `release PR does not own ${entry.path}`,
  );
  assert.ok(pr.merge_commit_sha, 'merged release PR has no merge commit SHA');
  assertCommitInSnapshot(pr.merge_commit_sha, snapshot);
  for (const batchEntry of batchEntries) {
    parseMarkerText(gitFile(pr.merge_commit_sha, batchEntry.path), batchEntry.package);
  }
  return { pr, files, batchEntries, releaseSha: pr.merge_commit_sha };
}

function expectedVersion(intent, latest) {
  const parsed = parseSemver(latest);
  assert.equal(parsed.prerelease.length, 0, 'latest must be a stable semantic version');
  const [major, minor, patch] = parsed.core.map(BigInt);
  if (intent === 'patch') {
    return `${major}.${minor}.${patch + 1n}`;
  }
  if (intent === 'minor') {
    return `${major}.${minor + 1n}.0`;
  }
  if (intent === 'major') {
    return `${major + 1n}.0.0`;
  }
  return null;
}

async function exactNpmState(registry, item, marker, sha, expectedIntegrity) {
  const packument = await npmPackument(item.name);
  const published = packument?.versions?.[marker.version] ?? null;
  if (!published) {
    classifyMissingTarget(packument, marker);
    const latest = packument?.['dist-tags']?.latest;
    if (['patch', 'minor', 'major'].includes(marker.intent)) {
      assert.ok(latest, 'published package has no latest dist-tag');
      assert.equal(
        marker.version,
        expectedVersion(marker.intent, latest),
        `${marker.intent} target does not follow latest ${latest}`,
      );
    }
    return { published: false };
  }
  assert.equal(published.gitHead, sha, 'published gitHead conflicts with release commit');
  assert.equal(
    published.dist?.integrity,
    expectedIntegrity,
    'published package integrity conflicts with local package',
  );
  assert.equal(packument['dist-tags']?.latest, marker.version, 'published version is not the latest dist-tag');
  assert.equal(published.dist?.attestations?.provenance?.predicateType, SLSA_PROVENANCE);
  assert.ok(published.dist?.attestations?.url, 'published version has no attestations URL');
  const response = await fetch(published.dist.attestations.url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  assert.ok(response.ok, `npm attestations query failed (${response.status})`);
  await validateProvenance(await response.json(), {
    integrity: expectedIntegrity,
    packageName: item.name,
    version: marker.version,
    repository: registry.repository,
    workflowPath: registry.workflowPath,
    defaultBranch: registry.defaultBranch,
    sha,
  });
  return { published: true };
}

async function inspectTagAndRelease(registry, item, marker, sha, notes) {
  const tag = `${item.tagPrefix}${marker.version}`;
  const encoded = encodeURIComponent(tag);
  const ref = await github(`/repos/${registry.repository}/git/ref/tags/${encoded}`, { allow404: true });
  if (ref) {
    const object = await github(`/repos/${registry.repository}/git/tags/${ref.object.sha}`, { allow404: true });
    assert.ok(object, `existing ${tag} is not an annotated tag`);
    assert.equal(object.object.sha, sha, `existing ${tag} points to the wrong commit`);
  }
  const release = await github(`/repos/${registry.repository}/releases/tags/${encoded}`, { allow404: true });
  const title = item.releaseTitle.replace('<version>', marker.version);
  if (release) {
    assert.ok(ref, `GitHub Release ${tag} exists without an annotated tag`);
    assert.equal(release.tag_name, tag, 'existing GitHub Release tag conflicts');
    assert.equal(release.name, title, 'existing GitHub Release title conflicts');
    assert.equal(release.body.trim(), notes.trim(), 'existing GitHub Release notes conflict');
    assert.equal(release.draft, false, 'existing GitHub Release is still a draft');
    assert.equal(release.prerelease, false, 'existing GitHub Release is marked as a prerelease');
  }
  return { tag, ref, release, title };
}

async function ensureTagAndRelease(registry, sha, notes, current) {
  if (!current.ref) {
    const tagObject = await github(`/repos/${registry.repository}/git/tags`, {
      method: 'POST',
      body: JSON.stringify({ tag: current.tag, message: `Release ${current.tag}`, object: sha, type: 'commit' }),
    });
    await github(`/repos/${registry.repository}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/tags/${current.tag}`, sha: tagObject.sha }),
    });
  }
  if (!current.release) {
    await github(`/repos/${registry.repository}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: current.tag, target_commitish: sha, name: current.title, body: notes }),
    });
  }
}

async function prepareOne(registry, selected, releaseSha, snapshot, artifactDirectory) {
  const item = selected.package;
  const packageDirectory = resolve(item.directory);
  git(['checkout', '--detach', releaseSha]);
  const marker = parseMarker(selected.path, item);
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
    stdio: 'inherit',
    env: withoutPublishingCredentials(),
  });
  const manifest = assertRegistryConfiguration(item, registry);
  assert.equal(manifest.version, marker.version, 'marker and manifest versions differ');
  const notes = extractReleaseNotes(readFileSync(item.changelog, 'utf8'), marker.version);
  for (const command of item.verify) {
    run(command[0], command.slice(1), { stdio: 'inherit', env: withoutPublishingCredentials() });
  }
  run(registry.repositoryVerify[0], registry.repositoryVerify.slice(1), {
    stdio: 'inherit',
    env: withoutPublishingCredentials(),
  });

  const directory = mkdtempSync(resolve(tmpdir(), `npm-release-${item.id}-`));
  try {
    const { source, file, integrity } = finalizeTarball(packageDirectory, directory, releaseSha);
    const target = resolve(artifactDirectory, file);
    copyFileSync(source, target);
    assert.equal(packageIntegrity(target), integrity);
    return { package: item, marker, releaseSha, snapshot, file, integrity, notes };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertReleasePlan(plan, registry, env) {
  assert.equal(plan.schemaVersion, 1);
  assert.deepEqual(Object.keys(plan).sort(), [
    'eventName',
    'packages',
    'ref',
    'repository',
    'schemaVersion',
    'snapshot',
    'workflowPath',
  ]);
  assert.equal(plan.repository, registry.repository);
  assert.equal(plan.workflowPath, registry.workflowPath);
  assert.equal(plan.eventName, env.GITHUB_EVENT_NAME);
  assert.equal(plan.snapshot, env.GITHUB_SHA);
  assert.equal(plan.ref, env.GITHUB_REF);
  assert.ok(plan.packages.length > 0, 'release plan contains no packages');
  assert.deepEqual(
    plan.packages.map(({ package: item }) => item.order),
    [...plan.packages.map(({ package: item }) => item.order)].sort((left, right) => left - right),
    'release plan package order is invalid',
  );
  for (const item of plan.packages) {
    assert.equal(item.snapshot, plan.snapshot);
  }
}

async function publishOne(registry, plan) {
  const item = plan.package;
  const marker = plan.marker;
  const releaseSha = plan.releaseSha;
  const notes = plan.notes;
  assert.match(releaseSha, /^[0-9a-f]{40}$/);
  assert.match(plan.snapshot, /^[0-9a-f]{40}$/);
  assert.equal(item.id, marker.package);
  assert.deepEqual(
    registry.packages.find(({ id }) => id === item.id),
    item,
    `artifact package configuration conflicts for ${item.id}`,
  );
  const file = assertSafeArtifactName(plan.file, 'tarball filename');
  const tarball = resolve(ARTIFACT_DIRECTORY, file);
  assert.ok(existsSync(tarball), `release tarball is missing: ${file}`);
  assert.equal(packageIntegrity(tarball), plan.integrity, 'release tarball integrity conflicts with plan');
  const packedManifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']));
  assert.equal(packedManifest.name, item.name);
  assert.equal(packedManifest.version, marker.version);
  assert.equal(packedManifest.gitHead, releaseSha, 'release tarball gitHead conflicts with release commit');

  let state = await exactNpmState(registry, item, marker, releaseSha, plan.integrity);
  const delivery = await inspectTagAndRelease(registry, item, marker, releaseSha, notes);
  if (!state.published) {
    assertUnpublishedSnapshot(process.env.GITHUB_SHA, releaseSha, state.published);
    assert.ok(!delivery.ref && !delivery.release, 'tag or GitHub Release exists before npm publication');
    run(
      'npm',
      ['publish', tarball, '--ignore-scripts', '--access', 'public', '--registry', registry.registry, '--provenance'],
      { stdio: 'inherit', env: { ...withoutGithubWriteToken(), ...oidcPublishEnvironment } },
    );
    let lastError;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        state = await exactNpmState(registry, item, marker, releaseSha, plan.integrity);
        if (state.published) {
          lastError = undefined;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    }
    if (lastError) {
      throw lastError;
    }
    assert.equal(state.published, true, 'npm target is not visible with verified provenance; do not republish');
  }
  await ensureTagAndRelease(registry, releaseSha, notes, delivery);
}

function changedFiles(before, after) {
  return git(['diff', '--name-only', before, after]).split('\n').filter(Boolean);
}

function listMarkersAt(snapshot) {
  return git(['ls-tree', '-r', '--name-only', snapshot, '--', '.release/npm']).split('\n').filter(Boolean);
}

async function main() {
  const [command] = process.argv.slice(2);
  const registry = loadRegistry(
    command === 'publish'
      ? (process.env.NPM_RELEASE_REGISTRY ?? resolve(ARTIFACT_DIRECTORY, 'registry.json'))
      : undefined,
  );
  if (command === 'validate-config') {
    const known = new Map(registry.packages.map((item) => [item.id, item]));
    for (const path of listMarkersAt('HEAD')) {
      const match = MARKER_PATTERN.exec(path);
      assert.ok(match && known.has(match[1]), `unknown release marker ${path}`);
      parseMarker(path, known.get(match[1]));
    }
    return;
  }
  assert.ok(['prepare', 'publish'].includes(command), `unknown command ${command}`);
  if (command === 'publish') {
    isolatePublishCredentials();
    const artifactRegistry = readArtifactJson('registry.json');
    assert.deepEqual(artifactRegistry, registry, 'release artifact registry conflicts with embedded configuration');
    const plan = readArtifactJson('plan.json');
    assertReleasePlan(plan, registry, process.env);
    for (const item of plan.packages) {
      await publishOne(registry, item);
    }
    return;
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const snapshot = snapshotSha(process.env.GITHUB_EVENT_NAME, event, process.env.GITHUB_SHA);
  assert.equal(
    process.env.GITHUB_REF,
    `refs/heads/${registry.defaultBranch}`,
    'release must run on the default branch',
  );
  assert.equal(git(['rev-parse', 'HEAD']), snapshot, 'checkout does not match the immutable event snapshot');
  const selected = selectMarkerPaths({
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    snapshot,
    registry,
    listMarkersAt,
    changedFiles,
  });
  const resolved = [];
  for (const entry of selected) {
    resolved.push({ entry, ...(await resolveReleasePr(registry, entry, snapshot)) });
  }
  const groups = new Map();
  for (const item of resolved) {
    const existing = groups.get(item.pr.number);
    if (existing) {
      assert.deepEqual(existing.batchEntries, item.batchEntries, 'PR marker batch changed between lookups');
      existing.current.push(item);
    } else {
      groups.set(item.pr.number, { ...item, current: [item] });
    }
  }
  for (const group of groups.values()) {
    assertReleasePr({
      pr: { ...group.pr, merged: group.pr.merged_at !== null },
      files: group.files,
      batchEntries: group.batchEntries,
      branch: registry.defaultBranch,
    });
  }
  const ordered = resolved.sort((left, right) => left.entry.package.order - right.entry.package.order);
  assert.ok(ordered.length > 0, 'event selected no release markers');
  rmSync(ARTIFACT_DIRECTORY, { recursive: true, force: true });
  mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
  const packages = [];
  for (const item of ordered) {
    packages.push(await prepareOne(registry, item.entry, item.releaseSha, snapshot, ARTIFACT_DIRECTORY));
  }
  writeArtifactJson('registry.json', registry);
  writeArtifactJson('plan.json', {
    schemaVersion: 1,
    repository: registry.repository,
    workflowPath: registry.workflowPath,
    eventName: process.env.GITHUB_EVENT_NAME,
    snapshot,
    ref: process.env.GITHUB_REF,
    packages,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
