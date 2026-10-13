import { describe, expect, it, vi } from 'vitest';
import { larkSdkLogger, log, redactText } from '../../src/core/logger.js';

describe('secret redaction', () => {
  it('redacts bearer, assignment, and JSON-shaped credential text', () => {
    const value = 'Bearer abc API_TOKEN=xyz {"appSecret":"lark-secret","nested":{"jwt":"jwt-value"}}';
    const redacted = redactText(value);
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('xyz');
    expect(redacted).not.toContain('lark-secret');
    expect(redacted).not.toContain('jwt-value');
  });

  it('does not emit secret-shaped values in logger fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      log.error('test', 'redaction', { appSecret: 'lark-secret', detail: 'API_TOKEN=token-value' });
      const text = spy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(text).not.toContain('lark-secret');
      expect(text).not.toContain('token-value');
      expect(text).toContain('[REDACTED]');
      expect(text).toMatch(/\[lark-pi-bridge\] \d{4}-\d{2}-\d{2}T/);
    } finally {
      spy.mockRestore();
    }
  });

  it('summarizes SDK errors without traversing Axios request objects', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const error = Object.assign(new Error('Request failed with Bearer short-lived-token'), {
        code: 'ERR_BAD_REQUEST',
        config: { headers: { Authorization: 'Bearer leaked-token' } },
        request: { rawHeaders: ['Authorization', 'Bearer leaked-token'] },
        response: { status: 400, config: { headers: { Authorization: 'Bearer leaked-token' } } },
      });
      larkSdkLogger.error(error, {
        code: 1069302,
        msg: 'reply rejected',
        request: { headers: { Authorization: 'Bearer another-token' } },
      });
      const text = spy.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(text).toContain('ERR_BAD_REQUEST');
      expect(text).toContain('1069302');
      expect(text).toContain('reply rejected');
      expect(text).not.toContain('short-lived-token');
      expect(text).not.toContain('leaked-token');
      expect(text).not.toContain('another-token');
      expect(text).not.toContain('Authorization');
      expect(text).not.toContain('rawHeaders');
    } finally {
      spy.mockRestore();
    }
  });
});
