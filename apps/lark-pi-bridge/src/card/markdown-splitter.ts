/**
 * Feishu documents a 30 KB request-body limit for rich-text and card
 * messages. Leave 2 KB of headroom for transport fields outside `content`.
 * This outbound limit is independent from the local Pi RPC frame limit.
 */
export const MAX_LARK_MARKDOWN_CONTENT_BYTES = 28_000;

/** Feishu documents 150 KB for text messages; keep 10 KB of headroom. */
export const MAX_LARK_TEXT_CONTENT_BYTES = 140_000;

export interface LarkMarkdownPost {
  zh_cn: {
    title: string;
    content: Array<Array<{ tag: 'md'; text: string }>>;
  };
}

type MarkdownBlock =
  | { kind: 'text'; value: string }
  | { kind: 'code'; opening: string; body: string; marker: string }
  | { kind: 'table'; header: string; separator: string; rows: string[] };

/** Build the exact post shape sent through the Channel SDK. */
export function larkMarkdownPost(markdown: string): LarkMarkdownPost {
  return {
    zh_cn: {
      title: '',
      content: [[{ tag: 'md', text: markdown }]],
    },
  };
}

/** Measure the serialized API `content` field, including JSON escaping. */
export function larkMarkdownContentBytes(markdown: string): number {
  return Buffer.byteLength(JSON.stringify(larkMarkdownPost(markdown)), 'utf8');
}

/**
 * Split Markdown into independently renderable post messages.
 *
 * - ordinary prose prefers paragraph, line, and whitespace boundaries;
 * - fenced code blocks are closed and reopened between messages;
 * - pipe tables split only between rows and repeat their header/separator;
 * - UTF-16 surrogate pairs are never cut in half;
 * - every returned value fits after serialization as a Feishu post content.
 */
export function splitMarkdownForLark(markdown: string, maxContentBytes = MAX_LARK_MARKDOWN_CONTENT_BYTES): string[] {
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes <= larkMarkdownContentBytes('')) {
    throw new Error('maxContentBytes must fit a non-empty Lark markdown post');
  }
  if (larkMarkdownContentBytes(markdown) <= maxContentBytes) {
    return [markdown];
  }

  const pieces = parseBlocks(markdown).flatMap((block) => splitBlock(block, maxContentBytes));
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (!piece) {
      continue;
    }
    if (larkMarkdownContentBytes(`${current}${piece}`) <= maxContentBytes) {
      current += piece;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    if (larkMarkdownContentBytes(piece) > maxContentBytes) {
      throw new Error('markdown splitter produced an oversized piece');
    }
    current = piece;
  }
  if (current || chunks.length === 0) {
    chunks.push(current);
  }
  return chunks;
}

