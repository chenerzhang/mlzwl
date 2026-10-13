import { describe, expect, it, vi } from 'vitest';
import type { CardActionEvent } from '@larksuite/channel';
import type { AgentInteractionContext, AgentExtensionUIRequest } from '../../src/agent/types.js';
import { LarkInteractionBroker } from '../../src/bot/interaction-broker.js';
import type { ChannelPort } from '../../src/bot/channel.js';

class FakeChannel {
  readonly sent: Array<{ to: string; input: Parameters<ChannelPort['send']>[1] }> = [];
  readonly replies: Parameters<ChannelPort['reply']>[1][] = [];
  failSend = false;

  async send(to: string, input: Parameters<ChannelPort['send']>[1]): Promise<void> {
    if (this.failSend) {
      throw new Error('private delivery failed');
    }
    this.sent.push({ to, input });
  }

  async reply(_target: Parameters<ChannelPort['reply']>[0], input: Parameters<ChannelPort['reply']>[1]): Promise<void> {
    if (this.failSend) {
      throw new Error('private delivery failed');
    }
    this.replies.push(input);
  }
}

const context: AgentInteractionContext = {
  runId: 'run-a',
  scopeId: 'chat-a',
  actorOpenId: 'ou_actor',
  surface: 'group',
  privateReplyTarget: { chatId: 'chat-a', messageId: 'message-a' },
};

function card(value: unknown, openId = context.actorOpenId, formValue?: Record<string, unknown>, name?: string) {
  return {
    messageId: 'private-card',
    chatId: 'private-chat',
    operator: { openId },
    action: { tag: 'button', value, ...(formValue ? { formValue } : {}), ...(name ? { name } : {}) },
  } satisfies CardActionEvent;
}

function cardJson(channel: FakeChannel): string {
  const input = channel.sent.at(-1)?.input;
  if (!input || !('card' in input)) {
    throw new Error('expected a private interaction card');
  }
  return JSON.stringify(input.card);
}

function firstMatch(json: string, pattern: RegExp): string {
  const value = json.match(pattern)?.[1];
  if (!value) {
    throw new Error(`missing ${pattern}`);
  }
  return value;
}

async function waitForDelivery(channel: FakeChannel): Promise<void> {
  await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
}

