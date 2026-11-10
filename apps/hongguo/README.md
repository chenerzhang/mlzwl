# @mlzwl/hongguo

红果短剧的 Web 客户端。一个自托管的浏览器播放器，直接对接红果（`com.phoenix.read`）的公开接口，提供发现、搜索、选集、播放四条主链路。

本包由独立的 `hongguo` 仓库迁入，源码、文档与验证记录完整保留在 `docs/`。

## 目录

```text
apps/hongguo/
├── shared/     同构层：签名算法（spade）、CENC 解密规划、MP4 解析、Zod schema
├── server/     NestJS + Fastify：上游代理、设备注册、CENC 原地解密、封面/雪碧图缓存、
│              生产期托管 web/dist（单端口部署）
├── web/        Vite + React 19 + Tailwind 4：四条路由 + 播放器
│              静态资源在 src/assets/，由 Vite 打 hash 进 dist/assets/
├── docs/       逆向记录、技术选型、逐轮 UI 改造日志
├── design-system/  设计 token 与页面规格
└── scripts/    ui-audit.mjs，对比度与可访问性审计
```

## 架构

浏览器不接触上游。所有签名、设备身份与内容密钥都在服务端：

```text
浏览器 ──业务 JSON / 媒体流──> server ──签名请求──> 红果上游
```

这样做的原因：上游要求 `x-gorgon` / `x-ladon` / `x-argus` 等签名头与设备指纹绑定。把签名逻辑放进浏览器会同时暴露算法和可被复用的设备身份。

视频是 CENC 加密的。服务端**原地解密**（长度不变），因此 MP4 的偏移表保持有效，可以直接支持 HTTP Range 请求，不需要转码也不需要重新封装。

## 运行

要求 Node.js `>=22`。首次启动会在 `server/data/` 建库并自动注册一个设备。

### 生产：单端口（推荐）

后端会托管前端构建产物，整个应用只暴露一个端口：

```bash
pnpm hongguo:build     # 构建 shared + server + web
pnpm hongguo:start     # 启动后端（:9133），同时提供前端
```

打开 `http://127.0.0.1:9133` 即可，不需要第二个进程。

前端是单页应用，`/series/:id`、`/watch/:id` 这类深链由后端回落到
`index.html`，再交给 react-router 处理。`/api/*` 和缺失的静态资源仍然返回
JSON 404，不会被伪装成 200 的 HTML。

### 开发：两个进程（热更新）

```bash
pnpm hongguo:dev
```

Vite 在 `:5173` 提供前端与热更新，把 `/api` 代理到后端 `:9133`。
打开 `http://127.0.0.1:5173`。

两个进程是**开发期专用**的形态，不是部署形态。原因：Vite 是构建工具，
不承担生产静态服务；生产期由后端托管 `web/dist`，避免额外维护一个
静态服务器加反向代理。

> 只想跑后端接口调试时，直接 `pnpm hongguo:start`，用 curl 打 `:9133/api/*`。

## 接口

开发期经 Vite 代理（`:5173/api/*`），生产期由后端直接提供（`:9133/api/*`）。
两者路径一致，前端代码用相对路径，不需要配置 base URL。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/feed` | 发现页分页 |
| GET | `/api/search?keyword=` | 搜索（上游 cursor 有问题，前端跨页去重） |
| GET | `/api/series/:id` | 剧集详情 |
| GET | `/api/series/:id/episodes` | 分集列表 |
| GET | `/api/episodes/:id/playback` | 播放参数（含雪碧图元数据） |
| GET | `/api/media/:episodeId` | 解密后的 MP4，支持 Range / HEAD |
| GET | `/api/cover?url=` | 封面代理（HEIC → JPEG） |
| GET | `/api/sprite/:episodeId/:sheet` | 雪碧图 |

## 安全提示

- `server/data/` 含已注册设备的指纹（`devices.profile`），已被 `.gitignore` 排除。不要提交、不要外传。
- 本包使用红果的未公开接口，可能受服务条款、风控、额度或接口变更影响。仅使用你有权访问的内容。
- 仅监听 `127.0.0.1`，不要暴露到公网。

## 文档

- [`docs/reverse-engineering.md`](docs/reverse-engineering.md) — 接口、签名算法、CENC 结构的完整逆向记录
- [`docs/tech-stack.md`](docs/tech-stack.md) — 技术选型与取舍
- [`docs/implementation-notes.md`](docs/implementation-notes.md) — 实现细节与踩坑
- [`docs/ui-redesign-log.md`](docs/ui-redesign-log.md) — 七轮 UI 改造记录，含每轮实测数据
- [`docs/ui-polish-log.md`](docs/ui-polish-log.md)、[`docs/polish-log.md`](docs/polish-log.md) — 前两轮交互打磨
- [`AGENTS.md`](AGENTS.md) — 维护约定

## 验证

```bash
pnpm hongguo:typecheck
pnpm hongguo:lint
pnpm hongguo:test
pnpm hongguo:build
```

审计脚本需要前后端都在运行：

```bash
node apps/hongguo/scripts/ui-audit.mjs
```
