import { randomUUID } from 'node:crypto';
import { CanonicalMessage, CanonicalTool, CanonicalToolCall, textFromContent } from '../../../protocol/canonical.js';

/**
 * Prompt-simulated tool calling for the Trae `solo_work_lite` pool.
 *
 * The SOLO work pool speaks `llm_utils_chat` but has no native tool transport,
 * and the `solo_agent`/chat_sessions pipeline is an autonomous server-side
 * agent that ignores injected protocols. The work-tier pool, however, behaves
 * as a plain LLM and follows the `<toolcall>` protocol below — verified
 * end-to-end against the live upstream (see docs/verification.md).
 *
 * - The advertised catalog is rendered into a compact system directive.
 * - Assistant tool-call history and tool results are flattened into text so
 *   the conversation continues across turns.
 * - A streaming parser extracts complete `<toolcall>` blocks from the model
 *   text and re-emits them as canonical `tool_call_delta` events; the
 *   upstream occasionally replays the same block several times, so adjacent
 *   duplicate calls are dropped; malformed blocks degrade to plain text.
 */

export const TOOL_CALL_OPEN = '<toolcall>';
export const TOOL_CALL_CLOSE = '</toolcall>';

export function renderToolsSystemPrompt(tools: CanonicalTool[]): string {
  const entries = tools
    .filter((tool) => tool.type === 'function' && tool.function.name)
    .map((tool) => {
      const fn = tool.function;
      const properties = (fn.parameters as { properties?: Record<string, unknown> })?.properties;
      const params = properties ? Object.keys(properties).slice(0, 12).join(',') : '';
      return params ? `${fn.name}(${params})` : fn.name;
    });
  if (!entries.length) {
    return '';
  }
  return [
    '',
    '<toolcall_protocol>',
    'When you need a tool, output ONLY this XML block (valid JSON inside):',
    `${TOOL_CALL_OPEN}{"name":"ToolName","params":{"arg":"value"}}${TOOL_CALL_CLOSE}`,
    'Rules:',
    '- JSON must have "name" and "params"',
    '- Use EXACT tool names from the list (case-sensitive)',
    '- Do not wrap toolcall in markdown fences',
    '- After <tool_result>, continue until the user question is answered',
    `Tools (${entries.length}): ${entries.join(', ')}`,
    '</toolcall_protocol>',
  ].join('\n');
}

/**
 * Flatten tool-call history into a text transcript. Assistant turns with
 * `tool_calls` render as their text plus verbatim toolcall blocks; tool
 * results render as `<tool_result>` payloads so the model keeps the protocol
 * going across turns.
 */
export function toolTranscriptFromMessages(messages: CanonicalMessage[]): string {
  const namesByCallId = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.id) {
        namesByCallId.set(call.id, call.function.name);
      }
    }
  }
  const parts: string[] = [];
  for (const message of messages) {
    const content = textFromContent(message.content);
    const calls = message.tool_calls ?? [];
    if (message.role === 'tool' && message.tool_call_id) {
      const name = message.name ?? namesByCallId.get(message.tool_call_id) ?? 'unknown-tool';
      parts.push(`<tool_result tool="${name}">${content}</tool_result>`);
      continue;
    }
    if (message.role === 'assistant' && calls.length) {
      const blocks = calls.map((call) => renderCallBlock(call)).join('');
      parts.push(`${content ? content + '\n\n' : ''}${blocks}`);
      continue;
    }
    if (!content.trim()) {
      continue;
    }
    parts.push(content);
  }
  return parts.join('\n\n');
}

function renderCallBlock(call: CanonicalToolCall): string {
  return `${TOOL_CALL_OPEN}${JSON.stringify({ name: call.function.name, params: safeParseArguments(call.function.arguments) })}${TOOL_CALL_CLOSE}`;
}

function safeParseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export type SimulatedToolEvent =
  { type: 'text'; delta: string } | { type: 'tool_call'; tool_calls: CanonicalToolCall[] };

