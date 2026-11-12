import 'reflect-metadata';
import { networkInterfaces } from 'node:os';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { FileLoggerService } from './common/file-logger.service.js';
import { describeListenTargets } from './common/listen-address.js';
import { CONFIG, type Config } from './config/config.js';
import { MAX_COVER_TOKEN_LENGTH } from './cover/cover-token.js';
import { registerSpaFallback, registerStaticAssets } from './serve-web-dist.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');
  // `exposeHeadRoutes: false`：Fastify 默认给每个 GET 自动挂一个 HEAD，而 HEAD
  // 会执行 GET 的 handler（触发整片下载 + 解密）。我们显式实现了轻量 HEAD，
  // 所以必须关掉自动挂载，否则路由重复注册直接启动失败。
  //
  // `maxParamLength`：Fastify 默认 100，而封面令牌是上游 URL 的 AES-GCM 密文，
  // base64url 后轻松超过 300 字符。不抬高就会直接 414 `FST_ERR_MAX_PARAM_LENGTH`，
  // 合法封面全部拉不到。
  //
  // 上限必须与 `MAX_COVER_TOKEN_LENGTH`（见 `cover-token.ts`）**同源**：前端允许
  // 保存多长的令牌，服务端就必须能收多长，否则会出现「接口给了地址、浏览器却打不开」。
  // 这里引用常量而不是写字面量，避免两处各改一半。
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 1_048_576,
    exposeHeadRoutes: false,
    maxParamLength: MAX_COVER_TOKEN_LENGTH,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });

  const config = app.get<Config>(CONFIG);

  /*
   * 文件日志（默认关闭）。
   *
   * 用 `app.useLogger` 而不是往 `NestFactory.create` 传 `logger`：那样必须在
   * 容器建好之前拿到配置，只能再调一次 `loadConfig()`，配置非法时的报错时机
   * 就从「容器初始化中」提前到「create 之前」，输出也变了。这里复用容器里的
   * CONFIG，`LOG_TO_FILE=false` 时**不调用** `useLogger`，Nest 仍用默认
   * ConsoleLogger，与加这个开关之前逐字一致。
   *
   * `bufferLogs: true` 让 create 期间的日志先入缓冲；`useLogger` 不立刻冲刷，
   * 缓冲在 `listen()` 的 `flushLogsIfAutoFlushEnabled()` 里统一走新 logger，
   * 所以启动日志也会落盘。
   */
  if (config.LOG_TO_FILE) {
    app.useLogger(app.get(FileLoggerService));
  }

  app.enableCors({
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'HEAD', 'OPTIONS'],
    credentials: false,
    maxAge: 86_400,
  });
  app.enableShutdownHooks();

  /*
   * 生产期由后端托管前端，整个应用只暴露一个端口。
   *
   * 两个都必须在 listen 之前注册：Fastify 一旦进入 started 状态，
   * `useStaticAssets`（内部 addHook）和 SPA fallback（也是 addHook）都会抛
   * `FST_ERR_INSTANCE_ALREADY_LISTENING`。
   */
  const servesWeb = await registerStaticAssets(app);
  if (servesWeb) {
    registerSpaFallback(app);
  }

  await app.listen(config.PORT, config.HOST);
  const targets = describeListenTargets(config.HOST, config.PORT, networkInterfaces());
  logger.log(`可用访问地址：\n${targets.urls.map((url) => `  ${url}`).join('\n')}`);
  if (targets.openToLan) {
    logger.warn(
      '当前服务监听非回环地址，可被其他设备访问；若该网卡可从公网到达，服务也会暴露到公网。' +
        '/api/* 没有鉴权，server/data/ 含设备指纹。请仅在可信网络使用，并用主机防火墙限制访问。',
    );
  }
}

void bootstrap();
