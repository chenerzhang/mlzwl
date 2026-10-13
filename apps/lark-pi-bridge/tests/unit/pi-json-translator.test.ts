import { describe, expect, it } from 'vitest';
import { PiJsonTranslator } from '../../src/agent/pi/json-translator.js';

describe('PiJsonTranslator', () => {
  it('maps stream events but never treats agent_end as terminal', () => {
    const translator = new PiJsonTranslator();
    expect(translator.translate({ type: 'session', id: 'session-a', cwd: '/repo' })).toEqual([
      { type: 'system', sessionId: 'session-a', cwd: '/repo' },
    ]);
    expect(
      translator.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } }),
    ).toEqual([{ type: 'text', delta: 'hello' }]);
    expect(translator.translate({ type: 'agent_end', willRetry: false })).toEqual([]);
    expect(translator.terminalEmitted()).toBe(false);
    expect(translator.translate({ type: 'agent_settled' })).toEqual([
      { type: 'done', sessionId: 'session-a', terminationReason: 'normal' },
    ]);
  });

  it('accepts a primed RPC session without a JSON session header', () => {
    const translator = new PiJsonTranslator();
    translator.primeSession('rpc-session');
    expect(translator.translate({ type: 'agent_end' })).toEqual([]);
    expect(translator.translate({ type: 'agent_settled' })).toEqual([
      { type: 'done', sessionId: 'rpc-session', terminationReason: 'normal' },
    ]);
  });

  it('rejects clean process exit after agent_end when agent_settled was not emitted', () => {
    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    translator.translate({ type: 'agent_end', willRetry: false });
    expect(translator.finish()).toEqual([
      {
        type: 'error',
        message: 'Pi stream ended before the required agent_settled completion boundary',
        terminationReason: 'failed',
      },
    ]);
  });

  it('emits a timeout done terminal when the bridge stops a child for idle timeout', () => {
    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    expect(translator.finish('timeout')).toEqual([
      { type: 'done', sessionId: 'session-a', terminationReason: 'timeout' },
    ]);
  });

  it('rejects a stream that ends before a completion boundary', () => {
    expect(new PiJsonTranslator().finish()).toEqual([
      {
        type: 'error',
        message: 'Pi stream ended before the required agent_settled completion boundary',
        terminationReason: 'failed',
      },
    ]);
  });

  it('fails closed on unknown events instead of silently accepting protocol drift', () => {
    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    expect(() => translator.translate({ type: 'future_pi_event' })).toThrow(/Unknown Pi JSON protocol event/);
    expect(translator.protocolDrift().unknownEvents).toBe(1);
  });

  it('does not prematurely terminalize a retryable message error', () => {
    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    expect(
      translator.translate({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary upstream failure' },
      }),
    ).toEqual([]);
    expect(translator.terminalEmitted()).toBe(false);
    translator.translate({ type: 'agent_end', willRetry: true });
    expect(
      translator.translate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'recovered' },
      }),
    ).toEqual([{ type: 'text', delta: 'recovered' }]);
    translator.translate({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
    translator.translate({ type: 'agent_end', willRetry: false });
    expect(translator.translate({ type: 'agent_settled' })).toEqual([
      { type: 'done', sessionId: 'session-a', terminationReason: 'normal' },
    ]);
  });

  it.each([
    ['error', 'failed', 'upstream failed'],
    ['aborted', 'interrupted', 'request aborted'],
  ] as const)(
    'preserves an unrecovered message_end(%s) across agent_settled',
    (stopReason, terminationReason, message) => {
      const translator = new PiJsonTranslator();
      translator.translate({ type: 'session', id: 'session-a' });
      translator.translate({
        type: 'message_end',
        message: { role: 'assistant', stopReason, errorMessage: message },
      });
      translator.translate({ type: 'agent_end', willRetry: false });
      expect(translator.translate({ type: 'agent_settled' })).toEqual([{ type: 'error', message, terminationReason }]);
    },
  );

  it('fails closed when Pi emits an event after agent_settled', () => {
    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    translator.translate({ type: 'agent_settled' });
    expect(() => translator.translate({ type: 'agent_end' })).toThrow(/after the terminal boundary/);
  });

  it('fails closed on invalid event order and unfinished tools', () => {
    const beforeSession = new PiJsonTranslator();
    expect(() =>
      beforeSession.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }),
    ).toThrow(/message_update-before-session/);

    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    expect(() =>
      translator.translate({ type: 'tool_execution_update', toolCallId: 'missing', output: 'unexpected' }),
    ).toThrow(/tool-update-before-start/);
    expect(translator.protocolDrift().anomalies).toBe(1);

    const activeTool = new PiJsonTranslator();
    activeTool.translate({ type: 'session', id: 'session-a' });
    activeTool.translate({ type: 'tool_execution_start', toolCallId: 'active', toolName: 'read' });
    expect(() => activeTool.translate({ type: 'agent_settled' })).toThrow(/agent-settled-with-active-tool/);
  });

  it('maps usage and tool execution, including bounded update output', () => {
    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    expect(
      translator.translate({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'read',
        args: { path: 'a.ts' },
      }),
    ).toEqual([{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.ts' } }]);
    expect(
      translator.translate({
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        partialResult: { content: [{ type: 'text', text: 'progress: ' }] },
      }),
    ).toEqual([]);
    expect(
      translator.translate({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        result: { content: [{ type: 'text', text: 'file' }] },
        isError: false,
      }),
    ).toEqual([{ type: 'tool_result', id: 'call-1', output: 'file', isError: false }]);
    expect(
      translator.translate({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 1, output: 2, cacheRead: 3, reasoning: 4, cost: { total: 0.01 } },
        },
      }),
    ).toEqual([
      { type: 'usage', inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, reasoningOutputTokens: 4, costUsd: 0.01 },
    ]);
  });

  it('bounds partial tool output and replaces it with the authoritative final result', () => {
    const translator = new PiJsonTranslator();
    translator.translate({ type: 'session', id: 'session-a' });
    translator.translate({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: {} });
    translator.translate({ type: 'tool_execution_update', toolCallId: 'call-1', output: 'a'.repeat(16_384) });
    const [result] = translator.translate({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      result: { content: [{ type: 'text', text: 'b'.repeat(20_000) }] },
      isError: false,
    });
    expect(result).toMatchObject({ type: 'tool_result', id: 'call-1', isError: false });
    if (result?.type === 'tool_result') {
      expect(result.output.length).toBeLessThanOrEqual(16_384 + '…[truncated]'.length);
      expect(result.output).toContain('…[truncated]');
      expect(result.output.startsWith('b')).toBe(true);
      expect(result.output.startsWith('a')).toBe(false);
    }
  });
});
