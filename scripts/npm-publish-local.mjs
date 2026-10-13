#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_PACKAGE_DIRECTORY = 'apps/lark-pi-bridge';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHANGELOG_START = '<!-- npm-release:start -->';
const CHANGELOG_END = '<!-- npm-release:end -->';
export const REGISTRY_WAIT_DELAYS = [
  0, 2_000, 5_000, 10_000, 15_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
];

class ReleaseError extends Error {}

function fail(message) {
  throw new ReleaseError(message);
}

function cleanChildEnvironment(extra = {}, { preserveUserConfig = false } = {}) {
  const environment = { ...process.env };
  delete environment.NODE_AUTH_TOKEN;
  delete environment.NPM_CONFIG__AUTH;
  delete environment.npm_config__auth;
  delete environment.NPM_CONFIG_USERCONFIG;
  delete environment.npm_config_userconfig;
  delete environment.NPM_TOKEN;
  if (!preserveUserConfig) {
    environment.NPM_CONFIG_USERCONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';
  }
  Object.assign(environment, extra);
  return environment;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: 'utf8',
    env: options.env ?? cleanChildEnvironment(),
    stdio: options.stdio ?? 'pipe',
    timeout: options.timeout,
  });

  if (result.error && !options.allowProcessError) {
    fail(`无法执行 ${command}: ${result.error.message}`);
  }

  return result;
}

function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} 执行失败${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

export function parseEnv(text) {
  const values = new Map();

  for (const [index, originalLine] of text.split(/\r?\n/).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      fail(`.env 第 ${index + 1} 行格式无效`);
    }

    const [, name, rawValue] = match;
    if (values.has(name)) {
      fail(`.env 中存在重复变量 ${name}`);
    }

    let value = rawValue;
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }

  return values;
}

export function extractReleaseNotes(readme, version) {
  const start = readme.indexOf(CHANGELOG_START);
  const end = readme.indexOf(CHANGELOG_END);
  if (start < 0 || end < 0 || end <= start) {
    fail('README 缺少有效的 npm release Changelog 标记');
  }

  const releaseSection = readme.slice(start + CHANGELOG_START.length, end);
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^### \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'gm');
  const headings = [...releaseSection.matchAll(headingPattern)];
  if (headings.length !== 1) {
    fail(`README Changelog 必须恰好包含一个 ${version} 条目，当前为 ${headings.length} 个`);
  }

  const heading = headings[0];
  const notesStart = heading.index;
  const nextHeading = releaseSection.indexOf('\n### ', notesStart + heading[0].length);
  const notes = releaseSection.slice(notesStart, nextHeading < 0 ? undefined : nextHeading).trim();
  if (!/^#### (Added|Changed|Fixed|Security|Deprecated|Removed)$/m.test(notes)) {
    fail(`${version} Changelog 没有有效的变更分类`);
  }

  const unreleasedHeading = /^### Unreleased\s*$/m.exec(releaseSection);
  if (unreleasedHeading) {
    const unreleasedStart = unreleasedHeading.index + unreleasedHeading[0].length;
    const nextRelease = releaseSection.indexOf('\n### ', unreleasedStart);
    const unreleasedBody = releaseSection.slice(unreleasedStart, nextRelease < 0 ? undefined : nextRelease);
    if (unreleasedBody.replace(/<!--[^]*?-->/g, '').trim()) {
      fail('README Changelog 仍有非空的 Unreleased 内容');
    }
  }

  return `${notes}\n`;
}

export function expectedDigests(buffer) {
  return {
    integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
    shasum: createHash('sha1').update(buffer).digest('hex'),
  };
}

export function assertRegistryMatches(metadata, expected) {
  if (metadata.version !== expected.version) {
    fail(`registry 版本冲突：期望 ${expected.version}，实际 ${String(metadata.version)}`);
  }
  if (metadata.dist?.integrity !== expected.integrity) {
    fail(`registry integrity 与本地 tarball 不一致：${expected.name}@${expected.version}`);
  }
  if (metadata.dist?.shasum !== expected.shasum) {
    fail(`registry shasum 与本地 tarball 不一致：${expected.name}@${expected.version}`);
  }
  if (expected.gitHead && metadata.gitHead !== expected.gitHead) {
    fail(`registry gitHead 与发布 commit 不一致：${expected.name}@${expected.version}`);
  }
}

