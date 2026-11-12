import { describe, expect, it } from 'vitest';
import {
  MAX_AGE_MS,
  MAX_DESCRIPTION_LENGTH,
  MAX_ITEMS,
  MAX_SERIALIZED_BYTES,
  parseSnapshot,
  serializeSnapshot,
  toSnapshotItems,
  type CatalogSnapshot,
  type OfflineSeriesSummary,
} from './offline-catalog';

/**
 * 离线目录规则的纯逻辑测试（P1-7）。
 *
 * 不引入 jsdom：被测模块是纯函数，`localStorage` 那一层在
 * `offline-catalog-store.ts` 里，按 `apps/hongguo/AGENTS.md` 的 web 测试边界
 * 不测依赖浏览器全局对象的模块。
 */

const NOW = 1_700_000_000_000;

/** 造一个合法快照的 JSON 文本，方便各用例只改一个字段。 */
function rawSnapshot(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    savedAt: NOW - 1000,
    items: [{ id: '123', title: '长生' }],
    ...overrides,
  });
}

describe('parseSnapshot', () => {
  it('returns null for a missing snapshot', () => {
    expect(parseSnapshot(null, NOW)).toBeNull();
  });

  it('returns null for broken JSON', () => {
    expect(parseSnapshot('{not json', NOW)).toBeNull();
  });

  it('returns null when the version does not match', () => {
    expect(parseSnapshot(rawSnapshot({ version: 3 }), NOW)).toBeNull();
    expect(parseSnapshot(rawSnapshot({ version: '2' }), NOW)).toBeNull();
  });

  it('returns null when the snapshot is older than 7 days', () => {
    expect(parseSnapshot(rawSnapshot({ savedAt: NOW - MAX_AGE_MS - 1 }), NOW)).toBeNull();
  });

  it('accepts a snapshot exactly 7 days old', () => {
    const parsed = parseSnapshot(rawSnapshot({ savedAt: NOW - MAX_AGE_MS }), NOW);
    expect(parsed).not.toBeNull();
  });

  it('returns null when savedAt is in the future (clock rolled back)', () => {
    expect(parseSnapshot(rawSnapshot({ savedAt: NOW + 1 }), NOW)).toBeNull();
  });

  it('returns null when savedAt is not a safe non-negative integer', () => {
    expect(parseSnapshot(rawSnapshot({ savedAt: -1 }), NOW)).toBeNull();
    expect(parseSnapshot(rawSnapshot({ savedAt: 1.5 }), NOW)).toBeNull();
    expect(parseSnapshot(rawSnapshot({ savedAt: '1700000000000' }), NOW)).toBeNull();
  });

  it('returns null when items is not an array', () => {
    expect(parseSnapshot(rawSnapshot({ items: {} }), NOW)).toBeNull();
  });

  it('returns null when items is empty', () => {
    expect(parseSnapshot(rawSnapshot({ items: [] }), NOW)).toBeNull();
  });

  it('returns null when items exceed the limit', () => {
    const items = Array.from({ length: MAX_ITEMS + 1 }, (_, index) => ({
      id: String(index + 1),
      title: `剧 ${index + 1}`,
    }));
    expect(parseSnapshot(rawSnapshot({ items }), NOW)).toBeNull();
  });

  it('accepts exactly MAX_ITEMS items', () => {
    const items = Array.from({ length: MAX_ITEMS }, (_, index) => ({
      id: String(index + 1),
      title: `剧 ${index + 1}`,
    }));
    const parsed = parseSnapshot(rawSnapshot({ items }), NOW);
    expect(parsed?.items).toHaveLength(MAX_ITEMS);
  });

  it('drops the whole snapshot when one id is invalid', () => {
    const items = [
      { id: '123', title: '长生' },
      { id: 'abc', title: '坏 id' },
    ];
    // 整体丢弃，不做部分信任：否则同一份存档每次刷新显示的内容都可能不同。
    expect(parseSnapshot(rawSnapshot({ items }), NOW)).toBeNull();
  });

  it('returns null when an id is longer than 30 digits', () => {
    const items = [{ id: '1'.repeat(31), title: '太长' }];
    expect(parseSnapshot(rawSnapshot({ items }), NOW)).toBeNull();
  });

  it('returns null when a title is empty', () => {
    expect(parseSnapshot(rawSnapshot({ items: [{ id: '123', title: '' }] }), NOW)).toBeNull();
    expect(parseSnapshot(rawSnapshot({ items: [{ id: '123', title: '   ' }] }), NOW)).toBeNull();
  });

  it('returns null when a description exceeds the length limit', () => {
    const items = [{ id: '123', title: '长生', description: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1) }];
    expect(parseSnapshot(rawSnapshot({ items }), NOW)).toBeNull();
  });

  it('returns null when episodeCount is not a non-negative integer', () => {
    expect(parseSnapshot(rawSnapshot({ items: [{ id: '123', title: '长生', episodeCount: -1 }] }), NOW)).toBeNull();
    expect(parseSnapshot(rawSnapshot({ items: [{ id: '123', title: '长生', episodeCount: 1.5 }] }), NOW)).toBeNull();
  });

  it('returns null when coverUrl is not a string', () => {
    expect(parseSnapshot(rawSnapshot({ items: [{ id: '123', title: '长生', coverUrl: 42 }] }), NOW)).toBeNull();
  });

  it('drops a snapshot written by the version that leaked upstream signatures', () => {
    // 版本 1 的存档可能带 `/api/cover?u=<上游签名 URL>`，必须整体作废。
    expect(parseSnapshot(rawSnapshot({ version: 1 }), NOW)).toBeNull();
  });

  it('rejects a coverUrl that is not our proxy path', () => {
    const legacy = '/api/cover?u=https%3A%2F%2Fcdn.example.com%2Fa.jpg%3Fx-signature%3D1';
    expect(parseSnapshot(rawSnapshot({ items: [{ id: '123', title: '长生', coverUrl: legacy }] }), NOW)).toBeNull();
    expect(
      parseSnapshot(
        rawSnapshot({ items: [{ id: '123', title: '长生', coverUrl: 'https://cdn.example.com/a.jpg' }] }),
        NOW,
      ),
    ).toBeNull();
  });

  it('returns a parsed snapshot for valid input', () => {
    const parsed = parseSnapshot(rawSnapshot(), NOW);
    expect(parsed).toEqual({
      version: 2,
      savedAt: NOW - 1000,
      items: [{ id: '123', title: '长生' }],
    });
  });
});

