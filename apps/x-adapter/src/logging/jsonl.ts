import fs from 'node:fs';
import path from 'node:path';
import { env, intEnv, logFile as configuredLogFile } from '../config/env.js';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'cookie',
  'setcookie',
  'xjwttoken',
  'xidetoken',
  'xcloudidetoken',
  'xtraeaccesstoken',
  'cloudidejwt',
  'token',
  'accesstoken',
  'refreshtoken',
  'userjwt',
  'mstoken',
  'abogus',
  'ttwid',
  'ttscid',
  'sessionid',
  'sidguard',
  'larksuiteaccesstoken',
  'larksuitedpop',
  'secret',
  'password',
  'privatekey',
  'deviceprivatekey',
  'authcode',
  'authcodeinfo',
  'codeverifier',
  'deviceproof',
  'signature',
  'state',
  'logintraceid',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replaceAll('-', '').replaceAll('_', ''));
}

const DEFAULT_LOG_RETENTION_DAYS = 7;
const DEFAULT_LOG_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60_000;
let lastPrunedAt = 0;

function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function generatedLogPattern(basePath: string): RegExp {
  const extension = path.extname(basePath) || '.jsonl';
  const stem = path.basename(basePath, path.extname(basePath));
  const escape = (value: string) => value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  return new RegExp(`^${escape(stem)}-(\\d{4}-\\d{2}-\\d{2})(?:\\.(\\d+))?${escape(extension)}$`);
}

function datedLogPath(basePath: string, date: string, shard = 0): string {
  const extension = path.extname(basePath) || '.jsonl';
  const directory = path.dirname(basePath);
  const stem = path.basename(basePath, path.extname(basePath));
  return path.join(directory, `${stem}-${date}${shard ? `.${shard}` : ''}${extension}`);
}

function existingFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function logRetentionDays(): number {
  const days = intEnv('X_ADAPTER_LOG_RETENTION_DAYS', DEFAULT_LOG_RETENTION_DAYS);
  return days >= 0 ? days : DEFAULT_LOG_RETENTION_DAYS;
}

export function logMaxFileBytes(): number {
  const bytes = intEnv('X_ADAPTER_LOG_MAX_FILE_BYTES', DEFAULT_LOG_MAX_FILE_BYTES);
  return bytes >= 0 ? bytes : DEFAULT_LOG_MAX_FILE_BYTES;
}

export function logMaxTotalBytes(): number {
  const bytes = intEnv('X_ADAPTER_LOG_MAX_TOTAL_BYTES', DEFAULT_LOG_MAX_TOTAL_BYTES);
  return bytes >= 0 ? bytes : DEFAULT_LOG_MAX_TOTAL_BYTES;
}

export function requestLoggingEnabled(): boolean {
  const value = env('X_ADAPTER_REQUEST_LOGGING', '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

/**
 * Returns the active daily JSONL file. The configured X_ADAPTER_LOG_FILE is
 * treated as a base name: x-adapter.jsonl becomes x-adapter-YYYY-MM-DD.jsonl.
 */
export function logFile(now = new Date()): string {
  const basePath = configuredLogFile();
  const date = dateKey(now);
  const maxBytes = logMaxFileBytes();
  let shard = 0;
  let candidate = datedLogPath(basePath, date, shard);
  while (maxBytes > 0 && existingFileSize(candidate) >= maxBytes) {
    shard += 1;
    candidate = datedLogPath(basePath, date, shard);
  }
  return candidate;
}

type ManagedLogFile = { path: string; date: string; mtimeMs: number; size: number };

function managedLogFiles(basePath = configuredLogFile()): ManagedLogFile[] {
  const directory = path.dirname(basePath);
  const pattern = generatedLogPattern(basePath);
  try {
    const names = fs.readdirSync(directory);
    const datedFiles = names.flatMap((name): ManagedLogFile[] => {
      const match = pattern.exec(name);
      if (!match) {
        return [];
      }
      try {
        const stat = fs.statSync(path.join(directory, name));
        return stat.isFile()
          ? [{ path: path.join(directory, name), date: match[1], mtimeMs: stat.mtimeMs, size: stat.size }]
          : [];
      } catch {
        return [];
      }
    });
    // Versions before daily rotation wrote to the base file directly. Treat it
    // as managed too so an upgrade cannot leave an unbounded legacy file behind.
    try {
      const stat = fs.statSync(basePath);
      if (stat.isFile()) {
        datedFiles.push({
          path: basePath,
          date: dateKey(new Date(stat.mtimeMs)),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    } catch {
      // The normal case: no pre-rotation base file exists.
    }
    return datedFiles;
  } catch {
    return [];
  }
}

/** Removes expired daily files and then enforces the aggregate size budget. */
export function pruneLogFiles(now = new Date(), activeFile?: string): void {
  try {
    const retentionDays = logRetentionDays();
    const today = new Date(`${dateKey(now)}T00:00:00.000Z`);
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(retentionDays - 1, 0));
    const cutoffKey = dateKey(cutoff);
    let files = managedLogFiles();
    if (retentionDays > 0) {
      for (const file of files.filter((candidate) => candidate.date < cutoffKey)) {
        fs.rmSync(file.path, { force: true });
      }
      files = managedLogFiles();
    }

    const maxTotalBytes = logMaxTotalBytes();
    if (maxTotalBytes === 0) {
      return;
    }
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort(
      (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
    )) {
      if (totalBytes <= maxTotalBytes) {
        break;
      }
      if (activeFile && path.resolve(file.path) === path.resolve(activeFile)) {
        continue;
      }
      fs.rmSync(file.path, { force: true });
      totalBytes -= file.size;
    }
  } catch {
    // Logging maintenance must never affect request handling.
  }
}

export function redactHeaders(headers: Headers | Record<string, string | undefined>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.flatMap(([key, value]) => (value === undefined ? [] : [[key, isSensitiveKey(key) ? '<redacted>' : value]])),
  );
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(bearer|basic|Cloud-IDE-JWT)\s+[^\s,;]+/gi, '$1 <redacted>')
    .replace(
      /\b(authorization|cookie|set-cookie|token|access_?token|refresh_?token|user_?jwt|ms_?token|a[_-]?bogus|ttwid|tt_scid|sessionid|sid_guard|lark_suite_access_token|lark_suite_dpop|api[_-]?key|jwt|secret|password|private[_-]?key|device[_-]?private[_-]?key|auth[_-]?code(?:info)?|code[_-]?verifier|device[_-]?proof|signature)\s*([=:])\s*[^\s,;]+/gi,
      '$1$2<redacted>',
    )
    .replace(/-----BEGIN (?:EC )?PRIVATE KEY-----[\s\S]*?-----END (?:EC )?PRIVATE KEY-----/gi, '<redacted-private-key>')
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, '$1?<redacted-query>')
    .replace(
      /([?&](?:state|login_trace_id|loginTraceID|authCode|auth_code|authCodeInfo|userJwt|accessToken|refreshToken|code)=)[^&#\s]*/gi,
      '$1<redacted>',
    );
}

function redactField(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) {
    return '<redacted>';
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactField(key, item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, redactField(name, item)]),
    );
  }
  return value;
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redactField(key, value)]));
}

export function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message: redactSensitiveText(message),
    ...redactFields(fields),
  });
  try {
    const target = logFile();
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(target, 'a', 0o600);
    try {
      fs.writeSync(descriptor, `${entry}\n`);
    } finally {
      fs.closeSync(descriptor);
    }
    const now = Date.now();
    if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      lastPrunedAt = now;
      pruneLogFiles(new Date(now), target);
    }
  } catch {
    // Logging must never affect request handling.
  }
}
