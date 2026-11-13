# @mlzwl/hongguo

红果短剧的 Web 客户端。一个自托管的浏览器播放器，直接对接红果（`com.phoenix.read`）的公开接口，提供发现、搜索、选集、播放、追更五条主链路。

本包由独立的 `hongguo` 仓库迁入，源码、文档与验证记录完整保留在 `docs/`。

## 目录

```text
apps/hongguo/
├── shared/     同构层：签名算法（spade）、CENC 解密规划、MP4 解析、Zod schema
├── server/     NestJS + Fastify：上游代理、设备注册、CENC 原地解密、封面/雪碧图缓存、
│              生产期托管 web/dist（单端口部署）
├── web/        Vite + React 19 + Tailwind 4：7 条路由（发现、搜索、详情、播放、历史、收藏、榜单）
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

## 收藏与追更

剧集详情页有两个独立按钮：**收藏**（`heart` 图标）与**追更**（`bell` 图标）。
一个按钮只干一件事，取消时各点一次即可，不需要绕一圈中间状态。

- **收藏**回答「我记住了这部剧」。「我的收藏」页只列收藏过的剧。
- **追更**回答「它更新时告诉我」。只有追更中的剧才显示「更新 N 集」角标。

两者可以同时开、可以只开一个。都关掉时整条记录自动删除。
记录只存在浏览器 `localStorage`（`dsh-hongguo.follow.v1`），不上传服务端。

> 从旧版本升级时，**旧的「想看/在看/看完」记录会被清空**。那套三态与新的
> 两个开关不是一一对应（「在看」到底算不算追更没有客观答案），强行映射只会
> 产出用户没表达过的状态。重新收藏一次即可。

角标计数用**高水位**语义：`knownEpisodes`（上游报告过的最大集数）减去 `confirmedEpisodes`
（你实际看到过的集数），下限 0。上游偶发返回更少的集数时角标不会变成负数或重复提示。

追更的语义是「**从现在开始**它更新了告诉我」，所以刚点追更时会把基线推到当前集数。
一部已经出完 78 集的剧，刚追更时不会立刻报「更新 78 集」。收藏不产生角标，
因此收藏不会推高基线：以后把这部剧改成追更时，错过的集数仍会报出来。

看完一集会记进观看历史。回到详情页时，已看完的那集默认高亮**下一集**，
「继续看」按钮也直接指向下一集；没看完则回到原来的位置。

进度达到 95% 或触发 `ended` 就算看完。这条标记存在观看历史里（`completed`），
刷新页面后仍然生效。

## 离线目录

首页第一页会自动存一份快照到 `localStorage`（`dsh-hongguo.catalog.v1`）。
断网时刷新首页，仍能显示上次看到的剧集，顶部提示「当前显示的是离线缓存」。

快照的限制：最多 30 条、序列化后不超过 200 KB、7 天后过期、`description`
截断到 1500 字符。读取时逐字段校验，任何一条不合法就**整体丢弃**，不做部分信任。

快照**不包含**播放地址与签名参数，只留 id、标题、封面代理地址、简介与集数。
封面地址走服务端的 `/api/cover/<token>` 白名单代理，不是上游 CDN 直链。令牌是上游地址的
AES-GCM 密文，浏览器解不开，所以上游签名不会进入 DOM、网络面板或 localStorage。

## 清晰度

播放页底栏有清晰度按钮，显示当前档位（例如「清晰度 720p」）。**只有上游给出多档时
才显示**：单档时按钮不出现，因为点开一个只有一项的菜单没有意义。

切档会重新请求 `/api/episodes/:id/playback?definition=<档位>`，并从**切换时的位置**
接着播，不回 0。片尾（已播到末尾）切档则从头开始。

选择记在 `localStorage`（`dsh-hongguo.watch-history.v1.volume` 的 `definition` 字段），
下次打开任意剧集沿用。换集时回退到「服务端默认档 + 你的偏好取交集」，不会把上一集
的档位硬套到新一集。

上游偶尔给不出档位标签，服务端会填 `unknown`。`unknown` 只作为状态显示，**不能选**：
服务端只接受 `\d{3,4}p`，选它会必然 400。

指定的档位在这一集不存在时，服务端返回 400 `definition_unavailable`，**不会静默
降级成别的档**。可用档位是逐集算的，「别的集有 1080p」不代表这一集有。

## 下载

详情页的「下载」按钮打开下载面板，按集下载或勾选多集批量下载（并发 2）。

面板顶部可以选下载清晰度，**默认最高档**（例如 1080p），可以改成任意可用档。
选择存在 `localStorage` 的 `downloadDefinition` 字段，与播放档位 `definition`
**分开保存**：常见需求是「在线看低档省流量、下载留最高档」。

下载走 `/api/media/:id?definition=<档位>`，文件名带档位后缀（`123-720p.mp4`），
同一集的不同档不会互相覆盖。这一集没有所选档位时提示「这一集没有所选清晰度，
换一档再试」，不会把别的档写进 `-1080p.mp4` 这样的文件名。

## 接口

开发期经 Vite 代理（`:5173/api/*`），生产期由后端直接提供（`:9133/api/*`）。
两者路径一致，前端代码用相对路径，不需要配置 base URL。

| 方法 | 路径                            | 说明                                                   |
| ---- | ------------------------------- | ------------------------------------------------------ |
| GET  | `/api/feed`                     | 发现页分页                                             |
| GET  | `/api/search?keyword=`          | 搜索（上游 cursor 有问题，前端跨页去重）               |
| GET  | `/api/suggest?prefix=`          | 搜索联想；上游失败降级为空列表                         |
| GET  | `/api/random`                   | 随机一部剧；候选池缓存 60 秒，空池返回 404             |
| GET  | `/api/series/:id`               | 剧集详情                                               |
| GET  | `/api/series/:id/episodes`      | 分集列表                                               |
| GET  | `/api/episodes/:id/playback`    | 播放参数与自有媒体地址（不含上游签名 URL 或内容密钥）  |
| GET  | `/api/media/:episodeId`         | 解密后的 MP4，支持 Range / HEAD                        |
| GET  | `/api/cover/:token`             | 封面代理（HEIC → JPEG），令牌不透明                    |
| GET  | `/api/sprite/:episodeId`        | 雪碧图网格元数据与切片地址                             |
| GET  | `/api/sprite/:episodeId/:sheet` | 指定雪碧图切片                                         |
| GET  | `/api/health`                   | 健康检查（上游三态、版本、运行时长）                   |
| GET  | `/api/diagnostics`              | 诊断：服务端日志最后 200 行（已脱敏）+ 版本 + 运行时长 |

### 诊断日志

服务端默认只写 stdout。需要排障时把 `LOG_TO_FILE` 设成非空值再重启，日志会额外落到
`server/data/logs/app.jsonl`（每行一条 JSON，写入前过 `redact()`，单文件 5 MB 轮转，
只保留 `app.jsonl` 与 `app.1.jsonl`）。`GET /api/diagnostics` 返回的就是这个文件的尾部。

也可以不碰命令行：打开「观看历史」页，点顶栏的**导出诊断**。它把前端事件环形缓冲
（最近 200 条）、浏览器环境信息、`/api/health` 与 `/api/diagnostics` 的返回一起打包成
JSON 写进剪贴板。服务端接口取不到时仍会导出其余部分，并把失败原因记在 `failure` 字段。

注意 `LOG_TO_FILE` 走的是 zod 的 `z.coerce.boolean()`，**任何非空字符串都算开启**，
包括 `LOG_TO_FILE=false`。要关闭就别设它（或设为空值）。

## 安全提示

- 服务默认监听 `0.0.0.0`（所有 IPv4 网卡），方便同一局域网的手机访问；启动日志会打印可用的局域网地址与风险提示。
- `0.0.0.0` **不代表**访问范围被限制在局域网。主机若有公网地址、VPN、容器网桥或端口转发，服务同样可被那些网络访问。实际隔离依赖主机防火墙与路由器。
- `/api/*` 没有鉴权，`server/data/` 又含已注册设备的指纹（`devices.profile`）。只应在可信网络使用，严禁暴露到公网；需要仅限本机时设置 `HOST=127.0.0.1`。
- `server/data/` 已被 `.gitignore` 排除，不要提交、不要外传。
- 本包使用红果的未公开接口，可能受服务条款、风控、额度或接口变更影响。仅使用你有权访问的内容。

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
