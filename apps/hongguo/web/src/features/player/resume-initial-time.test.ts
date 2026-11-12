import { describe, expect, it } from 'vitest';
import { resolveInitialTime } from './resume-initial-time';

describe('resolveInitialTime', () => {
  it('freezes the first position while the same episode keeps reporting progress', () => {
    const first = resolveInitialTime(
      undefined,
      { episodeId: 'episode-1', position: 42, completed: false },
      'episode-1',
    );
    const updated = resolveInitialTime(first, { episodeId: 'episode-1', position: 43, completed: false }, 'episode-1');

    expect(first.initialTime).toBe(42);
    expect(updated).toBe(first);
    expect(updated.initialTime).toBe(42);
  });

  it('captures the new position after switching episodes', () => {
    const first = resolveInitialTime(
      undefined,
      { episodeId: 'episode-1', position: 42, completed: false },
      'episode-1',
    );
    const second = resolveInitialTime(first, { episodeId: 'episode-2', position: 18, completed: false }, 'episode-2');

    expect(second).toEqual({ episodeId: 'episode-2', initialTime: 18 });
  });

  it('does not resume completed or barely started episodes', () => {
    expect(
      resolveInitialTime(undefined, { episodeId: 'episode-1', position: 42, completed: true }, 'episode-1').initialTime,
    ).toBeUndefined();
    expect(
      resolveInitialTime(undefined, { episodeId: 'episode-1', position: 3, completed: false }, 'episode-1').initialTime,
    ).toBeUndefined();
  });
});
