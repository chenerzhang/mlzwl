import { describe, expect, it } from 'vitest';
import { TextReplyRenderer } from '../../src/card/text-renderer.js';

describe('TextReplyRenderer', () => {
  it('renders text, optional tool activity and errors with a bounded fallback', () => {
    const renderer = new TextReplyRenderer();
    renderer.apply({ type: 'thinking', delta: 'reasoning' });
    renderer.apply({ type: 'tool_use', id: 'one', name: 'read', input: {} }, true);
    renderer.apply({ type: 'text', delta: 'answer' }, true);
    expect(renderer.render(true)).toBe('answer\n\n使用工具：read');
    renderer.apply({ type: 'error', message: 'network failed API_TOKEN=secret-value', terminationReason: 'failed' });
    expect(renderer.render()).toContain('运行失败：network failed API_TOKEN=[REDACTED]');
  });

  it.each([
    [{ type: 'done', terminationReason: 'normal' } as const, 'Pi 已正常完成，但没有返回文本。'],
    [{ type: 'done', terminationReason: 'interrupted' } as const, '运行已中断。'],
    [{ type: 'done', terminationReason: 'timeout' } as const, '运行超时，已停止。'],
    [{ type: 'error', message: 'aborted', terminationReason: 'interrupted' } as const, '运行已中断：aborted'],
    [{ type: 'error', message: 'deadline', terminationReason: 'timeout' } as const, '运行超时：deadline'],
  ])('renders a non-empty and accurate no-text terminal for %#', (terminal, expected) => {
    const renderer = new TextReplyRenderer();
    renderer.apply(terminal);
    expect(renderer.render()).toBe(expected);
    expect(renderer.render()).not.toContain('(no content)');
  });

  it('applies an explicit character bound only when a caller requests one', () => {
    const unbounded = new TextReplyRenderer();
    unbounded.apply({ type: 'text', delta: 'a'.repeat(20_000) });
    expect(unbounded.render()).toHaveLength(20_000);

    const bounded = new TextReplyRenderer(5);
    bounded.apply({ type: 'text', delta: 'abcd😀rest' });
    expect(bounded.render()).toBe('abcd…[已截断]');
  });

  it('preserves existing text and ignores events after a terminal state', () => {
    const renderer = new TextReplyRenderer();
    renderer.apply({ type: 'text', delta: 'partial answer' });
    renderer.apply({ type: 'error', message: 'protocol failure', terminationReason: 'failed' });
    renderer.apply({ type: 'done', terminationReason: 'normal' });
    renderer.apply({ type: 'text', delta: 'late text' });
    expect(renderer.render()).toBe('partial answer\n\n运行失败：protocol failure');
  });
});
