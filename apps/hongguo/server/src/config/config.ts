import { z } from 'zod';

/**
 * 服务端配置。所有环境变量在这里集中校验，读不到或类型不对就直接启动失败，
 * 不要让错误在运行时才暴露。
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(9133),
  /*
   * 默认绑定所有 IPv4 网卡，方便同一局域网内的手机访问。
   *
   * `0.0.0.0` 只表示「监听所有网卡」，**不代表**访问范围被限制在局域网：
   * 主机若有公网地址、VPN、容器网桥或端口转发，服务同样可被那些网络访问。
   * 配合 `/api/*` 无鉴权，实际隔离依赖主机防火墙与路由器。
   * 只想本机使用时设 `HOST=127.0.0.1`。
   */
  HOST: z.string().trim().min(1).default('0.0.0.0'),

  /** 数据目录：SQLite、媒体缓存、封面缓存、雪碧图缓存都放这里。 */
  DATA_DIR: z.string().default('./data'),

  /** 解密后视频的 LRU 保留数量，沿用上游 MEDIA_KEEP。 */
  MEDIA_KEEP: z.coerce.number().int().min(1).default(40),

  /** 封面缓存保留天数。 */
  COVER_KEEP_DAYS: z.coerce.number().int().min(1).default(30),

  /** 上游 SDK 的请求超时（毫秒）。媒体下载的单次请求也复用它。 */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),

  /**
   * 单个媒体文件的下载硬上限（字节，默认 200 MB）。
   *
   * 上游声明的 `size` 不准，所以这是**读流时的硬上限**：累计字节一旦超过它
   * 就中止下载。`content-length` 只用于提前放弃，不能只依赖它。
   */
  MEDIA_MAX_BYTES: z.coerce.number().int().min(1_048_576).default(209_715_200),

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

  /**
   * 是否把日志额外落盘到 `DATA_DIR/logs/app.jsonl`（5 MB × 2 轮转）。默认关闭。
   *
   * 注意 `z.coerce.boolean()` 走的是 `Boolean(value)`：**任何非空字符串都是 true**，
   * 包括 `LOG_TO_FILE=false`。关闭只能靠不设置或设为空值。不要改成字符串枚举——
   * 现有配置项都是 `coerce` 风格，这里保持一致，并在文档里写清楚。
   */
  LOG_TO_FILE: z.coerce.boolean().default(false),
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
