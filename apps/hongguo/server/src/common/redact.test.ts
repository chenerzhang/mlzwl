import { describe, expect, it } from 'vitest';
import { redact, redactError } from './redact.js';

/**
 * 脱敏规则的正确性证据。
 *
 * 这里要守的是**跨边界**（日志 / 响应体）不出现临时凭证，所以每条用例都断言
 * 「原文里的敏感片段不在输出里」，而不只是断言输出等于某个字符串——后者改一次
 * 格式就全红，但泄漏仍然可能发生。
 */

describe('redact URL', () => {
  it('keeps protocol host pathname and drops query fragment userinfo', () => {
    const output = redact('GET https://cdn.example.com/v1/a.mp4?sign=abc&x=1#frag failed');
    expect(output).toBe('GET https://cdn.example.com/v1/a.mp4 failed');
    expect(output).not.toContain('abc');
  });

  it('drops userinfo from a URL with credentials', () => {
    const output = redact('https://user:pass@cdn.example.com/v1/a.mp4');
    expect(output).toBe('https://cdn.example.com/v1/a.mp4');
    expect(output).not.toContain('pass');
  });

  it('handles http as well as https', () => {
    expect(redact('http://127.0.0.1:9133/api/health?token=t')).toBe('http://127.0.0.1:9133/api/health');
  });

  it('replaces an unparseable URL entirely', () => {
    expect(redact('bad https://[::1/x here')).toBe('bad (invalid url) here');
  });

  it('redacts several URLs in one message', () => {
    const output = redact('tried https://a.example.com/1?sign=s1 then https://b.example.com/2?sign=s2');
    expect(output).toBe('tried https://a.example.com/1 then https://b.example.com/2');
  });
});

describe('redact bare key-value pairs', () => {
  it('masks a bare sign parameter without any URL context', () => {
    const output = redact('sign=abc');
    expect(output).toBe('sign=[redacted]');
    expect(output).not.toContain('abc');
  });

  it('masks every secret key case-insensitively', () => {
    for (const key of ['spade_a', 'contentKey', 'content_key', 'sign', 'signature', 'token', 'key']) {
      expect(redact(`${key}=secret`)).toBe(`${key}=[redacted]`);
    }
  });

  it('does not truncate the signature key name into "sign"', () => {
    expect(redact('signature=s')).toBe('signature=[redacted]');
  });

  it('masks Authorization and Cookie headers including their scheme', () => {
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: [redacted]');
    expect(redact('cookie=sessionid=xyz; other=1')).toBe('cookie=[redacted]');
  });

  it('keeps normal words that merely contain a secret key name', () => {
    expect(redact('monkey=1 and content key missing')).toBe('monkey=1 and content key missing');
  });

  it('masks a secret key that follows an underscore', () => {
    // `csrf_token` / `x_content_key`：`_` 两边都是单词字符，`\b` 不成立，不能用它。
    expect(redact('csrf_token=abc')).toBe('csrf_token=[redacted]');
    expect(redact('x-sign=abc')).toBe('x-sign=[redacted]');
  });
});

describe('redact signature headers', () => {
  it('masks the upstream signature headers in header form', () => {
    const output = redact('x-argus: abc123');
    expect(output).toBe('x-argus: [redacted]');
    expect(output).not.toContain('abc123');
  });

  it('masks the upstream signature headers in query form', () => {
    const output = redact('x-ss-stub=def456');
    expect(output).toBe('x-ss-stub=[redacted]');
    expect(output).not.toContain('def456');
  });

  it('masks every signature key from this project', () => {
    const keys = [
      'x-gorgon',
      'x-argus',
      'x-ladon',
      'x-ss-stub',
      'x-ss-req-ticket',
      'x-khronos',
      'x-tt-trace-id',
      'set-cookie',
    ];
    for (const key of keys) {
      expect(redact(`${key}: secret`)).toBe(`${key}: [redacted]`);
      expect(redact(`${key}=secret`)).toBe(`${key}=[redacted]`);
    }
  });

  it('keeps the surrounding query after a masked signature parameter', () => {
    // query 风格只能抹到分隔符：抹到行尾会把排障需要的其余参数一起丢掉。
    expect(redact('GET /api/x?x-argus=abc&page=2 failed')).toBe('GET /api/x?x-argus=[redacted]&page=2 failed');
  });

  it('masks a whole multi-part trace id', () => {
    // `00-abc,00-def` 是一整串，只抹第一个逗号之前等于把后半截留在日志里。
    expect(redact('x-tt-trace-id: 00-abc,00-def')).toBe('x-tt-trace-id: [redacted]');
  });

  it('does not mask words that merely look like a signature key', () => {
    // 前边界断言是「键名开头的前一个字符」，`xx-argus` 不该命中。
    expect(redact('xx-argus=abc')).toBe('xx-argus=abc');
    expect(redact('monkey=1')).toBe('monkey=1');
  });
});

describe('redact limits', () => {
  it('truncates at 4096 characters and appends an ellipsis', () => {
    const output = redact('a'.repeat(5000));
    expect(output).toHaveLength(4097);
    expect(output.endsWith('…')).toBe(true);
  });

  it('leaves a message at exactly the limit untouched', () => {
    const input = 'a'.repeat(4096);
    expect(redact(input)).toBe(input);
  });
});

describe('redact idempotence', () => {
  it('is stable for every shape it produces', () => {
    const inputs = [
      'GET https://cdn.example.com/v1/a.mp4?sign=abc failed',
      'sign=abc',
      'Authorization: Bearer abc',
      'x-argus: abc123',
      'x-ss-stub=def456',
      'GET /api/x?x-argus=abc&page=2 failed',
      'a'.repeat(5000),
      `token=${'x'.repeat(5000)}`,
      'https://user:pass@cdn.example.com/x?key=k',
      'bad https://[::1/x',
      // 截断点恰好落在 `[redacted]` 中间：不能留下半个标记。
      `${'x'.repeat(4090)} sign=abc`,
      `${'x'.repeat(4085)} sign=abc`,
    ];
    for (const input of inputs) {
      const once = redact(input);
      expect(redact(once)).toBe(once);
      expect(once.endsWith('[redac')).toBe(false);
    }
  });
});

describe('redactError', () => {
  it('keeps the name and redacts the message', () => {
    const error = new TypeError('Failed to parse URL from https://x/y?sign=abc');
    const output = redactError(error);
    expect(output.name).toBe('TypeError');
    expect(output.message).toBe('Failed to parse URL from https://x/y');
    expect(output.message).not.toContain('abc');
  });

  it('handles non-Error values', () => {
    expect(redactError('sign=abc')).toEqual({ name: 'unknown', message: 'sign=[redacted]' });
    expect(redactError(42)).toEqual({ name: 'unknown', message: '42' });
  });

  it('does not leak a stack trace', () => {
    const error = new Error('boom');
    const output = redactError(error);
    expect(Object.keys(output).sort()).toEqual(['message', 'name']);
    expect(output.message).toBe('boom');
  });
});
