import { createRequire } from 'node:module';
import { Controller, Get } from '@nestjs/common';
import { FileLoggerService } from './file-logger.service.js';

/**
 * 诊断接口的响应体。
 *
 * 只有三样东西：日志尾行、版本、运行时长。设备指纹、内容密钥、上游地址一律
 * 不出现——`server` 里的每一行在写盘时就已经过完 `redact`（URL 的 userinfo /
 * query / fragment 全部剥掉），所以这里不需要再脱敏一次，也不该把原始材料
 * 从别处读回来。
 */
export interface DiagnosticsReport {
  /** 服务端日志最后 200 行，每行已脱敏。文件日志没开时为空数组。 */
  server: string[];
  /** 服务端包版本，取自 `server/package.json`，与 `/api/health` 同源。 */
  version: string;
  uptimeSeconds: number;
}

/** 回给浏览器的日志行数。与前端环形缓冲的 200 条对齐。 */
const RECENT_LINES = 200;

/**
 * 读 `server/package.json` 的 `version`。
 *
 * 与 `health.controller.ts` 完全一致的读法：`createRequire` 的路径相对本文件，
 * `src/common` 与 `dist/common` 都在包内同一层级，`tsc` 与 `node dist` 两种
 * 运行方式都能解析到同一个 `package.json`。
 */
const packageJson = createRequire(import.meta.url)('../../package.json') as { version?: unknown };

const API_VERSION = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';

/**
 * 诊断信息。
 *
 * 日志文件由 `LOG_TO_FILE` 控制是否写入，但**读取不受它影响**：没开文件日志时
 * 文件不存在，`readRecentLines` 返回空数组，接口仍然是 200。这样「先出问题再
 * 打开日志开关」的排障流程不需要额外区分两种响应形状。
 */
@Controller('api')
export class DiagnosticsController {
  constructor(private readonly logs: FileLoggerService) {}

  @Get('diagnostics')
  async diagnostics(): Promise<DiagnosticsReport> {
    return {
      server: await this.logs.readRecentLines(RECENT_LINES),
      version: API_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
