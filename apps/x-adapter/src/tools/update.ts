import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PACKAGE_NAME, VERSION } from '../config/env.js';
import { getDaemonStatus, startDaemon, stopDaemon } from '../daemon/lifecycle.js';

const execFileAsync = promisify(execFile);
const REGISTRY = 'https://registry.npmjs.org';

export type NpmRunner = (args: string[]) => Promise<{ stdout: string; stderr?: string }>;

export type DaemonController = {
  getDaemonStatus: () => Promise<{ healthy?: boolean }>;
  stopDaemon: () => Promise<unknown>;
  startDaemon: (scriptPath: string) => Promise<unknown>;
};

export type UpdateCheck = {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  installCommand?: string[];
};

export type UpdateResult = UpdateCheck & {
  status: 'up_to_date' | 'updated' | 'check_failed' | 'update_failed' | 'restart_failed';
  restarted?: boolean;
  error?: string;
};

export async function resolveGlobalBin(npm: NpmRunner = defaultNpm): Promise<string> {
  const { stdout } = await npm(['root', '-g']);
  const root = stdout.trim();
  if (!root) {
    throw new Error('npm root -g returned no directory');
  }
  const packageDir = path.resolve(root, PACKAGE_NAME);
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const binEntry = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.['x-adapter'];
  if (!binEntry) {
    throw new Error('installed x-adapter package has no x-adapter bin entry');
  }
  const binPath = path.resolve(packageDir, binEntry);
  if (binPath !== packageDir && !binPath.startsWith(`${packageDir}${path.sep}`)) {
    throw new Error('installed x-adapter bin resolves outside its package directory');
  }
  return fs.realpathSync(binPath);
}

function compareSemver(left: string, right: string): number | null {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value);
    return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4] ?? '' } : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) {
      return Math.sign(a.numbers[index] - b.numbers[index]);
    }
  }
  if (a.pre === b.pre) {
    return 0;
  }
  if (!a.pre) {
    return 1;
  }
  if (!b.pre) {
    return -1;
  }
  return a.pre < b.pre ? -1 : 1;
}

async function defaultNpm(args: string[]): Promise<{ stdout: string; stderr?: string }> {
  return execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { encoding: 'utf8' });
}

export async function checkForUpdate(npm: NpmRunner = defaultNpm): Promise<UpdateCheck> {
  const { stdout } = await npm(['view', `${PACKAGE_NAME}@latest`, 'version', '--registry', REGISTRY]);
  const latestVersion = stdout.trim();
  const comparison = compareSemver(latestVersion, VERSION);
  return {
    currentVersion: VERSION,
    latestVersion,
    updateAvailable: comparison !== null && comparison > 0,
    installCommand: [
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      'install',
      '-g',
      `${PACKAGE_NAME}@latest`,
      '--registry',
      REGISTRY,
    ],
  };
}

export async function runUpdate(
  options: {
    npm?: NpmRunner;
    scriptPath?: string;
    daemon?: DaemonController;
    resolveBin?: (npm: NpmRunner) => Promise<string>;
  } = {},
): Promise<UpdateResult> {
  const npm = options.npm ?? defaultNpm;
  let check: UpdateCheck;
  try {
    check = await checkForUpdate(npm);
  } catch (error) {
    return { currentVersion: VERSION, updateAvailable: false, status: 'check_failed', error: errorMessage(error) };
  }
  if (!check.updateAvailable) {
    return { ...check, status: 'up_to_date' };
  }

  const daemon = options.daemon ?? { getDaemonStatus, stopDaemon, startDaemon };
  const wasRunning = await daemon.getDaemonStatus().then(
    (status) => status.healthy === true,
    () => false,
  );
  try {
    await npm(['install', '-g', `${PACKAGE_NAME}@latest`, '--registry', REGISTRY]);
  } catch (error) {
    return { ...check, status: 'update_failed', error: errorMessage(error) };
  }
  if (!wasRunning) {
    return { ...check, status: 'updated' };
  }

  try {
    const nextScriptPath = options.scriptPath ?? (await (options.resolveBin ?? resolveGlobalBin)(npm));
    await daemon.stopDaemon();
    await daemon.startDaemon(nextScriptPath);
    return { ...check, status: 'updated', restarted: true };
  } catch (error) {
    return { ...check, status: 'restart_failed', error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
