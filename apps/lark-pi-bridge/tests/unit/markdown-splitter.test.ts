import { describe, expect, it } from 'vitest';
import {
  larkMarkdownContentBytes,
  MAX_LARK_MARKDOWN_CONTENT_BYTES,
  MAX_LARK_TEXT_CONTENT_BYTES,
  packMarkdownFragmentsForLark,
  splitMarkdownForLark,
} from '../../src/card/markdown-splitter.js';

describe('splitMarkdownForLark', () => {
  it('uses conservative bounds below Feishu rich-text and text limits', () => {
    expect(MAX_LARK_MARKDOWN_CONTENT_BYTES).toBe(28_000);
    expect(MAX_LARK_TEXT_CONTENT_BYTES).toBe(140_000);
  });

  it('keeps serialized message content within the 28,000-byte boundary without losing prose', () => {
    const paragraph = `正文😀${'x'.repeat(10_000)}\n\n`;
    const markdown = paragraph.repeat(100);
    const chunks = splitMarkdownForLark(markdown);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(markdown);
    expect(chunks.every((chunk) => larkMarkdownContentBytes(chunk) <= MAX_LARK_MARKDOWN_CONTENT_BYTES)).toBe(true);
    expect(chunks.every((chunk) => !endsWithHighSurrogate(chunk))).toBe(true);
  });

  it('closes and reopens fenced code blocks instead of cutting their format', () => {
    const markdown = `before\n\n\`\`\`ts\n${'const value = 1;\n'.repeat(30)}\`\`\`\n\nafter\n`;
    const chunks = splitMarkdownForLark(markdown, 220);

    expect(chunks.length).toBeGreaterThan(2);
    const codeChunks = chunks.filter((chunk) => chunk.startsWith('```ts'));
    expect(codeChunks.length).toBeGreaterThan(1);
    expect(codeChunks.every((chunk) => chunk.includes('\n```'))).toBe(true);
    expect(codeChunks.map(codeBody).join('')).toBe('const value = 1;\n'.repeat(30));
    expect(chunks.every((chunk) => larkMarkdownContentBytes(chunk) <= 220)).toBe(true);
  });

  it('splits tables only between rows and repeats the header and separator', () => {
    const header = '| name | value |\n';
    const separator = '| --- | --- |\n';
    const rows = Array.from({ length: 30 }, (_, index) => `| row-${index} | ${'v'.repeat(20)} |\n`);
    const markdown = `${header}${separator}${rows.join('')}\ntail\n`;
    const chunks = splitMarkdownForLark(markdown, 260);
    const tableChunks = chunks.filter((chunk) => chunk.startsWith(header));

    expect(tableChunks.length).toBeGreaterThan(1);
    expect(tableChunks.every((chunk) => chunk.startsWith(`${header}${separator}`))).toBe(true);
    expect(
      tableChunks.flatMap((chunk) =>
        chunk
          .split('\n')
          .slice(2)
          .filter((line) => line.startsWith('| row-')),
      ),
    ).toEqual(rows.map((row) => row.trimEnd()));
    expect(chunks.every((chunk) => larkMarkdownContentBytes(chunk) <= 260)).toBe(true);
  });

  it('repacks balanced fragments without splitting code fences or merging adjacent blocks', () => {
    const fragments = [
      '```ts\nconst a = 1;\n```\n',
      '```ts\nconst b = 2;\n```\n',
      '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    ];
    const chunks = packMarkdownFragmentsForLark(fragments, 180);

    expect(chunks.join('')).toBe(fragments.join('\n'));
    expect(chunks.every((chunk) => larkMarkdownContentBytes(chunk) <= 180)).toBe(true);
  });

  it('preserves a repeated table header when one row alone exceeds the limit', () => {
    const header = '| name | value |\n| --- | --- |\n';
    const markdown = `${header}| huge | ${'v'.repeat(600)} |\n`;
    const chunks = splitMarkdownForLark(markdown, 180);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain(header);
    expect(chunks.join('')).toContain('| huge |');
    expect(chunks.every((chunk) => larkMarkdownContentBytes(chunk) <= 180)).toBe(true);
  });

  it('accounts for JSON escaping rather than checking source text bytes only', () => {
    const markdown = `${'"\\\n'.repeat(100)}tail`;
    const chunks = splitMarkdownForLark(markdown, 180);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(markdown);
    expect(chunks.every((chunk) => larkMarkdownContentBytes(chunk) <= 180)).toBe(true);
  });
});

function codeBody(chunk: string): string {
  const lines = chunk.split('\n');
  const closing = lines.indexOf('```', 1);
  return lines.slice(1, closing).join('\n') + '\n';
}

function endsWithHighSurrogate(value: string): boolean {
  if (!value) {
    return false;
  }
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}
