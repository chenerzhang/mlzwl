import type { ChildProcess, ChildProcessByStdio, SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import crossSpawn from 'cross-spawn';

export function spawnProcess(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  return crossSpawn(command, [...args], options);
}

/**
 * Spawn a child with a private file-creation mask without changing the bridge
 * process's global umask. macOS is the validated production platform; Windows
 * keeps the direct-spawn compatibility path and is not claimed as validated.
 */
export function spawnProcessPrivate(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  if (process.platform === 'win32') {
    return spawnProcess(command, args, options);
  }
  return crossSpawn('/bin/sh', ['-c', 'umask 077; exec "$@"', 'lark-pi-bridge-child', command, ...args], options);
}

export type SpawnedProcessByStdio<
  Stdin extends Writable | null,
  Stdout extends Readable | null,
  Stderr extends Readable | null,
> = ChildProcessByStdio<Stdin, Stdout, Stderr>;
