import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

/**
 * Return an OS-observed process start token. Comparing this token as well as
 * the PID prevents stale state from targeting an unrelated process after PID
 * reuse. Failure is intentionally reported as undefined so callers fail safe.
 */
export async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 2_000 },
      );
      const startedAt = stdout.trim();
      return startedAt ? { pid, startedAt } : undefined;
    }
    const ps = process.platform === 'darwin' ? '/bin/ps' : 'ps';
    const { stdout } = await execFileAsync(ps, ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    const startedAt = stdout.trim().replace(/\s+/g, ' ');
    return startedAt ? { pid, startedAt } : undefined;
  } catch {
    return undefined;
  }
}

export function sameProcessIdentity(left: ProcessIdentity, right: ProcessIdentity | undefined): boolean {
  return Boolean(right && left.pid === right.pid && left.startedAt === right.startedAt);
}
