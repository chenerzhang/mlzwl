import type { AgentEvent } from '../agent/types.js';
import { redactText } from '../core/logger.js';

/** Accumulates the complete rendered reply. Outbound sizing and splitting happen at the channel boundary. */
export class TextReplyRenderer {
  private textParts: string[] = [];
  private textChars = 0;
  private textTruncated = false;
  private hasThinking = false;
  private tools: string[] = [];
  private terminal: Extract<AgentEvent, { type: 'done' | 'error' }> | undefined;

  constructor(private readonly maxTextChars = Number.POSITIVE_INFINITY) {}

  apply(event: AgentEvent, showToolCalls = false): void {
    if (this.terminal) {
      return;
    }
    if (event.type === 'text') {
      this.appendText(event.delta);
    }
    if (event.type === 'thinking' && event.delta.trim()) {
      this.hasThinking = true;
    }
    if (event.type === 'tool_use' && showToolCalls) {
      this.tools.push(`使用工具：${event.name}`);
    }
    if (event.type === 'done' || event.type === 'error') {
      this.terminal = event;
    }
  }

  hasOutput(): boolean {
    return Boolean(this.text().trim() || this.hasThinking || this.tools.length || this.terminal);
  }

  render(showToolCalls = false): string {
    const text = this.text();
    const parts = [text.trim()];
    if (showToolCalls && this.tools.length) {
      parts.push(this.tools.join('\n'));
    }
    const terminal = this.terminalText();
    if (terminal) {
      parts.push(terminal);
    }
    if (!parts.filter(Boolean).length && this.hasThinking) {
      return 'Pi 已完成推理，但没有可发送的文本回复。';
    }
    return parts.filter(Boolean).join('\n\n') || 'Pi 运行未返回可发送内容，且未收到完成状态。';
  }

  private appendText(value: string): void {
    const remaining = this.maxTextChars - this.textChars;
    if (remaining <= 0) {
      this.textTruncated ||= Boolean(value);
      return;
    }
    const next = safePrefix(value, remaining);
    if (next) {
      this.textParts.push(next);
      this.textChars += next.length;
    }
    this.textTruncated ||= next.length < value.length;
  }

  private text(): string {
    return `${this.textParts.join('')}${this.textTruncated ? '…[已截断]' : ''}`;
  }

  private terminalText(): string | undefined {
    if (this.terminal?.type === 'error') {
      const prefix =
        this.terminal.terminationReason === 'timeout'
          ? '运行超时'
          : this.terminal.terminationReason === 'interrupted'
            ? '运行已中断'
            : '运行失败';
      return `${prefix}：${redactText(this.terminal.message)}`;
    }
    if (this.terminal?.type === 'done' && this.terminal.terminationReason === 'timeout') {
      return '运行超时，已停止。';
    }
    if (this.terminal?.type === 'done' && this.terminal.terminationReason === 'interrupted') {
      return '运行已中断。';
    }
    if (this.terminal?.type === 'done' && !this.text().trim()) {
      return 'Pi 已正常完成，但没有返回文本。';
    }
    return undefined;
  }
}

function safePrefix(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let end = Math.max(0, maxChars);
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}