function loadToken() {
  const envPath = join(REPOSITORY_ROOT, '.env');
  let stats;
  try {
    stats = lstatSync(envPath);
  } catch {
    fail('仓库根目录缺少 .env；请复制 .env.example 并填写 NPM_TOKEN');
  }

  if (!stats.isFile() || stats.isSymbolicLink()) {
    fail('.env 必须是普通文件，不能是符号链接');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    fail('.env 权限过宽；请执行 chmod 600 .env');
  }

  const token = parseEnv(readFileSync(envPath, 'utf8')).get('NPM_TOKEN');
  if (!token || !token.startsWith('npm_')) {
    fail('.env 中缺少有效的 NPM_TOKEN');
  }
  return token;
}

function createNpmConfig() {
  const directory = mkdtempSync(join(tmpdir(), 'mlzwl-npm-release-'));
  const npmrc = join(directory, 'npmrc');
  writeFileSync(
    npmrc,
    `registry=${REGISTRY}/\n@mlzwl:registry=${REGISTRY}/\n//registry.npmjs.org/:_authToken=\${NPM_TOKEN}\n`,
    { mode: 0o600 },
  );
  chmodSync(npmrc, 0o600);
  return { directory, npmrc };
}

function verifyIdentity(token) {
  const temporary = createNpmConfig();
  try {
    const environment = cleanChildEnvironment(
      {
        NPM_CONFIG_USERCONFIG: temporary.npmrc,
        NPM_TOKEN: token,
      },
      { preserveUserConfig: true },
    );
    const identity = runChecked('npm', ['whoami', `--registry=${REGISTRY}`], { env: environment });
    if (identity !== 'mlzwl') {
      fail(`npm token 对应账号为 ${identity || '<empty>'}，期望 mlzwl`);
    }
    return { environment, identity, cleanup: () => rmSync(temporary.directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(temporary.directory, { recursive: true, force: true });
    throw error;
  }
}

function resolvePackageDirectory(input) {
  const directory = resolve(REPOSITORY_ROOT, input ?? DEFAULT_PACKAGE_DIRECTORY);
  const relativePath = relative(REPOSITORY_ROOT, directory);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    fail('包目录必须位于仓库内部');
  }
  return directory;
}

function readPackage(packageDirectory) {
  const manifestPath = join(packageDirectory, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`无法读取 ${relative(REPOSITORY_ROOT, manifestPath)}: ${error.message}`);
  }

  if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@mlzwl/')) {
    fail('只允许发布 @mlzwl scope 下的包');
  }
  if (typeof manifest.version !== 'string' || !STABLE_SEMVER.test(manifest.version)) {
    fail(`只允许发布 stable SemVer，当前为 ${String(manifest.version)}`);
  }
  if (manifest.publishConfig?.registry !== REGISTRY || manifest.publishConfig?.access !== 'public') {
    fail('package.json publishConfig 必须固定为公共 npm registry 和 public access');
  }

  const readmePath = join(packageDirectory, 'README.md');
  const notes = extractReleaseNotes(readFileSync(readmePath, 'utf8'), manifest.version);
  return { manifest, notes };
}

function verifyGitState() {
  const root = runChecked('git', ['rev-parse', '--show-toplevel']);
  if (resolve(root) !== REPOSITORY_ROOT) {
    fail(`脚本所在仓库与当前 Git 仓库不一致：${root}`);
  }

  const origin = runChecked('git', ['remote', 'get-url', 'origin']);
  if (!/^(?:git@github\.com:|https:\/\/github\.com\/)chenerzhang\/mlzwl(?:\.git)?$/.test(origin)) {
    fail(`origin 不是预期的 GitHub 仓库：${origin}`);
  }

  const status = runChecked('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) {
    fail(`发布要求工作区干净，当前存在改动：\n${status}`);
  }

  const branch = runChecked('git', ['branch', '--show-current']);
  if (branch !== 'master') {
    fail(`发布必须从 master 执行，当前分支为 ${branch || '<detached>'}`);
  }

  const head = runChecked('git', ['rev-parse', 'HEAD']);
  const remoteOutput = runChecked('git', ['ls-remote', '--heads', 'origin', 'refs/heads/master']);
  const remoteHead = remoteOutput.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(remoteHead)) {
    fail('无法解析远端 master SHA');
  }
  if (head !== remoteHead) {
    fail(`本地 master (${head}) 与远端 master (${remoteHead}) 不一致`);
  }
  return head;
}

