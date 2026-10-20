const SECRET_KEYS = /(?:secret|token|password|cookie|authorization|api[_-]?key|jwt)/i;
const SECRET_KEY_WORD = '(?:secret|token|password|cookie|authorization|api[_-]?key|jwt)';
const SECRET_KEY_TEXT = `(?:${SECRET_KEY_WORD}|[A-Za-z_][A-Za-z0-9_]*${SECRET_KEY_WORD}[A-Za-z0-9_]*)`;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEYS.test(key) ? '[REDACTED]' : redact(item),
    ]),
  );
}

export const log = {
  info(scope: string, event: string, fields?: Record<string, unknown>): void {
    emit('info', scope, event, fields);
  },
  warn(scope: string, event: string, fields?: Record<string, unknown>): void {
    emit('warn', scope, event, fields);
  },
  error(scope: string, event: string, fields?: Record<string, unknown>): void {
    emit('error', scope, event, fields);
  },
};

/**
 * The upstream SDK's default logger can print complete Axios request objects,
 * including Authorization headers. Keep its diagnostics useful without ever
 * traversing request/config/response objects or serializing unknown fields.
 */
export const larkSdkLogger = {
  error: (...messages: unknown[]): void => emitSdk('error', messages),
  warn: (...messages: unknown[]): void => emitSdk('warn', messages),
  info: (...messages: unknown[]): void => emitSdk('info', messages),
  debug: (...messages: unknown[]): void => emitSdk('debug', messages),
  trace: (...messages: unknown[]): void => emitSdk('trace', messages),
};

function emitSdk(level: 'error' | 'warn' | 'info' | 'debug' | 'trace', messages: unknown[]): void {
  emit(level, 'lark-sdk', 'message', { details: summarizeSdkMessages(messages) });
}

function summarizeSdkMessages(messages: unknown[]): unknown[] {
  return messages.slice(0, 8).map((message) => summarizeSdkValue(message, 0));
}

function summarizeSdkValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return redactText(value).slice(0, 2_000);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name.slice(0, 120),
      message: redactText(value.message).slice(0, 2_000),
      ...safeScalarField(value, 'code'),
      ...safeScalarField(value, 'status'),
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 3) {
      return '[nested-array]';
    }
    return value.slice(0, 8).map((item) => summarizeSdkValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const summary = {
      ...safeScalarField(value, 'name'),
      ...safeScalarField(value, 'code'),
      ...safeScalarField(value, 'status'),
      ...safeScalarField(value, 'statusText'),
      ...safeScalarField(value, 'msg'),
      ...safeScalarField(value, 'message'),
    };
    return Object.keys(summary).length > 0 ? summary : '[object omitted]';
  }
  return `[${typeof value}]`;
}

function safeScalarField(value: object, key: string): Record<string, string | number | boolean> {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  const item = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (typeof item === 'string') {
    return { [key]: redactText(item).slice(0, 2_000) };
  }
  if (typeof item === 'number' || typeof item === 'boolean') {
    return { [key]: item };
  }
  return {};
}

function emit(level: string, scope: string, event: string, fields?: Record<string, unknown>): void {
  const body = fields ? ` ${safeJson(redact(fields))}` : '';
  console.error(`[lark-pi-bridge] ${new Date().toISOString()} ${level} ${scope}.${event}${body}`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
/** Replace only caller-known local paths before applying general log redaction. */
export function redactKnownPaths(value: string, paths: readonly (string | undefined)[]): string {
  const known = [...new Set(paths.filter((path): path is string => Boolean(path)))].sort((a, b) => b.length - a.length);
  return known.reduce((text, path) => text.split(path).join('[LOCAL_PATH]'), value);
}

/** Sanitize arbitrary text before it can be rendered to a user or emitted in a log. */
export function redactText(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(
      /([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|COOKIE|JWT|API_KEY)[A-Za-z0-9_]*=)[^\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(new RegExp(`((?:["'])?${SECRET_KEY_TEXT}(?:["'])?\\s*[:=]\\s*)"[^"]*"`, 'gi'), '$1"[REDACTED]"')
    .replace(new RegExp(`((?:["'])?${SECRET_KEY_TEXT}(?:["'])?\\s*[:=]\\s*)'[^']*'`, 'gi'), "$1'[REDACTED]'")
    .replace(new RegExp(`(${SECRET_KEY_TEXT}\\s*=\\s*)[^\\s,}\\]]+`, 'gi'), '$1[REDACTED]');
}

function redactString(value: string): string {
  return redactText(value);
}
