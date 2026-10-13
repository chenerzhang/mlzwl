import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETRY_WINDOW_MS = 30 * 60_000;
export const CONNECTION_STABLE_RESET_MS = 2 * 60_000;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;

interface RetryState {
  failures: number;
  lastFailureAt: number;
}

/**
 * Apply a small persisted exponential delay before a service generation starts.
 * This complements launchd/systemd restart policy without turning a network
 * outage into a tight process restart loop.
 */
export async function waitForConnectionRetryWindow(
  path: string,
  options: { now?: () => number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const state = await readRetryState(path);
  if (!state || now() - state.lastFailureAt > RETRY_WINDOW_MS) {
    await rm(path, { force: true });
    return 0;
  }
  const delay = RETRY_DELAYS_MS[Math.min(state.failures - 1, RETRY_DELAYS_MS.length - 1)]!;
  const remaining = Math.max(0, state.lastFailureAt + delay - now());
  if (remaining > 0) {
    await sleep(remaining);
  }
  return remaining;
}

export async function recordConnectionFailure(path: string, at = Date.now()): Promise<number> {
  const previous = await readRetryState(path);
  const failures = previous && at - previous.lastFailureAt <= RETRY_WINDOW_MS ? previous.failures + 1 : 1;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ failures, lastFailureAt: at })}\n`, { mode: 0o600 });
  return failures;
}

export async function clearConnectionFailuresAfterStableConnection(
  path: string,
  connectedAt: number,
  now = Date.now(),
): Promise<void> {
  if (now - connectedAt >= CONNECTION_STABLE_RESET_MS) {
    await rm(path, { force: true });
  }
}

async function readRetryState(path: string): Promise<RetryState | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<RetryState>;
    if (
      !Number.isSafeInteger(raw.failures) ||
      Number(raw.failures) < 1 ||
      typeof raw.lastFailureAt !== 'number' ||
      !Number.isFinite(raw.lastFailureAt) ||
      raw.lastFailureAt < 0
    ) {
      await rm(path, { force: true });
      return undefined;
    }
    return raw as RetryState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    await rm(path, { force: true });
    return undefined;
  }
}
