import fs from 'node:fs';
import path from 'node:path';
import { dataDir, runtimeDir } from '../config/env.js';
import { logFile } from '../logging/jsonl.js';

export type RuntimePaths = {
  dataDir: string;
  runtimeDir: string;
  socketPath: string;
  lockPath: string;
  logPath: string;
  stderrPath: string;
  cacheDir: string;
  stateDir: string;
};

export function getRuntimePaths(): RuntimePaths {
  const data = dataDir();
  const runtime = runtimeDir();
  return {
    dataDir: data,
    runtimeDir: runtime,
    socketPath: path.join(runtime, 'x-adapter.sock'),
    lockPath: path.join(runtime, 'x-adapter.lock'),
    logPath: logFile(),
    stderrPath: path.join(path.dirname(logFile()), 'x-adapter.stderr.log'),
    cacheDir: path.join(data, 'cache'),
    stateDir: path.join(data, 'state'),
  };
}

export function ensureRuntimePaths(): RuntimePaths {
  const paths = getRuntimePaths();
  for (const directory of [
    paths.dataDir,
    paths.runtimeDir,
    path.dirname(paths.logPath),
    paths.cacheDir,
    paths.stateDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }
  return paths;
}
