import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** 解析前端构建产物目录。 */
export function resolveWebDist(): { webDist: string; indexFile: string } {
  // dist/main.js → server/dist → server → hongguo → web/dist
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, '../../web/dist');
  return { webDist, indexFile: resolve(webDist, 'index.html') };
}

/**
 * 生产期由后端托管前端构建产物，让整个应用只暴露一个端口。
 *
 * ## 为什么需要这个
 *
 * 开发期有两个进程：Vite（5173）负责热更新，后端（9133）负责接口，Vite 把
 * `/api` 代理过去。但**生产构建后没有任何进程提供 `web/dist`**——只跑后端时
 * 打开 9133 是 404。这会让「两个端口」变成部署负担：得额外起一个静态服务器，
 * 再给它配反向代理转发 `/api`。
 *
 * ## 为什么 SPA fallback 必须在 listen 之后注册
 *
 * Nest 在 `init()` 里会调用 `registerRouterHooks` → `setNotFoundHandler` 装上
 * 自己的 404 处理器。如果提前注册，Fastify 会抛
 * `Not found handler already set for Fastify instance with prefix: '/'`，
 * 直接启动失败。所以这里分成两步：`registerStaticAssets` 在 listen 前调用，
 * `registerSpaFallback` 在 listen 后调用，后者覆盖 Nest 的 404 处理器。
 *
 * ## 为什么 fallback 条件要写得窄
 *
 * 前端是单页应用，直接访问 `/series/123` 时后端没有这个文件，必须回落到
 * `index.html` 交给前端路由，否则刷新任意子路由都会 404。
 *
 * 但回落不能无差别：把 `/api` 前缀和带扩展名的路径排除掉，接口 404 依然是
 * JSON 404，缺失的静态资源依然是 404。否则浏览器会拿到状态 200 的 HTML，
 * 把 JS 当 HTML 解析并报 `Unexpected token '<'`。
 *
 * @returns 是否真的挂载了。构建产物不存在时返回 false（开发期正常情况）。
 */
export async function registerStaticAssets(app: NestFastifyApplication): Promise<boolean> {
  const logger = new Logger('static');
  const { webDist, indexFile } = resolveWebDist();

  if (!existsSync(indexFile)) {
    logger.log(`web/dist 不存在（${webDist}），跳过静态托管。开发期由 Vite 提供前端。`);
    return false;
  }

  /*
   * `wildcard: false` + `index: false`：
   * - 不注册 `/*` 通配路由，避免和 /api 路由抢匹配；
   * - 不自动返回 index.html，交给下面的 fallback 精确控制。
   */
  app.useStaticAssets({ root: webDist, wildcard: false, index: false });

  logger.log(`托管前端构建产物：${webDist}`);
  return true;
}

/**
 * 为前端路由回落 index.html。
 *
 * ## 为什么用 `onRequest` 钩子而不是 `setNotFoundHandler`
 *
 * `setNotFoundHandler` 有两个限制，两个都踩过：
 * 1. **listen 之前调**：Nest 在 `init()` 里已装过自己的 404 处理器，Fastify
 *    抛 `Not found handler already set for Fastify instance with prefix: '/'`。
 * 2. **listen 之后调**：Fastify 已进入 started 状态，抛
 *    `FST_ERR_INSTANCE_ALREADY_LISTENING`。
 *
 * 所以两个时机都不行。改用 `onRequest` 钩子：它在路由匹配之前执行，
 * 可以在任意时机注册，且能拿到原始 URL。
 *
 * ## 判断逻辑
 *
 * 只有当「GET/HEAD + 不是 /api + 没有文件扩展名 + 磁盘上确实没有这个文件」
 * 时才回落。否则：
 * - 接口 404 依然是 JSON 404；
 * - 缺失的静态资源依然是 404，不会变成状态 200 的 HTML
 *   （那会让浏览器把 JS 当 HTML 解析并报 `Unexpected token '<'`）。
 */
export function registerSpaFallback(app: NestFastifyApplication): void {
  const { webDist, indexFile } = resolveWebDist();
  if (!existsSync(indexFile)) {
    return;
  }

  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      const url = request.url.split('?')[0] ?? '';
      const isRead = request.method === 'GET' || request.method === 'HEAD';
      const isApi = url.startsWith('/api/');
      const hasExtension = /\.[a-zA-Z0-9]+$/.test(url);
      /*
       * 注意 `existsSync(join(webDist, '/'))` 为 true —— 它指向 dist 目录本身，
       * 不是文件。若只判存在性，根路径 `/` 会被误判为「磁盘上有」而跳过回落，
       * 结果首页 404。所以要额外排除以 `/` 结尾（含根路径）的 URL。
       */
      const isDirectoryPath = url === '/' || url.endsWith('/');
      const onDisk = !isDirectoryPath && existsSync(join(webDist, url));

      if (!isRead || isApi || hasExtension || onDisk) {
        done();
        return;
      }

      // 前端路由：返回 index.html，由 react-router 在浏览器侧接管。
      void reply.type('text/html; charset=utf-8').send(createReadStream(indexFile));
    });
}
