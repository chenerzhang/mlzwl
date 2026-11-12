import { describe, expect, it } from 'vitest';
import {
  describeDownloadFailure,
  activeEntry,
  entryFor,
  formatBytes,
  initialEntry,
  parseContentLength,
  progressPercent,
  withEntry,
  type DownloadEntries,
  type DownloadEntry,
} from './download-state';

const entry = (received: number, total: number | null): DownloadEntry => ({
  status: 'downloading',
  received,
  total,
});

describe('progressPercent', () => {
  it('returns null when total is unknown', () => {
    expect(progressPercent(entry(10, null))).toBeNull();
  });

  it('returns null when total is zero', () => {
    expect(progressPercent(entry(0, 0))).toBeNull();
  });

  it('caps progress at 100 when received exceeds total', () => {
    expect(progressPercent(entry(120, 100))).toBe(100);
  });

  it('floors a normal ratio', () => {
    expect(progressPercent(entry(32, 100))).toBe(32);
    expect(progressPercent(entry(1, 3))).toBe(33);
  });
});

describe('parseContentLength', () => {
  it('parses a valid byte length', () => {
    expect(parseContentLength('19098824')).toBe(19_098_824);
  });

  it('rejects empty, negative, non-numeric, and missing values', () => {
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('-1')).toBeNull();
    expect(parseContentLength('abc')).toBeNull();
    expect(parseContentLength(null)).toBeNull();
  });
});

describe('describeDownloadFailure', () => {
  it('uses the message from a normal Error', () => {
    expect(describeDownloadFailure(new Error('网络连接中断'))).toBe('网络连接中断');
  });

  it('describes AbortError as cancelled', () => {
    expect(describeDownloadFailure(new DOMException('The operation was aborted', 'AbortError'))).toBe('已取消');
  });

  it('uses a fallback for non-Error values', () => {
    expect(describeDownloadFailure('bad')).toBe('下载失败，请稍后重试');
  });

  it('passes through an HTTP error message', () => {
    expect(describeDownloadFailure(new Error('媒体暂不可用'))).toBe('媒体暂不可用');
  });
});

describe('formatBytes', () => {
  it('formats bytes using binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(19_098_824)).toBe('18.2 MB');
  });
});

describe('entryFor / withEntry', () => {
  it('keeps one record per definition instead of overwriting the episode', () => {
    // 1080p 与 360p 都下完后，两条记录必须同时存在。这是「按档位记账」的核心：
    // 只按集号存一份时，后完成的档会覆盖先完成的档。
    let entries: DownloadEntries = {};
    entries = withEntry(entries, 'ep-1', '1080p', { status: 'done', received: 10, total: 10 });
    entries = withEntry(entries, 'ep-1', '360p', { status: 'done', received: 5, total: 5 });

    expect(entryFor(entries, 'ep-1', '1080p').status).toBe('done');
    expect(entryFor(entries, 'ep-1', '360p').status).toBe('done');
    // 没下过的档仍是初始状态。
    expect(entryFor(entries, 'ep-1', '540p')).toEqual(initialEntry());
  });

  it('stores a download without a definition in its own bucket', () => {
    const entries = withEntry({}, 'ep-1', undefined, { status: 'done', received: 1, total: 1 });

    // `undefined` 档位落在 `auto` 桶里，不与任何真实档位冲突。
    expect(entryFor(entries, 'ep-1', undefined).status).toBe('done');
    expect(entryFor(entries, 'ep-1', '360p')).toEqual(initialEntry());
  });

  it('returns the initial entry for an unknown episode', () => {
    expect(entryFor({}, 'ep-x', '1080p')).toEqual(initialEntry());
  });

  it('reports the running download of an episode regardless of definition', () => {
    const entries = withEntry({}, 'ep-1', '1080p', { status: 'downloading', received: 1, total: 10 });

    // 并发按集算，UI 需要「这一集在跑」而不关心是哪一档。
    expect(activeEntry(entries, 'ep-1')?.status).toBe('downloading');
    expect(activeEntry(entries, 'ep-2')).toBeUndefined();
  });
});
