import type { AgentRun } from '../agent/types.js';

export interface RunTimeoutHandle {
  clear(): void;
  touch(): void;
}

/** Stops a running Pi child only after a bounded interval without bridge events. */
export function stopAfterIdle(run: AgentRun, minutes: number, onTimeout?: () => void): RunTimeoutHandle {
  const timeoutMs = Math.max(1, minutes) * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      onTimeout?.();
      void run.stop('timeout');
    }, timeoutMs);
    timer.unref();
  };
  arm();
  return {
    touch: arm,
    clear: () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = undefined;
    },
  };
}