describe('toSnapshotItems', () => {
  it('drops a coverUrl that is not our proxy path', () => {
    // 写路径与读路径必须同规则：旧 `?u=` 地址不能先写进 version 2 再等下次读取作废。
    const items = toSnapshotItems([
      { id: '1', title: '旧封面', coverUrl: '/api/cover?u=https%3A%2F%2Fx%2Fx-signature%3D1' },
      { id: '2', title: '上游直链', coverUrl: 'https://cdn.example.com/a.jpg' },
      { id: '3', title: '正常', coverUrl: '/api/cover/AbC-9_x' },
    ]);
    expect(items).toEqual([
      { id: '1', title: '旧封面' },
      { id: '2', title: '上游直链' },
      { id: '3', title: '正常', coverUrl: '/api/cover/AbC-9_x' },
    ]);
  });

  it('keeps only the whitelisted fields', () => {
    const upstream = [
      {
        id: '123',
        title: '长生',
        coverUrl: '/api/cover/abc-token',
        description: '简介',
        episodeCount: 80,
        // 下面这些都不允许进 localStorage。
        streamUrl: 'https://cdn.example.com/1.mp4?sign=secret',
        spadeA: 'spade_a=1',
        author: '某作者',
      },
    ];
    const items = toSnapshotItems(upstream);
    expect(items).toEqual([
      {
        id: '123',
        title: '长生',
        coverUrl: '/api/cover/abc-token',
        description: '简介',
        episodeCount: 80,
      },
    ]);
    const keys = Object.keys(items[0] ?? {});
    expect(keys).not.toContain('streamUrl');
    expect(keys).not.toContain('spadeA');
    expect(keys).not.toContain('author');
  });

  it('truncates to MAX_ITEMS items', () => {
    const upstream = Array.from({ length: MAX_ITEMS + 10 }, (_, index) => ({
      id: String(index + 1),
      title: `剧 ${index + 1}`,
    }));
    expect(toSnapshotItems(upstream)).toHaveLength(MAX_ITEMS);
  });

  it('truncates the description to MAX_DESCRIPTION_LENGTH characters', () => {
    const [item] = toSnapshotItems([{ id: '1', title: 't', description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 50) }]);
    expect(item?.description).toHaveLength(MAX_DESCRIPTION_LENGTH);
  });

  it('omits fields that are undefined', () => {
    const [item] = toSnapshotItems([{ id: '1', title: 't' }]);
    expect(item).toEqual({ id: '1', title: 't' });
  });
});

describe('serializeSnapshot', () => {
  it('returns null when the payload exceeds the byte limit', () => {
    const items: OfflineSeriesSummary[] = Array.from({ length: MAX_ITEMS }, (_, index) => ({
      id: String(index + 1),
      title: '剧'.repeat(1000),
      description: '描'.repeat(MAX_DESCRIPTION_LENGTH),
    }));
    const snapshot: CatalogSnapshot = { version: 2, savedAt: NOW, items };
    expect(serializeSnapshot(snapshot)).toBeNull();
    // 用 UTF-8 字节数而不是 string.length 判断：中文一字 3 字节。
    expect(JSON.stringify(snapshot).length).toBeLessThan(MAX_SERIALIZED_BYTES);
  });

  it('round-trips through parseSnapshot', () => {
    const snapshot: CatalogSnapshot = {
      version: 2,
      savedAt: NOW,
      items: [{ id: '123', title: '长生', coverUrl: '/api/cover/abc-token', description: '简介', episodeCount: 80 }],
    };
    const raw = serializeSnapshot(snapshot);
    expect(raw).not.toBeNull();
    expect(parseSnapshot(raw, NOW)).toEqual(snapshot);
  });
});
