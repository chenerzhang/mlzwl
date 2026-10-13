import { TextDecoder } from 'node:util';

// Pi's authoritative agent_end event includes every message produced by the
// low-level run. Tool-heavy runs can therefore legitimately exceed 1 MiB even
// when each individual tool result is bounded.
export const MAX_PI_JSONL_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_PI_JSONL_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface PiJsonlLimits {
  maxLineBytes?: number;
  maxOutputBytes?: number;
}

/**
 * Strict, bounded LF-delimited JSON decoder for Pi stdout.
 *
 * It deliberately does not use readline: buffering and byte limits must be
 * enforced before UTF-8 decoding or JSON parsing. LF is the only record
 * boundary; the optional CR immediately before LF is stripped as Pi documents.
 */
export class StrictPiJsonlDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly maxLineBytes: number;
  private readonly maxOutputBytes: number;
  private buffered = Buffer.alloc(0);
  private totalBytes = 0;
  private lineNumber = 0;

  constructor(limits: PiJsonlLimits = {}) {
    this.maxLineBytes = positiveInteger(limits.maxLineBytes, MAX_PI_JSONL_LINE_BYTES, 'maxLineBytes');
    this.maxOutputBytes = positiveInteger(limits.maxOutputBytes, MAX_PI_JSONL_OUTPUT_BYTES, 'maxOutputBytes');
    if (this.maxOutputBytes < this.maxLineBytes) {
      throw new Error('Pi JSONL maxOutputBytes cannot be smaller than maxLineBytes');
    }
  }

  push(chunk: Buffer | Uint8Array, onRecord?: (record: unknown) => void): unknown[] {
    const bytes = Buffer.from(chunk);
    if (bytes.length) {
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, bytes]) : bytes;
    }

    const records: unknown[] = [];
    let newline = this.buffered.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      this.totalBytes += newline + 1;
      if (this.totalBytes > this.maxOutputBytes) {
        throw new PiJsonlProtocolError(`Pi JSONL output exceeded ${this.maxOutputBytes} bytes`);
      }
      const record = this.parseLine(line);
      if (onRecord) {
        onRecord(record);
      } else {
        records.push(record);
      }
      newline = this.buffered.indexOf(0x0a);
    }
    if (this.buffered.length > this.maxLineBytes) {
      throw new PiJsonlProtocolError(`Pi JSONL line exceeded ${this.maxLineBytes} bytes`);
    }
    if (this.totalBytes + this.buffered.length > this.maxOutputBytes) {
      throw new PiJsonlProtocolError(`Pi JSONL output exceeded ${this.maxOutputBytes} bytes`);
    }
    return records;
  }

  /** Begin a new bounded operation without discarding a partial record. */
  resetOutputBudget(): void {
    this.totalBytes = 0;
  }

  finish(): void {
    if (this.buffered.length) {
      throw new PiJsonlProtocolError('Pi JSONL stream ended with an unterminated record');
    }
  }

  private parseLine(line: Buffer): unknown {
    this.lineNumber++;
    const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    if (!content.length) {
      throw new PiJsonlProtocolError(`Pi JSONL line ${this.lineNumber} is empty`);
    }
    if (line.length > this.maxLineBytes) {
      throw new PiJsonlProtocolError(`Pi JSONL line ${this.lineNumber} exceeded ${this.maxLineBytes} bytes`);
    }

    let text: string;
    try {
      text = this.decoder.decode(content);
    } catch {
      throw new PiJsonlProtocolError(`Pi JSONL line ${this.lineNumber} is not valid UTF-8`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PiJsonlProtocolError(`Pi JSONL line ${this.lineNumber} is not valid JSON`);
    }
  }
}

export class PiJsonlProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiJsonlProtocolError';
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`Pi JSONL ${name} must be a positive integer`);
  }
  return result;
}
