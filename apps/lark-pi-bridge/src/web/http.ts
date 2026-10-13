import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';

export const MAX_WEB_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export class WebHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertLoopbackRequest(request: IncomingMessage): void {
  const remote = normalizeAddress(request.socket.remoteAddress);
  if (!remote || !LOOPBACK_HOSTS.has(remote)) {
    throw new WebHttpError(403, 'forbidden');
  }
  const host = parseHost(request.headers.host);
  if (!host || !LOOPBACK_HOSTS.has(host.hostname)) {
    throw new WebHttpError(403, 'invalid host');
  }
}

export function assertBrowserApiRequest(request: IncomingMessage): void {
  assertLoopbackRequest(request);
  const host = request.headers.host;
  if (!host) {
    throw new WebHttpError(403, 'same-origin request required');
  }
  const source = request.headers.origin ?? request.headers.referer;
  if (!source) {
    throw new WebHttpError(403, 'origin or referer required');
  }
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new WebHttpError(403, 'invalid origin');
  }
  if (parsed.protocol !== 'http:' || parsed.host !== host || parsed.username || parsed.password) {
    throw new WebHttpError(403, 'cross-origin request rejected');
  }
  if (request.headers['sec-fetch-site'] !== 'same-origin') {
    throw new WebHttpError(403, 'sec-fetch-site must be same-origin');
  }
}

export function requireJsonContentType(request: IncomingMessage): void {
  const value = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (value !== 'application/json') {
    throw new WebHttpError(415, 'application/json required');
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > MAX_WEB_BODY_BYTES) {
      throw new WebHttpError(413, 'body too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new WebHttpError(400, 'body must be valid UTF-8');
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WebHttpError(400, 'JSON object required');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WebHttpError) {
      throw error;
    }
    throw new WebHttpError(400, 'invalid JSON body');
  }
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  for (const item of (request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== name) {
      continue;
    }
    return item.slice(separator + 1).trim();
  }
  return undefined;
}

export function equalToken(left: string | undefined, right: string): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, 'application/json; charset=utf-8', `${JSON.stringify(value)}\n`);
}

export function sendHtml(response: ServerResponse, html: string, nonce: string, cookie?: string): void {
  send(response, 200, 'text/html; charset=utf-8', html, {
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    ...(cookie ? { 'Set-Cookie': cookie } : {}),
  });
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...extra,
  });
  response.end(body);
}

function parseHost(value: string | undefined): { hostname: string; port?: string } | undefined {
  if (!value || value.includes(',') || /[\r\n]/.test(value)) {
    return undefined;
  }
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return undefined;
    }
    return { hostname: normalizeAddress(parsed.hostname), ...(parsed.port ? { port: parsed.port } : {}) };
  } catch {
    return undefined;
  }
}

function normalizeAddress(value: string | undefined): string {
  if (!value) {
    return '';
  }
  if (value.startsWith('::ffff:')) {
    return value.slice('::ffff:'.length);
  }
  return value.replace(/^\[|\]$/g, '');
}