/**
 * Streaming parser for simulated toolcall blocks.
 *
 * Feed it the text deltas produced by the upstream stream (in order); it
 * yields the safe text outside blocks plus canonical tool calls for every
 * complete, parseable block. Adjacent duplicate calls are dropped (the
 * upstream replays identical blocks). A partial open marker is buffered until
 * the block closes or the stream ends (`flush()` degrades anything unparsed
 * back to text). This survives deltas that split the markers arbitrarily.
 */
export class ToolCallStreamParser {
  private buffer = '';
  private inBlock = false;
  private blockBody = '';
  private readonly pending: CanonicalToolCall[] = [];
  private lastCallKey = '';
  private index = 0;

  push(delta: string): SimulatedToolEvent[] {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): SimulatedToolEvent[] {
    return this.drain(true);
  }

  get toolCalls(): CanonicalToolCall[] {
    return [...this.pending];
  }

  private drain(final: boolean): SimulatedToolEvent[] {
    const events: SimulatedToolEvent[] = [];
    let safeText = '';
    for (;;) {
      if (!this.inBlock) {
        const open = this.buffer.indexOf(TOOL_CALL_OPEN);
        if (open < 0) {
          // Keep a potential partial open-marker tail buffered mid-stream.
          const keep = final ? 0 : partialSuffixLength(this.buffer, TOOL_CALL_OPEN);
          safeText += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          break;
        }
        safeText += this.buffer.slice(0, open);
        this.buffer = this.buffer.slice(open + TOOL_CALL_OPEN.length);
        this.inBlock = true;
        this.blockBody = '';
        continue;
      }
      const close = this.buffer.indexOf(TOOL_CALL_CLOSE);
      if (close < 0) {
        // Keep a potential partial close-marker tail buffered mid-stream so a
        // marker split across deltas is still recognized next round.
        const keep = final ? 0 : partialSuffixLength(this.buffer, TOOL_CALL_CLOSE);
        this.blockBody += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        if (final) {
          // Unterminated block at end of stream: degrade to text.
          safeText += `${TOOL_CALL_OPEN}${this.blockBody}`;
          this.inBlock = false;
          this.blockBody = '';
        }
        break;
      }
      this.blockBody += this.buffer.slice(0, close);
      this.buffer = this.buffer.slice(close + TOOL_CALL_CLOSE.length);
      this.inBlock = false;
      const body = this.blockBody;
      this.blockBody = '';
      const call = parseCallBody(body.trim(), this.index);
      if (!call) {
        safeText += `${TOOL_CALL_OPEN}${body}${TOOL_CALL_CLOSE}`;
        continue;
      }
      const key = `${call.function.name}:${call.function.arguments}`;
      if (key === this.lastCallKey) {
        // The upstream replays identical adjacent blocks; drop the duplicate.
        continue;
      }
      this.lastCallKey = key;
      this.index += 1;
      this.pending.push(call);
      events.push({ type: 'tool_call', tool_calls: [call] });
    }
    if (safeText) {
      events.unshift({ type: 'text', delta: safeText });
    }
    return events;
  }
}

function parseCallBody(body: string, index: number): CanonicalToolCall | null {
  const stripped = stripCodeFence(body);
  try {
    const parsed = JSON.parse(stripped) as { name?: unknown; params?: unknown; arguments?: unknown };
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
      return null;
    }
    const rawParams = parsed.params ?? parsed.arguments;
    const args =
      rawParams === undefined || rawParams === null
        ? {}
        : typeof rawParams === 'string'
          ? safeParseArguments(rawParams)
          : rawParams;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return null;
    }
    return {
      id: `solo_tool_${index}_${randomUUID().slice(0, 8)}`,
      type: 'function',
      function: { name: parsed.name.trim(), arguments: JSON.stringify(args) },
      index,
    };
  } catch {
    return null;
  }
}

function stripCodeFence(body: string): string {
  const fenced = body.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : body;
}

/** Longest suffix of `text` that is a proper prefix of `marker`. */
function partialSuffixLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (marker.startsWith(text.slice(text.length - len))) {
      return len;
    }
  }
  return 0;
}
