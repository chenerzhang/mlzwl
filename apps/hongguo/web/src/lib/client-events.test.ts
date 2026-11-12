import { describe, expect, it } from 'vitest';
import { apiErrorDetail, CLIENT_EVENT_LIMIT, record, snapshot, stripQuery } from './client-events';

/**
 * 前端事件环形缓冲的纯逻辑测试。
 *
 * 不引入 jsdom：被测模块 import 期只建一个数组，不访问 `window` / `document`。
 *
 * 缓冲是模块级单例，用例之间会共享状态，所以**不假设起始为空**：每个用例都写入
 * `CLIENT_EVENT_LIMIT` 条以上，让旧内容一定被挤出，再按「最后 N 条」断言。
 * 这样既不需要为测试加 `reset()` 导出，也不依赖用例执行顺序。
 */

/** 写满缓冲并返回自己刚写入的 detail 序列。 */
function fill(count: number, prefix = 'd'): string[] {
  const details: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const detail = `${prefix}${index}`;
    details.push(detail);
    record({ kind: 'api-error', detail });
  }
  return details;
}

describe('record / snapshot', () => {
  it('keeps insertion order', () => {
    const written = fill(CLIENT_EVENT_LIMIT);
    // 只看刚写入的尾部：前面的内容是其他用例留下的，与顺序无关。
    expect(
      snapshot()
        .slice(-written.length)
        .map((event) => event.detail),
    ).toEqual(written);
  });

  it('drops the oldest event once the ring is full', () => {
    const first = fill(CLIENT_EVENT_LIMIT, 'old');
    expect(snapshot()).toHaveLength(CLIENT_EVENT_LIMIT);
    expect(snapshot()[0]?.detail).toBe(first[0]);

    record({ kind: 'api-error', detail: 'newest' });
    const events = snapshot();
    expect(events).toHaveLength(CLIENT_EVENT_LIMIT);
    // 最旧的一条被挤掉：首条变成第二批的第一条，末条是新写入的。
    expect(events[0]?.detail).toBe(first[1]);
    expect(events[events.length - 1]?.detail).toBe('newest');
  });

  it('does not grow past the limit even after many writes', () => {
    fill(CLIENT_EVENT_LIMIT * 3);
    expect(snapshot()).toHaveLength(CLIENT_EVENT_LIMIT);
  });

  it('returns a copy so callers cannot mutate the buffer', () => {
    record({ kind: 'api-error', detail: 'copy-marker' });
    // 快照类型是只读的；测试里显式转型去模拟「调用方硬改」。
    const tampered = snapshot() as Array<{ kind: string; detail: string }>;
    tampered.push({ kind: 'x', detail: 'y' });
    for (const event of tampered) {
      event.detail = 'tampered';
    }

    const events = snapshot();
    expect(events).toHaveLength(CLIENT_EVENT_LIMIT);
    expect(events[events.length - 1]?.detail).toBe('copy-marker');
    expect(events.some((event) => event.detail === 'tampered')).toBe(false);
  });

  it('truncates an oversized detail', () => {
    record({ kind: 'api-error', detail: 'x'.repeat(4096) });
    const events = snapshot();
    const detail = events[events.length - 1]?.detail ?? '';
    expect(detail.length).toBeLessThanOrEqual(513);
    expect(detail.endsWith('…')).toBe(true);
  });
});

describe('stripQuery', () => {
  it('drops everything from the first question mark', () => {
    expect(stripQuery('/api/search?keyword=秘密&cursor=abc')).toBe('/api/search');
    expect(stripQuery('/api/episodes/ep1/playback?definition=hd')).toBe('/api/episodes/ep1/playback');
  });

  it('leaves a query-free path untouched', () => {
    expect(stripQuery('/api/feed')).toBe('/api/feed');
  });

  it('handles an empty query', () => {
    expect(stripQuery('/api/feed?')).toBe('/api/feed');
  });
});

describe('apiErrorDetail', () => {
  it('never includes the query string', () => {
    expect(apiErrorDetail('/api/search?keyword=秘密', 502, 'search_failed')).toBe('/api/search 502 search_failed');
  });

  it('omits the code when the body carried none', () => {
    expect(apiErrorDetail('/api/feed?cursor=abc', 500, undefined)).toBe('/api/feed 500');
  });
});