function packOnce(packageDirectory, destination, ignoreScripts) {
  const args = ['pack', packageDirectory, '--pack-destination', destination];
  if (ignoreScripts) {
    args.push('--ignore-scripts');
  }
  const result = run('npm', args, { env: cleanChildEnvironment() });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`npm pack 失败${detail ? `:\n${detail}` : ''}`);
  }

  const tarballs = readdirSync(destination).filter((file) => file.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    fail(`npm pack 应生成一个 tarball，实际为 ${tarballs.length} 个`);
  }
  return join(destination, tarballs[0]);
}

function packPackage(packageDirectory, gitHead) {
  if (!gitHead) {
    fail('打包发布产物前必须确认 master commit SHA');
  }
  const directory = mkdtempSync(join(tmpdir(), 'mlzwl-npm-pack-'));
  try {
    const initialDirectory = join(directory, 'initial');
    const unpackedDirectory = join(directory, 'unpacked');
    const finalDirectory = join(directory, 'final');
    mkdirSync(initialDirectory);
    mkdirSync(unpackedDirectory);
    mkdirSync(finalDirectory);

    const initialTarball = packOnce(packageDirectory, initialDirectory, false);
    runChecked('tar', ['-xzf', initialTarball, '-C', unpackedDirectory]);
    const unpackedPackage = join(unpackedDirectory, 'package');
    const manifestPath = join(unpackedPackage, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.gitHead && manifest.gitHead !== gitHead) {
      fail(`打包产物包含冲突的 gitHead：${manifest.gitHead}`);
    }
    manifest.gitHead = gitHead;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const generatedTarball = packOnce(unpackedPackage, finalDirectory, true);
    const tarball = join(directory, basename(generatedTarball));
    renameSync(generatedTarball, tarball);
    const buffer = readFileSync(tarball);
    return { directory, tarball, ...expectedDigests(buffer) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function fetchRegistryJson(url, allowNotFound = false) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'mlzwl-local-release' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`读取 npm registry 失败：${error.message}`);
  }

  if (allowNotFound && response.status === 404) {
    return null;
  }
  if (!response.ok) {
    fail(`读取 npm registry 失败：HTTP ${response.status}`);
  }
  return response.json();
}

async function readPublishedVersion(name, version) {
  const encodedName = encodeURIComponent(name);
  const encodedVersion = encodeURIComponent(version);
  return fetchRegistryJson(`${REGISTRY}/${encodedName}/${encodedVersion}`, true);
}

