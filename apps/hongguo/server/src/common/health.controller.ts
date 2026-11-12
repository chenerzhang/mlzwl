import { createRequire } from 'node:module';
import { Controller, Get } from '@nestjs/common';
import { HongguoService, type UpstreamStatus } from '../hongguo/hongguo.service.js';

/**
 * 健康检查的响应体。
 *
 * `ok` 只表示「本服务进程活着」，与上游可用性分开：把两者合成一个布尔值会让
 * 「服务正常但上游挂了」看起来像本服务崩了，而这两种故障的处理方式完全不同。
 */
export interface HealthStatus {
  ok: true;
  /** 上游可用性三态，语义见 `UpstreamStatus`。 */
  upstream: UpstreamStatus;
  /** 服务端包版本，取自 `server/package.json`。 */
  apiVersion: string;
  /** 设备档案是否已存在且非空。**不会**因为查询而触发注册。 */
  deviceRegistered: boolean;
  uptimeSeconds: number;
}

/**
 * 读 `server/package.json` 的 `version`。
 *
 * 用 `createRequire` 而不是 `import ... with { type: 'json' }`：`tsconfig.build.json`
 * 把 `rootDir` 设成 `src`，导入 `src` 之外的 JSON 会让 `tsc` 报错。`createRequire`
 * 的路径相对本文件，`src/common` 与 `dist/common` 都在包内同一层级，两种运行方式
 * 都能解析到同一个 `package.json`。
 */
const packageJson = createRequire(import.meta.url)('../../package.json') as { version?: unknown };

const API_VERSION = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';

/**
 * 健康检查。
 *
 * **不主动探测上游**：探测会消耗匿名配额，还会让健康检查在弱网下变慢。这里只反映
 * 「设备档案在不在」与「最近一次真实调用成没成」，两者都是已有信息。
 *
 * 不做鉴权：只暴露版本、运行时长与三态，不含设备指纹、密钥或地址。
 */
@Controller('api')
export class HealthController {
  constructor(private readonly hongguo: HongguoService) {}

  @Get('health')
  health(): HealthStatus {
    return {
      ok: true,
      upstream: this.hongguo.lastUpstreamStatus(),
      apiVersion: API_VERSION,
      deviceRegistered: this.hongguo.isDeviceRegistered(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