/** Pack already-balanced Markdown fragments without breaking their structure. */
export function packMarkdownFragmentsForLark(
  fragments: string[],
  maxContentBytes = MAX_LARK_MARKDOWN_CONTENT_BYTES,
): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const fragment of fragments) {
    if (!fragment) {
      continue;
    }
    if (larkMarkdownContentBytes(fragment) > maxContentBytes) {
      throw new Error('cannot pack an oversized Markdown fragment');
    }
    const separator =
      !current || current.endsWith('\n\n') || fragment.startsWith('\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    const candidate = `${current}${separator}${fragment}`;
    if (larkMarkdownContentBytes(candidate) <= maxContentBytes) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current = fragment;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function parseBlocks(markdown: string): MarkdownBlock[] {
  const lines = splitLines(markdown);
  const blocks: MarkdownBlock[] = [];
  let text = '';
  const flushText = (): void => {
    if (text) {
      blocks.push({ kind: 'text', value: text });
      text = '';
    }
  };

  for (let index = 0; index < lines.length;) {
    const opening = fenceOpening(lines[index]!);
    if (opening) {
      flushText();
      let end = index + 1;
      while (end < lines.length && !isFenceClosing(lines[end]!, opening.marker)) {
        end += 1;
      }
      const hasClosing = end < lines.length;
      const body = lines.slice(index + 1, hasClosing ? end : lines.length).join('');
      blocks.push({ kind: 'code', opening: lines[index]!, body, marker: opening.marker });
      index = hasClosing ? end + 1 : lines.length;
      continue;
    }

    if (index + 1 < lines.length && isTableHeader(lines[index]!, lines[index + 1]!)) {
      flushText();
      const rows: string[] = [];
      let end = index + 2;
      while (end < lines.length && isTableRow(lines[end]!)) {
        rows.push(lines[end]!);
        end += 1;
      }
      blocks.push({
        kind: 'table',
        header: lines[index]!,
        separator: lines[index + 1]!,
        rows,
      });
      index = end;
      continue;
    }

    text += lines[index]!;
    index += 1;
  }
  flushText();
  return blocks;
}

function splitBlock(block: MarkdownBlock, maxContentBytes: number): string[] {
  if (block.kind === 'text') {
    return splitText(block.value, maxContentBytes);
  }
  if (block.kind === 'code') {
    return splitCodeBlock(block, maxContentBytes);
  }
  return splitTable(block, maxContentBytes);
}

function splitCodeBlock(block: Extract<MarkdownBlock, { kind: 'code' }>, maxContentBytes: number): string[] {
  const opening = ensureTrailingNewline(block.opening);
  const closing = `${block.marker}\n`;
  const whole = `${opening}${block.body}${block.body.endsWith('\n') || !block.body ? '' : '\n'}${closing}`;
  if (larkMarkdownContentBytes(whole) <= maxContentBytes) {
    return [whole];
  }
  if (larkMarkdownContentBytes(`${opening}${closing}`) >= maxContentBytes) {
    return splitText(`${block.opening}${block.body}${closing}`, maxContentBytes);
  }

  const bodyChunks = splitTextWithAffixes(block.body, opening, `\n${closing}`, maxContentBytes);
  return bodyChunks.map((body) => `${opening}${body}${body.endsWith('\n') || !body ? '' : '\n'}${closing}`);
}

function splitTable(block: Extract<MarkdownBlock, { kind: 'table' }>, maxContentBytes: number): string[] {
  const prefix = `${ensureTrailingNewline(block.header)}${ensureTrailingNewline(block.separator)}`;
  const whole = `${prefix}${block.rows.join('')}`;
  if (larkMarkdownContentBytes(whole) <= maxContentBytes) {
    return [whole];
  }
  if (larkMarkdownContentBytes(prefix) >= maxContentBytes) {
    return splitLiteralMarkdown(whole, maxContentBytes);
  }

  const chunks: string[] = [];
  let current = prefix;
  let rowCount = 0;
  for (const row of block.rows) {
    if (larkMarkdownContentBytes(`${current}${row}`) <= maxContentBytes) {
      current += row;
      rowCount += 1;
      continue;
    }
    if (rowCount > 0) {
      chunks.push(current);
      current = prefix;
      rowCount = 0;
    }
    if (larkMarkdownContentBytes(`${prefix}${row}`) <= maxContentBytes) {
      current += row;
      rowCount = 1;
      continue;
    }

    // A single table row cannot remain a valid row and fit the API limit.
    // Preserve the header and complete row as balanced literal fragments
    // instead of emitting malformed or truncated table syntax.
    chunks.push(...splitLiteralMarkdown(`${prefix}${row}`, maxContentBytes));
  }
  if (rowCount > 0 || chunks.length === 0) {
    chunks.push(current);
  }
  return chunks;
}

function splitLiteralMarkdown(value: string, maxContentBytes: number): string[] {
  const opening = '```text\n';
  const closing = '```\n';
  if (larkMarkdownContentBytes(`${opening}${closing}`) >= maxContentBytes) {
    return splitText(value, maxContentBytes);
  }
  return splitTextWithAffixes(value, opening, `\n${closing}`, maxContentBytes).map(
    (part) => `${opening}${part}${part.endsWith('\n') || !part ? '' : '\n'}${closing}`,
  );
}

function splitTextWithAffixes(value: string, prefix: string, suffix: string, maxContentBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining) {
    const index = fittingPrefixIndex(remaining, maxContentBytes, prefix, suffix);
    if (index <= 0) {
      throw new Error('markdown affixes leave no room for content');
    }
    const boundary = preferredBoundary(remaining, index);
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  return chunks.length ? chunks : [''];
}

function splitText(value: string, maxContentBytes: number): string[] {
  if (larkMarkdownContentBytes(value) <= maxContentBytes) {
    return [value];
  }
  const chunks: string[] = [];
  let remaining = value;
  while (remaining) {
    const index = fittingPrefixIndex(remaining, maxContentBytes);
    if (index <= 0) {
      throw new Error('maxContentBytes cannot fit one Markdown code point');
    }
    const boundary = preferredBoundary(remaining, index);
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  return chunks;
}

function fittingPrefixIndex(value: string, maxContentBytes: number, prefix = '', suffix = ''): number {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = safeUtf16Boundary(value, middle);
    if (larkMarkdownContentBytes(`${prefix}${value.slice(0, candidate)}${suffix}`) <= maxContentBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let result = safeUtf16Boundary(value, low);
  while (result > 0 && larkMarkdownContentBytes(`${prefix}${value.slice(0, result)}${suffix}`) > maxContentBytes) {
    result = previousCodePointBoundary(value, result);
  }
  return result;
}

function preferredBoundary(value: string, maximum: number): number {
  const safeMaximum = safeUtf16Boundary(value, maximum);
  const minimumPreferred = Math.floor(safeMaximum * 0.5);
  for (const token of ['\n\n', '\n', ' ']) {
    const found = value.lastIndexOf(token, safeMaximum - token.length);
    if (found >= minimumPreferred) {
      return safeUtf16Boundary(value, found + token.length);
    }
  }
  return safeMaximum;
}

function safeUtf16Boundary(value: string, index: number): number {
  const bounded = Math.max(0, Math.min(index, value.length));
  if (
    bounded > 0 &&
    bounded < value.length &&
    isHighSurrogate(value.charCodeAt(bounded - 1)) &&
    isLowSurrogate(value.charCodeAt(bounded))
  ) {
    return bounded - 1;
  }
  return bounded;
}

function previousCodePointBoundary(value: string, index: number): number {
  const previous = Math.max(0, index - 1);
  return safeUtf16Boundary(value, previous);
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function splitLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function fenceOpening(line: string): { marker: string } | undefined {
  const match = withoutLineEnding(line).match(/^\s{0,3}(`{3,}|~{3,})[^\n]*$/);
  return match?.[1] ? { marker: match[1] } : undefined;
}

function isFenceClosing(line: string, marker: string): boolean {
  const content = withoutLineEnding(line).trim();
  return content.length >= marker.length && [...content].every((character) => character === marker[0]);
}

function isTableHeader(header: string, separator: string): boolean {
  return withoutLineEnding(header).includes('|') && isTableSeparator(separator);
}

function isTableSeparator(line: string): boolean {
  const content = withoutLineEnding(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = content.split('|').map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isTableRow(line: string): boolean {
  const content = withoutLineEnding(line);
  return Boolean(content.trim()) && content.includes('|');
}

function withoutLineEnding(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/, '') : line;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}