async function readLatest(name) {
  const metadata = await fetchRegistryJson(`${REGISTRY}/${encodeURIComponent(name)}`);
  return metadata['dist-tags']?.latest;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForPublishedVersion(expected) {
  let matchingMetadata = null;
  let latest;
  for (const delay of REGISTRY_WAIT_DELAYS) {
    if (delay > 0) {
      await sleep(delay);
    }
    const metadata = await readPublishedVersion(expected.name, expected.version);
    if (!metadata) {
      continue;
    }

    assertRegistryMatches(metadata, expected);
    matchingMetadata = metadata;
    latest = await readLatest(expected.name);
    if (latest === expected.version) {
      return metadata;
    }
  }

  if (matchingMetadata) {
    fail(`版本已完整可见，但 latest 仍为 ${String(latest)}；不要重复 publish`);
  }
  return null;
}

async function prepare(packageInput, requireGit) {
  const packageDirectory = resolvePackageDirectory(packageInput);
  const head = requireGit ? verifyGitState() : null;
  const { manifest, notes } = readPackage(packageDirectory);
  const packed = packPackage(packageDirectory, head);
  const expected = {
    name: manifest.name,
    version: manifest.version,
    integrity: packed.integrity,
    shasum: packed.shasum,
    gitHead: head,
  };
  const published = await readPublishedVersion(expected.name, expected.version);
  return { packageDirectory, manifest, notes, packed, expected, published, head };
}

function printPrepared(prepared, state) {
  console.log(`package=${prepared.expected.name}`);
  console.log(`version=${prepared.expected.version}`);
  console.log(`integrity=${prepared.expected.integrity}`);
  console.log(`shasum=${prepared.expected.shasum}`);
  if (prepared.head) {
    console.log(`git_head=${prepared.head}`);
  }
  console.log(`registry_state=${state}`);
}

async function authCheck() {
  const token = loadToken();
  const auth = verifyIdentity(token);
  try {
    console.log(`npm_auth=ok`);
    console.log(`npm_identity=${auth.identity}`);
  } finally {
    auth.cleanup();
  }
}

async function preflight(packageInput) {
  const prepared = await prepare(packageInput, true);
  try {
    if (prepared.published) {
      fail(`${prepared.expected.name}@${prepared.expected.version} 已存在；拒绝重复 publish`);
    }
    const token = loadToken();
    const auth = verifyIdentity(token);
    auth.cleanup();
    printPrepared(prepared, 'unpublished');
  } finally {
    rmSync(prepared.packed.directory, { recursive: true, force: true });
  }
}

async function publish(packageInput) {
  const prepared = await prepare(packageInput, true);
  try {
    if (prepared.published) {
      fail(`${prepared.expected.name}@${prepared.expected.version} 已存在；拒绝重复 publish`);
    }

    const token = loadToken();
    const auth = verifyIdentity(token);
    let publishResult;
    try {
      const confirmedHead = verifyGitState();
      if (confirmedHead !== prepared.head) {
        fail(`打包后 HEAD 已变化：${prepared.head} -> ${confirmedHead}`);
      }
      publishResult = run(
        'npm',
        ['publish', prepared.packed.tarball, '--ignore-scripts', '--access', 'public', `--registry=${REGISTRY}`],
        {
          env: auth.environment,
          stdio: 'inherit',
          timeout: 10 * 60_000,
          allowProcessError: true,
        },
      );
    } finally {
      auth.cleanup();
    }

    const published = await waitForPublishedVersion(prepared.expected);
    if (!published) {
      const result = publishResult?.error
        ? '超时或执行异常'
        : publishResult?.status === 0
          ? '返回成功'
          : `退出码 ${String(publishResult?.status)}`;
      fail(`npm publish ${result}，但目标版本仍不可见；结果不明确，不要重复 publish`);
    }

    if (publishResult.status !== 0) {
      console.warn(`npm publish 返回退出码 ${publishResult.status}，但 registry 已确认目标版本完整可见`);
    }
    printPrepared(prepared, 'published');
  } finally {
    rmSync(prepared.packed.directory, { recursive: true, force: true });
  }
}

function usage() {
  console.log(`Usage:
  node scripts/npm-publish-local.mjs auth-check
  node scripts/npm-publish-local.mjs preflight [package-directory]
  node scripts/npm-publish-local.mjs publish [package-directory]

The package directory defaults to ${DEFAULT_PACKAGE_DIRECTORY}.`);
}

async function main() {
  const [command, packageDirectory, ...extra] = process.argv.slice(2);
  if (extra.length > 0) {
    fail('参数过多');
  }

  switch (command) {
    case 'auth-check':
      if (packageDirectory) {
        fail('auth-check 不接受包目录参数');
      }
      await authCheck();
      break;
    case 'preflight':
      await preflight(packageDirectory);
      break;
    case 'publish':
      await publish(packageDirectory);
      break;
    case '--help':
    case '-h':
    case undefined:
      usage();
      break;
    default:
      fail(`未知命令：${command}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  });
}
