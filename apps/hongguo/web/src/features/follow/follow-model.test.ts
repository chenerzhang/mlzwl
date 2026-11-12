import type { FollowRecord } from '@mlzwl/hongguo-shared';
import { describe, expect, it } from 'vitest';
import {
  confirmEpisodes,
  hasUpdates,
  mergeKnownEpisodes,
  newEpisodes,
  nextFollowState,
  FOLLOW_STATE_LABELS,
} from './follow-model';

/**
 * 追更纯逻辑测试（P1-8 / P1-9）。
 *
 * 不引入 jsdom：被测模块 import 期不访问 `window`，`FollowRecord` 是 type-only
 * 导入，zod 不会进测试进程。
 */

function makeRecord(overrides: Partial<FollowRecord> = {}): FollowRecord {
  return {
    seriesId: 's1',
    seriesTitle: '测试剧',
    state: 'watching',
    knownEpisodes: 104,
    confirmedEpisodes: 100,
    checkedAt: 1_000,
    ...overrides,
  };
}

describe('newEpisodes', () => {
  it('returns the difference when upstream is ahead', () => {
    expect(newEpisodes({ knownEpisodes: 104, confirmedEpisodes: 100 })).toBe(4);
  });

  it('never goes negative when confirmed is ahead of known', () => {
    expect(newEpisodes({ knownEpisodes: 100, confirmedEpisodes: 104 })).toBe(0);
    expect(newEpisodes({ knownEpisodes: 0, confirmedEpisodes: 0 })).toBe(0);
  });

  it('reports updates only when the count is positive', () => {
    expect(hasUpdates({ knownEpisodes: 104, confirmedEpisodes: 100 })).toBe(true);
    expect(hasUpdates({ knownEpisodes: 104, confirmedEpisodes: 104 })).toBe(false);
    expect(hasUpdates({ knownEpisodes: 100, confirmedEpisodes: 104 })).toBe(false);
  });
});

describe('mergeKnownEpisodes', () => {
  it('raises the high-water mark when upstream grows', () => {
    const merged = mergeKnownEpisodes(makeRecord({ knownEpisodes: 104 }), 110, 2_000);
    expect(merged.knownEpisodes).toBe(110);
    expect(merged.checkedAt).toBe(2_000);
  });

  it('keeps the old high-water mark when upstream reports fewer episodes', () => {
    const record = makeRecord({ knownEpisodes: 104, checkedAt: 1_000 });
    const merged = mergeKnownEpisodes(record, 90, 2_000);
    expect(merged.knownEpisodes).toBe(104);
    // 没有新信息就不该刷新 `checkedAt`，否则「上次对账时间」会被空跑覆盖。
    expect(merged.checkedAt).toBe(1_000);
    expect(merged).toBe(record);
  });

  it('keeps the old checkedAt when the clock goes backwards', () => {
    const merged = mergeKnownEpisodes(makeRecord({ knownEpisodes: 104, checkedAt: 5_000 }), 110, 4_000);
    expect(merged.knownEpisodes).toBe(110);
    expect(merged.checkedAt).toBe(5_000);
  });

  it('ignores invalid upstream values instead of corrupting the record', () => {
    const record = makeRecord();
    expect(mergeKnownEpisodes(record, Number.NaN, 2_000)).toBe(record);
    expect(mergeKnownEpisodes(record, -1, 2_000)).toBe(record);
    expect(mergeKnownEpisodes(record, Number.POSITIVE_INFINITY, 2_000)).toBe(record);
  });

  it('floors fractional upstream counts', () => {
    expect(mergeKnownEpisodes(makeRecord({ knownEpisodes: 10 }), 12.9, 2_000).knownEpisodes).toBe(12);
  });

  it('returns the same object when nothing changed', () => {
    const record = makeRecord({ knownEpisodes: 104, checkedAt: 2_000 });
    expect(mergeKnownEpisodes(record, 104, 2_000)).toBe(record);
  });

  it('never touches state or confirmedEpisodes', () => {
    const merged = mergeKnownEpisodes(makeRecord(), 200, 2_000);
    expect(merged.state).toBe('watching');
    expect(merged.confirmedEpisodes).toBe(100);
  });
});

describe('confirmEpisodes', () => {
  it('raises confirmedEpisodes monotonically', () => {
    expect(confirmEpisodes(makeRecord({ confirmedEpisodes: 10 }), 20).confirmedEpisodes).toBe(20);
  });

  it('ignores a smaller value (high-water mark)', () => {
    const record = makeRecord({ confirmedEpisodes: 20 });
    expect(confirmEpisodes(record, 5)).toBe(record);
  });

  it('clamps to knownEpisodes', () => {
    expect(confirmEpisodes(makeRecord({ knownEpisodes: 12, confirmedEpisodes: 3 }), 99).confirmedEpisodes).toBe(12);
  });

  it('ignores invalid input', () => {
    const record = makeRecord({ confirmedEpisodes: 3 });
    expect(confirmEpisodes(record, Number.NaN)).toBe(record);
  });

  it('leaves newEpisodes at zero once everything is confirmed', () => {
    const confirmed = confirmEpisodes(makeRecord({ knownEpisodes: 104, confirmedEpisodes: 100 }), 104);
    expect(newEpisodes(confirmed)).toBe(0);
  });
});

describe('nextFollowState', () => {
  it('cycles through the three states and then clears', () => {
    expect(nextFollowState(undefined)).toBe('planned');
    expect(nextFollowState('planned')).toBe('watching');
    expect(nextFollowState('watching')).toBe('watched');
    expect(nextFollowState('watched')).toBeUndefined();
  });

  it('covers every state so a new state cannot be silently skipped', () => {
    for (const state of ['planned', 'watching', 'watched'] as const) {
      expect(FOLLOW_STATE_LABELS[state]).toBeTruthy();
    }
  });
});
