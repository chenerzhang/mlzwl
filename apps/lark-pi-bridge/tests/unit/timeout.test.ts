import { describe, expect, it, vi } from 'vitest';
import { stopAfterIdle } from '../../src/runtime/timeout.js';

describe('idle timeout', () => {
  it('stops the child with the timeout reason only after inactivity', () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    const handle = stopAfterIdle(
      {
        runId: 'run',
        events: { async *[Symbol.asyncIterator]() {} },
        stop,
        async waitForExit() {
          return true;
        },
      },
      1,
    );
    vi.advanceTimersByTime(30_000);
    handle.touch();
    vi.advanceTimersByTime(30_000);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(stop).toHaveBeenCalledWith('timeout');
    handle.clear();
    vi.useRealTimers();
  });
});
