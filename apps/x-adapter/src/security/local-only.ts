import { Context, Next } from 'hono';
import { host as configuredHost, intEnv, port as configuredPort } from '../config/env.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function normalizeHostname(hostname: string): string {
  const value = hostname.trim().toLowerCase();
  return value === '[::1]' ? '::1' : value;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHostname(hostname));
}

export function assertLoopbackBindHost(value = configuredHost()): string {
  const normalized = normalizeHostname(value);
  if (!isLoopbackHost(normalized)) {
    throw new Error(`x-adapter only supports localhost binding. Refusing to bind to "${value}".`);
  }
  return normalized;
}

type ParsedAuthority = { hostname: string; port: number };

function parseHostHeader(value: string | null | undefined): ParsedAuthority | undefined {
  if (!value || value.includes(',')) {
    return undefined;
  }
  try {
    const url = new URL(`http://${value}`);
    const port = url.port ? Number(url.port) : undefined;
    if (!Number.isInteger(port)) {
      return undefined;
    }
    return { hostname: normalizeHostname(url.hostname), port: port as number };
  } catch {
    return undefined;
  }
}

function parseOrigin(value: string | null | undefined): ParsedAuthority | undefined {
  if (!value || value === 'null') {
    return undefined;
  }
  try {
    const url = new URL(value);
    const port = url.port
      ? Number(url.port)
      : url.protocol === 'http:'
        ? 80
        : url.protocol === 'https:'
          ? 443
          : undefined;
    if (!Number.isInteger(port)) {
      return undefined;
    }
    return { hostname: normalizeHostname(url.hostname), port: port as number };
  } catch {
    return undefined;
  }
}

function isJsonContentType(contentType: string | null | undefined): boolean {
  const type = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return !!type && (type === 'application/json' || /^application\/[^\s;]+\+json$/.test(type));
}

function protectedJsonPost(pathname: string, method: string): boolean {
  return (
    method === 'POST' &&
    (pathname === '/v1/chat/completions' ||
      pathname === '/v1/messages' ||
      pathname === '/v1/responses' ||
      pathname === '/responses')
  );
}

function errorJson(message: string, code: string, param?: string) {
  return { error: { message, type: 'invalid_request_error', code, param } };
}

function maxBodyBytes(): number {
  return intEnv('X_ADAPTER_MAX_BODY_BYTES', 33_554_432);
}

export async function localOnlyMiddleware(c: Context, next: Next) {
  const bindPort = configuredPort();
  const hostHeader = c.req.header('host');
  if (hostHeader) {
    const parsed = parseHostHeader(hostHeader);
    if (!parsed) {
      return c.json(errorJson('Invalid Host header.', 'invalid_host_header', 'host'), 400);
    }
    if (parsed.port !== bindPort || !isLoopbackHost(parsed.hostname)) {
      return c.json(errorJson('Host must be localhost.', 'forbidden_host', 'host'), 403);
    }
  }

  const originHeader = c.req.header('origin');
  if (originHeader) {
    const parsed = parseOrigin(originHeader);
    if (!parsed || parsed.port !== bindPort || !isLoopbackHost(parsed.hostname)) {
      return c.json(errorJson('Origin must be localhost.', 'forbidden_origin', 'origin'), 403);
    }
  }

  if (c.req.header('sec-fetch-site')?.trim().toLowerCase() === 'cross-site') {
    return c.json(
      errorJson('Cross-site requests are not allowed.', 'cross_site_request_forbidden', 'sec-fetch-site'),
      403,
    );
  }

  if (protectedJsonPost(new URL(c.req.url).pathname, c.req.method)) {
    if (!isJsonContentType(c.req.header('content-type'))) {
      return c.json(
        errorJson('Content-Type must be application/json.', 'unsupported_content_type', 'content-type'),
        415,
      );
    }
    const limit = maxBodyBytes();
    const contentLength = Number(c.req.header('content-length'));
    if (limit > 0 && Number.isFinite(contentLength) && contentLength > limit) {
      return c.json(errorJson(`Request body exceeds the ${limit} byte limit.`, 'request_body_too_large', 'body'), 413);
    }
    if (limit > 0 && !c.req.header('content-length') && c.req.raw.body) {
      const size = (await c.req.raw.clone().arrayBuffer()).byteLength;
      if (size > limit) {
        return c.json(
          errorJson(`Request body exceeds the ${limit} byte limit.`, 'request_body_too_large', 'body'),
          413,
        );
      }
    }
  }

  return next();
}
