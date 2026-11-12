import { describe, expect, it } from 'vitest';
import { parseRange, rangeHeaders } from './range.js';

/**
 * Range 解析。
 *
 * 浏览器播放视频只会发单段 Range，但边界值必须严格：错一个字节就可能导致
 * 播放器卡住或反复重试。
 */
describe('parseRange', () => {
  const SIZE = 1000;

  it('parses an explicit closed range', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('parses an open-ended range to the last byte', () => {
    expect(parseRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('parses a suffix range', () => {
    expect(parseRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('clamps an end beyond the file size', () => {
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('rejects a start at or past the end', () => {
    expect(parseRange('bytes=1000-', SIZE)).toBeNull();
    expect(parseRange('bytes=1200-1300', SIZE)).toBeNull();
  });

  it('rejects an inverted range', () => {
    expect(parseRange('bytes=500-100', SIZE)).toBeNull();
  });

  it('rejects multi-range requests', () => {
    // 浏览器播放视频不会发多段；返回整个文件是 RFC 允许的行为，
    // 这里选择明确拒绝，让客户端改发单段。
    expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull();
  });

  it('rejects malformed headers', () => {
    expect(parseRange('bytes=', SIZE)).toBeNull();
    expect(parseRange('items=0-99', SIZE)).toBeNull();
    expect(parseRange('bytes=abc-def', SIZE)).toBeNull();
    expect(parseRange('bytes=-0', SIZE)).toBeNull();
  });

  it('rejects malformed numeric segments and unsafe integers', () => {
    for (const header of [
      'bytes=1x-20',
      'bytes=1-20foo',
      'bytes=-10abc',
      'bytes=+1-20',
      'bytes=999999999999999999999-',
    ]) {
      expect(parseRange(header, SIZE), header).toBeNull();
    }
  });
});

describe('rangeHeaders', () => {
  it('reports a 206-compatible header set', () => {
    const headers = rangeHeaders({ start: 0, end: 99 }, 1000, 'video/mp4');
    expect(headers['content-length']).toBe('100');
    expect(headers['content-range']).toBe('bytes 0-99/1000');
    expect(headers['accept-ranges']).toBe('bytes');
    expect(headers['content-type']).toBe('video/mp4');
  });
});
