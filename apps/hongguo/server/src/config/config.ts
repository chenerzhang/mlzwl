import { z } from 'zod';

/**
 * 服务端配置。所有环境变量在这里集中校验，读不到或类型不对就直接启动失败，
 * 不要让错误在运行时才暴露。
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(9133),
  HOST: z.string().default('127.0.0.1'),

  /** 数据目录：SQLite、媒体缓存、封面缓存、雪碧图缓存都放这里。 */
  DATA_DIR: z.string().default('./data'),

  /** 解密后视频的 LRU 保留数量，沿用上游 MEDIA_KEEP。 */
  MEDIA_KEEP: z.coerce.number().int().min(1).default(40),

  /** 封面缓存保留天数。 */
  COVER_KEEP_DAYS: z.coerce.number().int().min(1).default(30),

  /** 上游 SDK 的请求超时（毫秒）。 */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),

  /** 允许跨域的前端来源，逗号分隔。开发期默认允许本地 Vite。 */
  CORS_ORIGINS: z
    .string()
    .default('http://127.0.0.1:5173,http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
});

export type Config = z.output<typeof ConfigSchema>;

export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment configuration:\n${detail}`);
  }
  return parsed.data;
}
