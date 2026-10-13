import { describe, expect, it } from 'vitest';
import type { SendInput } from '@larksuite/channel';
import type { AgentEvent } from '../../src/agent/types.js';
import { streamAgentReply } from '../../src/card/stream-reply.js';

describe('streamAgentReply', () => {
  it('streams text deltas and preserves a reply fallback when streaming fails', async () => {
    const appended: string[] = [];
    const replies: string[] = [];
    const channel = {
      async stream(
        _to: string,
        input: {
          markdown: (controller: {
            append(value: string): Promise<void>;
            setContent(value: string): Promise<void>;
          }) => Promise<void>;
        },
      ) {
        await input.markdown({
          async append(value) {
            appended.push(value);
          },
          async setContent(value) {
            appended.push(value);
          },
        });
        return { messageId: 'om_reply' };
      },
      async reply(_message: unknown, input: SendInput) {
        replies.push(readText(input));
        return { messageId: 'om_fallback' };
      },
      async send(_to: string, input: SendInput) {
        replies.push(readText(input));
        return { messageId: 'om_continuation' };
      },
    };
    await streamAgentReply(
      channel,
      { chatId: 'oc_chat', messageId: 'om_trigger' },
      events([
        { type: 'text', delta: 'hello' },
        { type: 'done', terminationReason: 'normal' },
      ]),
      false,
    );
    expect(appended).toEqual(['hello', 'hello']);
    expect(replies).toEqual([]);
    const failing = {
      ...channel,
      async stream() {
        throw new Error('stream failed before consuming the producer');
      },
    };
    await streamAgentReply(
      failing,
      { chatId: 'oc_chat', messageId: 'om_trigger' },
      events([{ type: 'text', delta: 'fallback' }]),
      false,
    );
    expect(replies).toEqual(['fallback']);
  });

  it('splits a large fallback into independent bounded markdown messages', async () => {
    const replies: string[] = [];
    const continuations: Array<{
      to: string;
      markdown: string;
      options: { replyTo?: string; replyInThread?: boolean } | undefined;
    }> = [];
    await streamAgentReply(
      {
        async stream() {
          throw new Error('stream unavailable');
        },
        async reply(_message, input) {
          replies.push(readText(input));
          return { messageId: 'om_fallback' };
        },
        async send(to, input, options) {
          continuations.push({ to, markdown: readText(input), options });
          return { messageId: `om_${continuations.length}` };
        },
      },
      { chatId: 'oc_chat', messageId: 'om_trigger', threadId: 'omt_thread' },
      events([{ type: 'text', delta: `${'large paragraph\n\n'.repeat(70_000)}` }]),
      false,
    );

    expect(replies).toHaveLength(1);
    expect(continuations.length).toBeGreaterThan(0);
    expect(continuations.every((item) => item.to === 'oc_chat')).toBe(true);
    expect(continuations[0]?.options).toEqual({ replyTo: 'om_fallback', replyInThread: true });
    if (continuations.length > 1) {
      expect(continuations[1]?.options).toEqual({ replyTo: 'om_1', replyInThread: true });
    }
    expect([replies[0]!, ...continuations.map((item) => item.markdown)].join('')).toBe(
      'large paragraph\n\n'.repeat(70_000).trim(),
    );
  });

  it('bounds live appends and sends the remaining result after the finalized card', async () => {
    let appended = '';
    let finalized = '';
    const continuations: string[] = [];
    await streamAgentReply(
      {
        async stream(_to, input) {
          if (!('markdown' in input)) {
            throw new Error('unexpected card stream');
          }
          await input.markdown({
            messageId: 'om_stream',
            async append(value) {
              appended += value;
            },
            async setContent(value) {
              finalized = value;
            },
          });
          return { messageId: 'om_stream' };
        },
        async reply() {
          throw new Error('unexpected fallback');
        },
        async send(_to, input) {
          continuations.push(readText(input));
          return { messageId: `om_${continuations.length}` };
        },
      },
      { chatId: 'oc_chat', messageId: 'om_trigger' },
      events([{ type: 'text', delta: 'streamed line\n'.repeat(80_000) }]),
      false,
    );

    expect(appended.length).toBeLessThanOrEqual(20_000);
    expect(finalized.length).toBeGreaterThan(0);
    expect(continuations.length).toBeGreaterThan(0);
    expect(`${finalized}\n${continuations.join('')}`).toContain('streamed line');
  });

  it('finalizes partial text with a bounded warning after a terminal protocol failure', async () => {
    const contents: string[] = [];
    await streamAgentReply(
      {
        async stream(_to, input) {
          if (!('markdown' in input)) {
            throw new Error('unexpected card stream');
          }
          await input.markdown({
            messageId: 'om_reply',
            async append() {},
            async setContent(value: string) {
              contents.push(value);
            },
          });
          return { messageId: 'om_reply' };
        },
        async reply() {
          throw new Error('unexpected fallback');
        },
        async send() {
          throw new Error('unexpected continuation');
        },
      },
      { chatId: 'oc_chat', messageId: 'om_trigger' },
      events([
        { type: 'text', delta: '已经生成的回答' },
        { type: 'error', message: 'Pi RPC protocol error: bounded failure', terminationReason: 'failed' },
      ]),
      false,
    );
    expect(contents).toEqual(['已经生成的回答\n\n运行失败：Pi RPC protocol error: bounded failure']);
  });

  it('replaces SDK no-content output with an explicit terminal status', async () => {
    const contents: string[] = [];
    await streamAgentReply(
      {
        async stream(_to, input) {
          if (!('markdown' in input)) {
            throw new Error('unexpected card stream');
          }
          await input.markdown({
            messageId: 'om_reply',
            async append() {},
            async setContent(value: string) {
              contents.push(value);
            },
          });
          return { messageId: 'om_reply' };
        },
        async reply() {
          throw new Error('unexpected fallback');
        },
        async send() {
          throw new Error('unexpected continuation');
        },
      },
      { chatId: 'oc_chat', messageId: 'om_trigger' },
      events([{ type: 'done', terminationReason: 'interrupted' }]),
      false,
    );
    expect(contents).toEqual(['运行已中断。']);
  });
});

async function* events(values: AgentEvent[]) {
  yield* values;
}

function readText(input: SendInput): string {
  if ('text' in input) {
    return input.text;
  }
  if ('markdown' in input) {
    return input.markdown;
  }
  if ('post' in input) {
    const post = input.post as { zh_cn?: { content?: Array<Array<{ tag?: string; text?: string }>> } };
    return post.zh_cn?.content?.[0]?.[0]?.text ?? '';
  }
  return '';
}