describe('LarkInteractionBroker', () => {
  it('round-trips opaque select, input, and editor values while rejecting forged data', async () => {
    const channel = new FakeChannel();
    const broker = new LarkInteractionBroker(channel);

    const select = broker.handle(context, { method: 'select', title: 'Choose', options: ['Allow', 'Block'] });
    await waitForDelivery(channel);
    const selectJson = cardJson(channel);
    const token = firstMatch(selectJson, /"token":"([A-Za-z0-9_-]{32})"/);
    const optionTokens = [...selectJson.matchAll(/"value":"([A-Za-z0-9_-]{24})"/g)].map((match) => match[1]!);
    expect(optionTokens).toHaveLength(2);
    expect(selectJson).not.toContain('Pi request');
    expect(broker.handleCardAction(card({ token, action: 'select', method: 'select', option: 'forged' }))).toEqual({
      toast: { type: 'error', content: '选择项无效。' },
    });
    expect(broker.pendingCount).toBe(1);
    expect(broker.handleCardAction(card({ token, action: 'confirm', method: 'confirm' }))).toEqual({
      toast: { type: 'error', content: '交互类型不匹配。' },
    });
    expect(broker.pendingCount).toBe(1);
    broker.handleCardAction({
      ...card({ token, action: 'select', method: 'select' }),
      action: {
        tag: 'select_static',
        value: { token, action: 'select', method: 'select' },
        option: optionTokens[1]!,
      },
    });
    await expect(select).resolves.toEqual({ value: 'Block' });

    channel.sent.length = 0;
    const input = broker.handle(context, { method: 'input', title: 'Value', placeholder: 'type' });
    await waitForDelivery(channel);
    const inputToken = firstMatch(cardJson(channel), /"name":"t_input_([A-Za-z0-9_-]{32})"/);
    expect(
      broker.handleCardAction(
        card({}, context.actorOpenId, { bridge_input: 'x'.repeat(1_001) }, `t_input_${inputToken}`),
      ),
    ).toEqual({ toast: { type: 'error', content: '输入内容无效或过长。' } });
    broker.handleCardAction(card({}, context.actorOpenId, { bridge_input: 'typed value' }, `t_input_${inputToken}`));
    await expect(input).resolves.toEqual({ value: 'typed value' });

    channel.sent.length = 0;
    const editor = broker.handle(context, { method: 'editor', title: 'Edit', prefill: 'safe prefill' });
    await waitForDelivery(channel);
    const editorJson = cardJson(channel);
    expect(editorJson).toContain('safe prefill');
    const editorToken = firstMatch(editorJson, /"name":"t_editor_([A-Za-z0-9_-]{32})"/);
    broker.handleCardAction(
      card({}, context.actorOpenId, { bridge_input: 'line 1\nline 2' }, `t_editor_${editorToken}`),
    );
    await expect(editor).resolves.toEqual({ value: 'line 1\nline 2' });
    broker.dispose();
  });

  it('cancels on timeout, delivery failure, run cancellation, and teardown', async () => {
    vi.useFakeTimers();
    try {
      const channel = new FakeChannel();
      const broker = new LarkInteractionBroker(channel);
      const timed = broker.handle(context, { method: 'confirm', title: 'Confirm', message: 'Proceed?', timeoutMs: 10 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await expect(timed).resolves.toEqual({ cancelled: true });

      vi.useRealTimers();
      channel.failSend = true;
      const failed = broker.handle({ ...context, runId: 'run-failed' }, { method: 'input', title: 'Input' });
      await expect(failed).resolves.toEqual({ cancelled: true });
      channel.failSend = false;

      const stopped = broker.handle(
        { ...context, runId: 'run-stop' },
        { method: 'confirm', title: 'Stop', message: '' },
      );
      broker.cancelRun('run-stop');
      await expect(stopped).resolves.toEqual({ cancelled: true });

      const disposed = broker.handle({ ...context, runId: 'run-dispose' }, { method: 'editor', title: 'Edit' });
      broker.dispose();
      await expect(disposed).resolves.toEqual({ cancelled: true });
      await expect(
        broker.handle({ ...context, runId: 'run-after-dispose' }, { method: 'confirm', title: 'Confirm', message: '' }),
      ).resolves.toEqual({ cancelled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces per-run and global pending capacity without cross-run consumption', async () => {
    const channel = new FakeChannel();
    const broker = new LarkInteractionBroker(channel);
    const request: AgentExtensionUIRequest = { method: 'confirm', title: 'Confirm', message: 'Proceed?' };
    const perRun = Array.from({ length: 4 }, () => broker.handle(context, request));
    await vi.waitFor(() => expect(broker.pendingCount).toBe(4));
    await expect(broker.handle(context, request)).resolves.toEqual({ cancelled: true });

    const otherRuns = Array.from({ length: 60 }, (_, index) =>
      broker.handle(
        { ...context, runId: `other-${index}`, scopeId: `scope-${index}`, actorOpenId: `ou_${index}` },
        request,
      ),
    );
    await vi.waitFor(() => expect(broker.pendingCount).toBe(64));
    await expect(
      broker.handle({ ...context, runId: 'overflow', scopeId: 'overflow', actorOpenId: 'ou_overflow' }, request),
    ).resolves.toEqual({ cancelled: true });

    const firstCard = channel.sent[0]!.input;
    const token = firstMatch(
      JSON.stringify('card' in firstCard ? firstCard.card : firstCard),
      /"token":"([A-Za-z0-9_-]{32})"/,
    );
    expect(broker.handleCardAction(card({ token, action: 'confirm', method: 'confirm' }, 'ou_other'))).toEqual({
      toast: { type: 'error', content: '只有发起该 Pi 请求的用户可以操作。' },
    });
    expect(broker.pendingCount).toBe(64);

    broker.cancelRun(context.runId);
    await expect(Promise.all(perRun)).resolves.toEqual(Array(4).fill({ cancelled: true }));
    expect(broker.pendingCount).toBe(60);
    broker.dispose();
    await expect(Promise.all(otherRuns)).resolves.toEqual(Array(60).fill({ cancelled: true }));
  });

  it('shows bounded fire-and-forget content privately and never injects editor text', async () => {
    const channel = new FakeChannel();
    const broker = new LarkInteractionBroker(channel);
    await broker.handle(context, { method: 'notify', message: 'n'.repeat(3_000), notifyType: 'warning' });
    await broker.handle(context, {
      method: 'setWidget',
      widgetKey: 'w',
      widgetLines: ['one', 'two'],
      widgetPlacement: 'aboveEditor',
    });
    await broker.handle(context, { method: 'setStatus', statusKey: 's', statusText: 'active' });
    await broker.handle(context, { method: 'setTitle', title: 'secret title' });
    await broker.handle(context, { method: 'set_editor_text', text: 'do not execute this' });

    expect(channel.sent).toHaveLength(4);
    expect(channel.sent.every((entry) => entry.to === context.actorOpenId)).toBe(true);
    const payload = JSON.stringify(channel.sent);
    expect(payload).not.toContain('secret title');
    expect(payload).not.toContain('do not execute this');
    expect(payload).toContain('不会自动提交或执行');
    expect(payload.length).toBeLessThan(5_000);
    for (let index = 0; index < 40; index += 1) {
      await broker.handle(context, { method: 'notify', message: `notification-${index}`, notifyType: 'info' });
    }
    expect(channel.sent).toHaveLength(31);
    broker.dispose();
  });
});
