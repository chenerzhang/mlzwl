import { createHash } from 'node:crypto';
import { boolEnv, env } from '../config/env.js';
import { doubaoConfigPath, readDoubaoConfig, writeDoubaoConfig } from '../config/file.js';

export const DOUBAO_COMMON_QUERY_KEYS = [
  'aid',
  'device_id',
  'device_platform',
  'doubao_device_platform',
  'doubao_pc_version',
  'fp',
  'language',
  'pc_version',
  'pkg_type',
  'real_aid',
  'region',
  'samantha_web',
  'sys_region',
  'tea_uuid',
  'tz_name',
  'use-olympus-account',
  'version_code',
  'web_id',
  'web_platform',
] as const;

export type DoubaoCredential = {
  cookie: string;
  source: 'env' | 'config_file' | 'mock';
  configPath?: string;
  savedAt?: string;
  userAgent: string;
  commonQuery: Record<string, string>;
  summary: { cookieCount: number; cookieBytes: number; queryKeys: string[] };
};

function normalizeCommonQuery(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    DOUBAO_COMMON_QUERY_KEYS.flatMap((key) =>
      typeof source[key] === 'string' && source[key] ? [[key, source[key] as string]] : [],
    ),
  );
}

function commonQueryFromEnv(): Record<string, string> {
  const raw = env('X_ADAPTER_DOUBAO_COMMON_QUERY');
  if (!raw) {
    return {};
  }
  try {
    return normalizeCommonQuery(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function credentialSummary(cookie: string, commonQuery: Record<string, string>) {
  return {
    cookieCount: cookie
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean).length,
    cookieBytes: Buffer.byteLength(cookie, 'utf8'),
    queryKeys: Object.keys(commonQuery).sort(),
  };
}

export function readDoubaoCredential(): DoubaoCredential | null {
  if (boolEnv('DOUBAO_MOCK', false)) {
    return {
      cookie: '',
      source: 'mock',
      userAgent: 'mock',
      commonQuery: {},
      summary: { cookieCount: 0, cookieBytes: 0, queryKeys: [] },
    };
  }
  const envCookie = env('X_ADAPTER_DOUBAO_COOKIE').trim();
  if (envCookie) {
    const commonQuery = commonQueryFromEnv();
    return {
      cookie: envCookie,
      source: 'env',
      userAgent: env('X_ADAPTER_DOUBAO_USER_AGENT', defaultUserAgent()),
      commonQuery,
      summary: credentialSummary(envCookie, commonQuery),
    };
  }
  const configPath = doubaoConfigPath();
  const config = readDoubaoConfig(configPath);
  const cookie = typeof config?.cookies === 'string' ? config.cookies.trim() : '';
  if (!cookie) {
    return null;
  }
  const commonQuery = normalizeCommonQuery(config?.common_query);
  return {
    cookie,
    source: 'config_file',
    configPath,
    savedAt: config?.saved_at,
    userAgent: config?.user_agent?.trim() || defaultUserAgent(),
    commonQuery,
    summary: credentialSummary(cookie, commonQuery),
  };
}

export function requireDoubaoCredential(): DoubaoCredential {
  const credential = readDoubaoCredential();
  if (credential) {
    return credential;
  }
  const error = new Error(
    `Missing Doubao Work browser credentials. Run \`x-adapter doubao login\` or set X_ADAPTER_DOUBAO_COOKIE and X_ADAPTER_DOUBAO_COMMON_QUERY.`,
  );
  (error as NodeJS.ErrnoException).code = 'missing_doubao_credentials';
  throw error;
}

export function saveDoubaoCredential(
  cookie: string,
  commonQuery: Record<string, string>,
  userAgent: string,
  configPath = doubaoConfigPath(),
): void {
  writeDoubaoConfig(
    {
      cookies: cookie,
      common_query: normalizeCommonQuery(commonQuery),
      user_agent: userAgent,
      saved_at: new Date().toISOString(),
    },
    configPath,
  );
}

export function credentialHash(credential: DoubaoCredential): string {
  return createHash('sha256')
    .update(credential.cookie)
    .update('\0')
    .update(JSON.stringify(credential.commonQuery))
    .digest('hex')
    .slice(0, 16);
}

function defaultUserAgent(): string {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
}
