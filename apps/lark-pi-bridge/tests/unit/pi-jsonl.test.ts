import { describe, expect, it } from 'vitest';
import { MAX_PI_JSONL_LINE_BYTES, StrictPiJsonlDecoder } from '../../src/agent/pi/jsonl.js';

describe('StrictPiJsonlDecoder', () => {
  it('decodes LF-delimited JSON split across chunks', () => {
    const decoder = new StrictPiJsonlDecoder();
    expect(decoder.push(Buffer.from('{"type":"ses'))).toEqual([]);
    expect(decoder.push(Buffer.from('sion"}\n{"type":"agent_settled"}\n'))).toEqual([
      { type: 'session' },
      { type: 'agent_settled' },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('accepts an optional CR before LF but rejects malformed, empty and unterminated records', () => {
    expect(new StrictPiJsonlDecoder().push(Buffer.from('{}\r\n'))).toEqual([{}]);
    expect(() => new StrictPiJsonlDecoder().push(Buffer.from('{bad}\n'))).toThrow(/not valid JSON/);
    expect(() => new StrictPiJsonlDecoder().push(Buffer.from('\n'))).toThrow(/is empty/);
    const decoder = new StrictPiJsonlDecoder();
    decoder.push(Buffer.from('{}'));
    expect(() => decoder.finish()).toThrow(/unterminated/);
  });

  it('accepts the multi-megabyte agent_end records emitted by tool-heavy Pi runs', () => {
    expect(MAX_PI_JSONL_LINE_BYTES).toBeGreaterThan(1024 * 1024);
    const messages = Array.from({ length: 96 }, (_, index) => ({
      role: 'toolResult',
      toolCallId: `call-${index}`,
      content: [{ type: 'text', text: 'x'.repeat(16 * 1024) }],
    }));
    const event = { type: 'agent_end', messages, willRetry: false };
    const line = Buffer.from(`${JSON.stringify(event)}\n`);
    expect(line.length).toBeGreaterThan(1024 * 1024);
    expect(new StrictPiJsonlDecoder().push(line)).toEqual([event]);
  });

  it('rejects an overlong line before a newline arrives', () => {
    const decoder = new StrictPiJsonlDecoder({ maxLineBytes: 8, maxOutputBytes: 64 });
    expect(() => decoder.push(Buffer.from('123456789'))).toThrow(/line exceeded 8 bytes/);
  });

  it('rejects output beyond the configured bound and can reset it between pooled RPC turns', () => {
    const decoder = new StrictPiJsonlDecoder({ maxLineBytes: 16, maxOutputBytes: 16 });
    expect(decoder.push(Buffer.from('{}\n{}\n'))).toEqual([{}, {}]);
    expect(() => decoder.push(Buffer.from('{"a":12345}\n'))).toThrow(/output exceeded 16 bytes/);

    const pooled = new StrictPiJsonlDecoder({ maxLineBytes: 8, maxOutputBytes: 8 });
    expect(pooled.push(Buffer.from('{}\n{}\n'))).toEqual([{}, {}]);
    pooled.resetOutputBudget();
    expect(pooled.push(Buffer.from('{}\n{}\n'))).toEqual([{}, {}]);
  });

  it('dispatches decoded records incrementally without retaining a whole stdout chunk', () => {
    const decoder = new StrictPiJsonlDecoder();
    const records: unknown[] = [];
    const returned = decoder.push(Buffer.from('{"n":1}\n{"n":2}\n'), (record) => records.push(record));
    expect(returned).toEqual([]);
    expect(records).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
