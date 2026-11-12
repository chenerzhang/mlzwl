import { describe, expect, it } from 'vitest';
import {
  describeDownloadFailure,
  formatBytes,
  parseContentLength,
  progressPercent,
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
