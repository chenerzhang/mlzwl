import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ConsoleLogger, Inject, Injectable, type LogLevel } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { redact } from './redact.js';

/**
 * 单行日志记录。
 *
 * 字段故意少：`ts` / `level` / `context` / `message` 足够定位问题，而 `message`
 * 已经在写盘前过完 `redact`，所以整行可以原样回给浏览器。
 */
export interface FileLogRecord {
  /** ISO 8601 时间戳。 */
  ts: string;
  level: string;
  context: string;
  message: string;
}

/** 单个日志文件的上限（5 MB）。超过就轮转。 */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 落盘日志。
 *
 * 默认关闭（`LOG_TO_FILE=false`）。关闭时本服务不会被装进 Nest，`main.ts` 不
 * 调用 `app.useLogger`，控制台输出与加这个文件之前**完全一致**。
 *
 * 开启后继承 `ConsoleLogger` 并重写 `printMessages`：控制台那一路仍由 Nest 自己
 * 输出（颜色、级别过滤、`NEST_LOG_LEVEL` 都不变），这里只多落一份到磁盘。
 * 不自己拼控制台格式的原因就在于此——自己拼一定会和默认输出跑偏。
 *
 * 轮转策略对齐 `guoapp/native/core/diagnostics.go`：单文件超过 5 MB 时把
 * `app.jsonl` 改名覆盖 `app.1.jsonl`，再新建 `app.jsonl`，**只保留 2 个文件**。
 * 写入串行化（`queue`），避免并发 append 交织出半行，也让轮转不会撞上写入。
 */
@Injectable()
export class FileLoggerService extends ConsoleLogger {
  private readonly dir: string;
  private readonly file: string;
  private readonly rotated: string;

  /** 串行写队列：日志顺序即调用顺序，轮转与 append 不会互相插入。 */
  private queue: Promise<void> = Promise.resolve();
  /** 当前文件字节数缓存，`-1` 表示还没读过。省掉每行一次 `stat`。 */
  private bytes = -1;

  constructor(@Inject(CONFIG) config: Config) {
    super();
    this.dir = join(config.DATA_DIR, 'logs');
    this.file = join(this.dir, 'app.jsonl');
    this.rotated = join(this.dir, 'app.1.jsonl');
  }

  /**
   * 控制台输出 + 落盘。
   *
   * 重写这一层而不是逐个重写 `log` / `warn` / ...：`printMessages` 是 Nest 把
   * 「级别 + 上下文 + 消息」汇齐的唯一入口，且已经处理了「最后一个字符串参数
   * 是 context」这类约定。级别被过滤掉时这里也不会被调用，磁盘与控制台口径一致。
   */
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel: LogLevel = 'log',
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    params?: Record<string, any>,
  ): void {
    super.printMessages(messages, context, logLevel, writeStreamType, errorStack, params);

    const record: FileLogRecord = {
      ts: new Date().toISOString(),
      level: logLevel,
      context: context ?? '',
      message: redact(formatMessage(messages, errorStack)),
    };
    this.enqueue(record);
  }

  /**
   * 读当前 `app.jsonl` 的尾部 `n` 行。
   *
   * 先等排队的写入落完：日志是异步 append 的，不等的话「刚发生的错误」可能还在
   * 队列里，接口返回的尾部就缺了最关心的那几条。
   *
   * 用 `readFile` 整体读入再切分：文件上限 5 MB，为此实现流式反向读取不划算。
   * 文件不存在（没开文件日志，或还没写过）时返回空数组。
   */
  async readRecentLines(n: number): Promise<string[]> {
    await this.queue;
    const text = await readFile(this.file, 'utf8').catch(() => null);
    if (text === null) {
      return [];
    }
    const lines = text.split('\n').filter((line) => line.length > 0);
    return lines.slice(Math.max(0, lines.length - n));
  }

  private enqueue(record: FileLogRecord): void {
    this.queue = this.queue.then(() => this.append(record)).catch(() => undefined);
  }

  private async append(record: FileLogRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const length = Buffer.byteLength(line);
    await mkdir(this.dir, { recursive: true });

    const size = await this.currentBytes();
    if (size + length > LOG_MAX_BYTES) {
      await this.rotate();
    }
    await appendFile(this.file, line, 'utf8');
    this.bytes += length;
  }

  private async currentBytes(): Promise<number> {
    if (this.bytes < 0) {
      const info = await stat(this.file).catch(() => null);
      this.bytes = info?.size ?? 0;
    }
    return this.bytes;
  }

  /**
   * 轮转：覆盖 `app.1.jsonl`，只保留 2 个文件。
   *
   * 先删旧备份再改名，不用「`rename` 直接覆盖」的 POSIX 语义：这在非 POSIX
   * 文件系统上会失败，而这里的写入已经串行化，不需要原子覆盖。
   */
  private async rotate(): Promise<void> {
    await rm(this.rotated, { force: true });
    await rename(this.file, this.rotated).catch(() => undefined);
    this.bytes = 0;
  }
}

/**
 * 把 Nest 传进来的消息数组压成一行文本。
 *
 * 对象用 `JSON.stringify`：日志里的对象通常是结构化上下文，序列化比 `[object
 * Object]` 有用。循环引用序列化失败时退回 `String()`，日志绝不能因为格式化抛错。
 */
function formatMessage(messages: unknown[], errorStack: unknown): string {
  const parts = messages.map(toText);
  if (typeof errorStack === 'string' && errorStack.length > 0) {
    parts.push(errorStack);
  }
  return parts.join(' ');
}

function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
