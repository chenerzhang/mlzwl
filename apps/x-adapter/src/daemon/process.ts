import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Confirms the lock owner is this package's detached daemon before any
 * automatic lifecycle recovery sends it a signal. On platforms where command
 * line inspection is unavailable, recovery remains manual and non-destructive.
 */
export async function isXAdapterDaemonProcess(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    return false;
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /(?:@mlzwl\/x-adapter|apps\/x-adapter)\/dist\/bin\/index\.js\b[\s\S]*\b__daemon__\b/.test(stdout);
  } catch {
    return false;
  }
}
