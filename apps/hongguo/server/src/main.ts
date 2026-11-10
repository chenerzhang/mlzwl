import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { CONFIG, type Config } from './config/config.js';
import { registerSpaFallback, registerStaticAssets } from './serve-web-dist.js';

async function bootstrap(): Promise<void> {
  const logger = new Logger('bootstrap');
  // `exposeHeadRoutes: false`：Fastify 默认给每个 GET 自动挂一个 HEAD，而 HEAD
  // 会执行 GET 的 handler（触发整片下载 + 解密）。我们显式实现了轻量 HEAD，
  // 所以必须关掉自动挂载，否则路由重复注册直接启动失败。
  const adapter = new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576, exposeHeadRoutes: false });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });

  const config = app.get<Config>(CONFIG);

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
  logger.log(`listening on http://${config.HOST}:${config.PORT}`);
}

void bootstrap();
