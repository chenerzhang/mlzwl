import { Context, Next } from 'hono';
import { env } from '../config/env.js';

function configuredClientToken(): string {
  return env('X_ADAPTER_CLIENT_TOKEN');
}

function isProtectedPath(pathname: string): boolean {
  return pathname === '/responses' || pathname.startsWith('/v1/');
}

function bearerToken(value: string | undefined): string {
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length).trim() : '';
}

export async function clientAuthMiddleware(c: Context, next: Next) {
  const expected = configuredClientToken();
  const pathname = new URL(c.req.url).pathname;
  if (!expected || !isProtectedPath(pathname) || bearerToken(c.req.header('authorization')) === expected) {
    return next();
  }
  return c.json(
    {
      error: {
        message: 'Missing or invalid x-adapter client token.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    },
    401,
  );
}
