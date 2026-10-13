import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentEvent } from '../agent/types.js';
import type { ChannelPort } from '../bot/channel.js';
import { larkMarkdownPost, MAX_LARK_MARKDOWN_CONTENT_BYTES, splitMarkdownForLark } from './markdown-splitter.js';
import { TextReplyRenderer } from './text-renderer.js';

const MAX_STREAM_PREVIEW_CHARS = 20_000;

/**
 * Sends incremental Markdown through channel.stream and preserves a
 * structure-aware Markdown fallback when streaming setup or updates fail.
 *
 * CardKit streaming has its own smaller element limit. Only a bounded preview
 * is appended while the run is active; the first complete, balanced chunk is
 * installed at the end and any remainder becomes ordinary 28,000-byte
 * Markdown messages. This avoids relying on character-only SDK rollover for
 * tables and fenced code blocks.
 */
export async function streamAgentReply(
  channel: Pick<ChannelPort, 'stream' | 'reply' | 'send'>,
  message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
  events: AsyncIterable<AgentEvent>,
  showToolCalls: boolean,
): Promise<void> {
  const renderer = new TextReplyRenderer();
  let continuationChunks: string[] = [];
  let streamResult: unknown;
  try {
    streamResult = await channel.stream(
      message.chatId,
      {
        markdown: async (controller) => {
          let previewChars = 0;
          for await (const event of events) {
            renderer.apply(event, showToolCalls);
            if (event.type === 'text' && previewChars < MAX_STREAM_PREVIEW_CHARS) {
              const preview = safePrefix(event.delta, MAX_STREAM_PREVIEW_CHARS - previewChars);
              if (preview) {
                await controller.append(preview);
                previewChars += preview.length;
              }
            }
          }

          const final = renderer.render(showToolCalls);
          const cardChunks = splitMarkdownForLark(final, MAX_LARK_MARKDOWN_CONTENT_BYTES);
          await controller.setContent(cardChunks[0]!);
          continuationChunks = cardChunks.slice(1);
        },
      },
      { replyTo: message.messageId, replyInThread: Boolean(message.threadId) },
    );
  } catch {
    // If the SDK fails after it started the producer this contains the
    // accumulated result. A start-time failure cannot have consumed events,
    // so drain them before sending the explicit Markdown fallback.
    if (!renderer.hasOutput()) {
      for await (const event of events) {
        renderer.apply(event, showToolCalls);
      }
    }
    await sendMarkdownFallback(channel, message, renderer.render(showToolCalls));
    return;
  }

  if (continuationChunks.length) {
    await sendMarkdownContinuations(channel, message, continuationChunks, messageId(streamResult) ?? message.messageId);
  }
}

async function sendMarkdownFallback(
  channel: Pick<ChannelPort, 'reply' | 'send'>,
  message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
  markdown: string,
): Promise<void> {
  const chunks = splitMarkdownForLark(markdown);
  const first = await channel.reply(message, { post: larkMarkdownPost(chunks[0]!) });
  await sendMarkdownContinuations(channel, message, chunks.slice(1), messageId(first) ?? message.messageId);
}

async function sendMarkdownContinuations(
  channel: Pick<ChannelPort, 'send'>,
  message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
  chunks: string[],
  firstReplyTarget: string,
): Promise<void> {
  let replyTo = firstReplyTarget;
  for (const chunk of chunks) {
    const result = await channel.send(
      message.chatId,
      { post: larkMarkdownPost(chunk) },
      { replyTo, replyInThread: Boolean(message.threadId) },
    );
    replyTo = messageId(result) ?? replyTo;
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

function messageId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = (value as { messageId?: unknown }).messageId;
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}
