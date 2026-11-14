# 技术栈与工程结构

本文是 `docs/reverse-engineering.md` 的落地篇。前者回答「上游是什么、能不能做」，本文回答「怎么搭、用什么、边界在哪」。

配套约定见仓库根目录 `AGENTS.md`。

---

## 1. 形态选型：方案 B

已确定采用 **B：服务端 NestJS 持有 SDK 与密钥**。

| 维度         | A：浏览器 WASM + 哑转发        | **B：服务端 NestJS（已选）** |
| ------------ | ------------------------------ | ---------------------------- |
| 签名运行位置 | 浏览器（`openhongguo.wasm`）   | 服务端                       |
| 内容密钥位置 | 浏览器内存                     | 服务端内存                   |
| 设备档案位置 | 浏览器 `localStorage`          | 服务端 SQLite                |
| 浏览器首屏   | 6.85 MB WASM（brotli 1.34 MB） | 业务 JS                      |
| 媒体路径     | 浏览器直连 CDN                 | 浏览器 ← 本服务 ← CDN        |
| HEVC 兼容    | 受浏览器限制                   | 可服务端转码（当前不做）     |
| HEIC 封面    | 需 Web Worker 转码             | 服务端转码 + 缓存            |
| 雪碧图       | 需 Web Worker                  | 服务端转码 + 缓存            |
| 服务端状态   | 无                             | 有（SQLite）                 |

选 B 的核心理由：雪碧图与封面转码需要在服务端缓存（转一次、所有人复用），且内容密钥集中管理。A 形态下这两点都要靠浏览器重复计算。

### 已明确不做的事

| 不做                     | 原因                                                                            |
| ------------------------ | ------------------------------------------------------------------------------- |
| 视频转码（HEVC → H.264） | 成本高（软编 2–5 倍速），且 Chrome/Safari/Edge 都能播 HEVC。先做能力检测 + 提示 |
| HLS / DASH               | 上游短剧是单文件 MP4，没有 HLS 源                                               |
| ffmpeg 或任何系统二进制  | 见第 3 节，两条路都已用纯 JS 替代                                               |
| SSR                      | 纯 SPA，没有 SEO 需求                                                           |

---

## 2. 依赖清单

版本均已实测可协同工作。

### 运行时与工具链

| 用途      | 选择              | 版本      | 备注                                |
| --------- | ----------------- | --------- | ----------------------------------- |
| 运行时    | Node              | 22.20.0   | WASM SDK 与 `better-sqlite3` 已验证 |
| 包管理    | pnpm              | 10.17.1   | workspace                           |
| 类型检查  | **TypeScript**    | **6.0.3** | 见 2.1                              |
| Lint      | ESLint            | 10.14.0   | flat config                         |
| Lint 插件 | typescript-eslint | 8.72.1    | type-aware                          |
| 格式化    | Prettier          | 3.9.10    | 行宽 120                            |
| Git 钩子  | 不使用             | —         | 无 lefthook / husky，不阻断提交      |
| 单元测试  | Vitest            | 5.1.0     |                                     |
| 端到端    | Playwright        | 1.65.0    |                                     |

### 后端

| 用途        | 选择                        | 版本                          |
| ----------- | --------------------------- | ----------------------------- |
| 框架        | **NestJS**                  | 12.4.1                        |
| HTTP 适配器 | `@nestjs/platform-fastify`  | 12.4.1（内含 Fastify 5.12.8） |
| 校验        | Zod                         | 4.6.7                         |
| 数据库驱动  | `better-sqlite3`            | 13.0.3                        |
| ORM         | Drizzle ORM + `drizzle-kit` | 0.45.4                        |
| 上游 SDK    | `openhongguo`               | 0.1.0                         |
| 视频解密    | `node:crypto`               | 内置                          |
| HEIC 转码   | `heic-convert`              | 2.x（纯 JS WASM）             |
| 图片缩放    | `sharp`                     | 最新                          |

### 前端

| 用途       | 选择           | 版本                         |
| ---------- | -------------- | ---------------------------- |
| 构建       | Vite           | 8.3.7                        |
| 框架       | React          | 19.3.1                       |
| 样式       | Tailwind CSS   | 4.3.5（`@tailwindcss/vite`） |
| 路由       | React Router   | 8.5.1（SPA 模式）            |
| 服务端数据 | TanStack Query | 5.107.1                      |
| 客户端状态 | Zustand        | 5.0.16                       |

### 2.1 三个版本约束（实测）

**① TypeScript 必须锁 6.0.3，不能用 7.0.2。**

```
typescript@7.0.2：tsc 编译通过，Nest 装饰器正常，但
typescript-eslint@8.72.1 启动即报错：
  Error: typescript-eslint does not support TS 7.0.
```

`typescript-eslint` 的 peer 是 `typescript: >=4.8.4 <6.1.0`。等它支持 TS 7 再升。

**② 不用 `nestjs-zod`。**

```
nestjs-zod@5.6.0 peer: @nestjs/common ^10.0.0 || ^11.0.0
当前 Nest: 12.4.1
```

为保留 Nest 12，改用 15 行自定义 Pipe（见 4.3）。已实测校验、默认值、类型转换、400 响应都正常。

**③ 不用 `node:sqlite`。**

Node 22 内置可用，但每次启动打印 `ExperimentalWarning`，且 API 仍可能变动。用 `better-sqlite3`（预编译二进制，`pnpm i` 自动装，无需编译器）。

---

## 3. 为什么不需要 ffmpeg

上游 `index.js` 依赖 ffmpeg 做两件事。两件都有纯 JS 替代，且我实测过。

### 3.1 HEIC 封面转码

上游做法（`index.js:107-127`）：macOS 用系统 `sips`，其他平台用 ffmpeg。

实测替代：

| 步骤        | 工具                           | 耗时                |
| ----------- | ------------------------------ | ------------------- |
| HEIC → JPEG | `heic-convert`（libheif WASM） | 52 ms（30 KB 封面） |
| 缩放        | `sharp`                        | 6 ms                |

雪碧图（191 KB，2400×1360）：

| 步骤        | 耗时   |
| ----------- | ------ |
| HEIC → JPEG | 211 ms |
| 缩放        | 7 ms   |

**关键陷阱**：`sharp` **不能**读 HEIC。实测直接报 `bad seek to 30907`。网上说 sharp 支持 HEIF 指的是 AVIF。必须 `heic-convert` 先转，再交给 sharp 缩放。

### 3.2 视频解密与重封装

上游做法（`index.js:283`）：

```
ffmpeg -decryption_key <hex> -i enc.mp4 -map 0 -c copy -tag:v hvc1 -movflags +faststart out.mp4
```

它用 ffmpeg 做两件事：解密，以及把 `moov` 移到文件头（faststart），因为浏览器要先读到 `moov` 才能播放。

**实测发现红果的原始文件本来就是 faststart**，不需要重封装：

```
ftyp@0   moov@28   free@194226   mdat@194234
```

5 档清晰度（360p/480p/540p/720p/1080p）全部如此，`moov` 固定在偏移 28，且都在 `mdat` 之前。

所以流程简化为：

```
下载加密 MP4 → 原地解密（node:crypto aes-128-ctr）→ 直接 Range 流式返回
```

无临时文件、无重封装、无转码。1080p 14.7 MB 解密约 60 ms。

### 3.3 结论

整个项目**零系统依赖**。`pnpm i && pnpm dev` 即可运行，不需要 Docker、不需要 `brew install ffmpeg`。

Docker 只在未来部署时考虑，不是开发前提。

---

## 4. 后端设计

### 4.1 模块划分

```
apps/hongguo/server/src/
├── main.ts
├── app.module.ts
├── serve-web-dist.ts             生产期托管 web/dist 与 SPA 回落
├── config/
│   ├── config.module.ts
│   └── config.ts                 环境变量 + Zod 校验
├── common/
│   ├── diagnostics.controller.ts
│   ├── file-logger.service.ts
│   ├── health.controller.ts
│   ├── listen-address.ts
│   ├── redact.ts                 日志与响应错误脱敏
│   ├── ttl-cache.ts
│   └── zod-validation.pipe.ts
├── hongguo/                      上游 SDK 封装
│   ├── hongguo.module.ts
│   ├── hongguo.service.ts        持有 client、串行化设备注册
│   └── profile.store.ts          SQLite 持久化
├── catalog/                      业务数据
│   ├── catalog.module.ts
│   ├── catalog.controller.ts     feed/search/suggest/random/ranking/series
│   ├── catalog.service.ts
│   ├── catalog.mapper.ts         上游模型 → 自有契约
│   ├── cache-key.ts
│   ├── random-pick.ts
│   ├── ranking-rows.ts
│   └── search-text.ts
├── media/                        视频
│   ├── media.module.ts
│   ├── media.controller.ts       playback + /api/media/:episodeId
│   ├── media-cache.service.ts    下载、原地解密与磁盘缓存
│   ├── media.error.ts
│   ├── playback.service.ts       解析播放信息与内容密钥
│   ├── sprite.service.ts
│   ├── video-model-capture.service.ts
│   ├── cenc.ts                   CENC 原地解密
│   └── range.ts                  206 / 416 处理
├── cover/                        图片
│   ├── cover.module.ts
│   ├── cover.controller.ts       /api/cover/:token
│   ├── cover-token.ts            AES-256-GCM 令牌封装；密钥落在 DATA_DIR（0600）
│   ├── cover-proxy.service.ts    HEIC/JPEG 转换、代理与磁盘缓存
│   ├── sprite.controller.ts      /api/sprite/:episodeId
│   └── sprite-cache.service.ts   雪碧图转换与磁盘缓存
└── db/
    ├── database.ts
    ├── db.module.ts
    └── schema.ts                 Drizzle schema
```

### 4.2 数据库表

```ts
// apps/hongguo/server/src/db/schema.ts（字段摘要）
devices       id, profile, deviceId, state, createdAt, lastUsedAt
deviceUsage   id, deviceRef, day, playbackCount
playback      episodeId, seriesId, definition, expiresAt, duration,
              encryptedBytes, encryptionMethod, mediaFile, updatedAt
spriteSheets  episodeId, videoId, sheetIndex, file, width, height,
              gridX, gridY, cellWidth, cellHeight, frameCount, interval, createdAt
coverCache    urlHash, file, contentType, bytes, createdAt
```

当前实现明确不落库内容密钥，也不保存上游 `streamUrl`。密钥随播放信息解析在内存中计算；
`playback` 表只描述可重新解析的元数据和本地媒体缓存文件。

### 4.3 Zod 校验 Pipe

```ts
// server/src/common/zod-validation.pipe.ts
import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.output<T> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return parsed.data;
  }
}
```

用法：

```ts
@Get('search')
search(@Query(new ZodValidationPipe(SearchQuery)) query: z.output<typeof SearchQuery>) { ... }
```

已实测：`?page=2` 自动转成 `number`，缺 `keyword` 返回 400 且错误体是 Zod issue 数组。

### 4.4 Range 流式响应

Nest + Fastify 下需要 `@Res()` 手动接管：

```ts
@Get(':episodeId')
async stream(@Param('episodeId') id: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
  const file = await this.media.resolve(id)   // 解密后文件路径
  const size = await stat(file).then((s) => s.size)
  const range = req.headers.range
  if (!range) {
    return reply.header('content-length', String(size)).header('content-type', 'video/mp4').send(createReadStream(file))
  }
  const parsed = parseRange(range, size)
  if (!parsed) return reply.code(416).header('content-range', `bytes */${size}`).send()
  reply.code(206)
    .header('content-range', `bytes ${parsed.start}-${parsed.end}/${size}`)
    .header('accept-ranges', 'bytes')
    .header('content-length', String(parsed.end - parsed.start + 1))
    .header('content-type', 'video/mp4')
  return reply.send(createReadStream(file, { start: parsed.start, end: parsed.end }))
}
```

已实测：`HEAD 200`、`Range: bytes=0-99 → 206` 且返回 100 字节、越界 `416`、解密后的 1080p MP4 经此接口在 Chrome 播放（1920×1080，146.8 s，`readyState 4`）。

### 4.5 监听地址与启动提示

服务默认绑定 `0.0.0.0`（所有 IPv4 网卡），让同一局域网内的手机可以直接访问。启动后会按网卡声明顺序列出所有非 internal 的 IPv4 地址，并在末尾保留 `127.0.0.1` 供本机自测；同时打印 warn，提示 `/api/*` 无鉴权、`server/data/` 含设备指纹。需要收回到本机时设置 `HOST=127.0.0.1`。

`0.0.0.0` 只表示监听所有网卡，**不提供任何访问范围隔离**：主机若有公网地址、VPN、容器网桥或端口转发，服务同样可被那些网络访问。局域网限制由主机防火墙与路由器保证，不由绑定地址保证。

地址描述逻辑放在不依赖 `node:os` 的纯函数中，由 `main.ts` 注入真实网卡，便于稳定测试通配地址、回环地址与空网卡边界。

### 4.6 媒体缓存策略

| 项         | 策略                                                            |
| ---------- | --------------------------------------------------------------- |
| 解密后文件 | 存磁盘，键 `episodeId`，LRU 保留 40 个（沿用上游 `MEDIA_KEEP`） |
| 并发同一集 | 用 `Map<episodeId, Promise>` 去重，避免重复下载解密             |
| 播放地址   | 按 `expiresAt` 缓存，剩余不足 5 分钟重新解析                    |
| 内容密钥   | 只在内存，随播放地址一起失效                                    |

### 4.7 接口契约

对外只暴露自有接口，不透传上游松散 JSON。

| 方法  | 路径                                   | 说明                                                                                 |
| ----- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET` | `/api/feed`                            | 首页推荐，游标分页                                                                   |
| `GET` | `/api/search?keyword=&cursor=`         | 搜索                                                                                 |
| `GET` | `/api/suggest?prefix=`                 | 搜索联想；上游失败降级为 200 + 空列表                                                |
| `GET` | `/api/random`                          | 随机一部剧；候选池缓存 60 秒，空池返回 404 `no_random`                               |
| `GET` | `/api/ranking/catalog`                 | 榜单目录：分区与榜单 id/名称，缓存 5 分钟                                            |
| `GET` | `/api/ranking?content=&board=&cursor=` | 榜单条目，游标分页；名次用上游 `position`；非法 board 映射 400 `ranking_unavailable` |
| `GET` | `/api/series/:id`                      | 剧集详情 + 分集列表                                                                  |
| `GET` | `/api/episodes/:id/playback?definition=` | 返回自有 `streamUrl`、`spriteUrl`、`duration`、`availableDefinitions`，**不含**上游签名与密钥 |
| `GET` | `/api/media/:episodeId?definition=`    | Range 流式播放；同时是下载入口（带 `content-length` 与 `accept-ranges: bytes`）      |
| `GET` | `/api/cover/<token>`                    | HEIC → JPEG 代理，带缓存；令牌为上游地址的 AES-GCM 密文                              |
| `GET` | `/api/sprite/:episodeId?sheet=N`       | 进度条雪碧图，JPEG                                                                   |
| `GET` | `/api/health`                          | 健康检查：`ok`、上游三态、`apiVersion`、`deviceRegistered`、`uptimeSeconds`          |
| `GET` | `/api/diagnostics`                     | 诊断：服务端日志最后 200 行（已脱敏）+ 版本 + 运行时长                               |

**约束**：`/api/episodes/:id/playback` 返回的 `streamUrl` 必须指向 `/api/media/:episodeId`。浏览器永远看不到 `qznovelvod.com` 的签名 URL，也拿不到内容密钥。

**下载不新增接口**：单集下载直接用 `GET /api/media/:episodeId`，不带 `definition` 时服务端自动选最佳档。客户端用 `fetch` + `body.getReader()` 流式读，按 `content-length` 算百分比，结束后拼 `Blob` 触发保存。并发上限 2，其余排队，排队项可取消。

**档位规则只有一份**：`shared/src/definitions.ts` 导出 `isRequestableDefinition`（`/^\d{3,4}p$/`）。播放菜单、下载 URL、`PlaybackQuerySchema` 三处都调用它。此前三处各写一套，菜单能选 `unknown`、下载却静默忽略，服务端还会把「不存在的档」静默降级成 720p。

**显式档位必须精确命中**：请求里带了 `definition` 而这一集没有该档时，`PlaybackService` 抛 `definition_unavailable`（HTTP 400），不静默降级。可用档位是**逐集**算的，别的集有 1080p 不代表这一集有；静默降级会让 `-1080p.mp4` 里装着 720p 的内容。

**令牌长度只有一个来源**：`shared/src/definitions.ts` 的 `MAX_COVER_TOKEN_LENGTH = 6144`。`server/src/main.ts` 的 Fastify `maxParamLength`、web 离线快照的 `MAX_COVER_URL_LENGTH` 都从它派生。三处各写字面量已经出过两次事：先是 `maxParamLength` 用默认 100（合法令牌全部 414），后改成 2048 而前端允许 4096（长令牌仍然 414）。

**web 只能 type-only 导入 shared barrel**：`@mlzwl/hongguo-shared` 的 barrel 会连带引入 zod。值导入请走 `@mlzwl/hongguo-shared/definitions` 子路径，否则首屏包从 315 kB 涨到 400 kB（实测）。

**批量下载**不新增接口，也不新增队列：面板里勾选多集后逐集 `enqueue`，队列仍是先来先服务。可提交的集由 `selectBatchTargets` 过滤，跳过已下载、正在下载与排队中的集；不可下载的集（`playable === false`）不进勾选列表。失败的集会被重新提交，所以批量提交本身就是批量重试的入口。全选框三态（未选/部分/全选）的 `indeterminate` 只能通过 DOM 属性设置，React 没有对应 prop。

---

## 5. 前端设计

### 5.1 响应式策略

Tailwind 断点（默认）：

| 前缀   | 宽度     | 目标              |
| ------ | -------- | ----------------- |
| 无前缀 | < 640px  | 手机竖屏          |
| `sm:`  | ≥ 640px  | 手机横屏 / 小平板 |
| `md:`  | ≥ 768px  | 平板              |
| `lg:`  | ≥ 1024px | 桌面              |
| `xl:`  | ≥ 1280px | 宽屏              |

核心布局差异：

| 区域     | 移动端               | 桌面端                |
| -------- | -------------------- | --------------------- |
| 首页列表 | 2 列网格             | 4–6 列网格            |
| 播放页   | 全屏竖屏，上下滑切集 | 居中 16:9，左右键切集 |
| 搜索     | 顶部全宽输入         | 侧栏输入              |
| 历史     | 底部抽屉             | 右侧面板              |

### 5.2 播放器

**原生 `<video>` + 自写控件**，不用第三方播放器库。

理由：短剧需要「上下滑切集」「长按倍速」「单击暂停/双击点赞」这类非标准手势，第三方库会限制实现。

封装成单一组件，对外只暴露：

```ts
interface PlayerProps {
  src: string;
  poster?: string;
  initialTime?: number;
  spriteUrl?: string;
  spriteMeta?: {
    gridX: number;
    gridY: number;
    interval: number;
    frameCount: number;
    cellWidth: number;
    cellHeight: number;
  };
  onEnded: () => void;
  onProgress: (position: number, duration: number) => void;
}
```

换实现时界面代码不用改。

### 5.3 雪碧图（已确认要做）

上游返回 `big_thumbs[0]`：

```jsonc
{
  "img_num": 147, // 总帧数
  "img_x_len": 10, // 每行格子数
  "img_y_len": 10, // 每列格子数
  "img_x_size": 240, // 单帧宽（px）
  "img_y_size": 136, // 单帧高（px）
  "interval": 1, // 秒
  "img_urls": ["...", "..."], // 多张图！见下
}
```

**关键：`img_urls` 可能是数组，不止一张图。**

实测同一集：

| 集  | `img_num` | 网格  | 每张容量 | `img_urls.length` | `ceil(img_num/容量)` |
| --- | --------- | ----- | -------- | ----------------- | -------------------- |
| A   | 97        | 10×10 | 100      | 1                 | 1 ✅                 |
| B   | 147       | 10×10 | 100      | 2                 | 2 ✅                 |
| C   | 355       | 10×10 | 100      | 4                 | 4 ✅                 |
| D   | 545       | 10×10 | 100      | 6                 | 6 ✅                 |

所以规则是：**每张图 `gridX × gridY` 格，帧数超过就分多张。** 第 `n` 帧在图 `floor(n / (gridX*gridY))` 的第 `n % (gridX*gridY)` 格。

**最后一张图也补满到完整网格。** 实测 545 帧的 6 张图，转 JPEG 后**全部**是 2400×1360（10×10），没有一张是半高的。所以不能靠图片高度推断有效帧数，必须用 `img_num` 判断。第 545 帧之后的格子是空白或重复内容。

单张图转 JPEG 后是 2400×1360（10 列 × 10 行，每格 240×136）。

服务端接口设计：

```
GET /api/sprite/:episodeId          → { sheets: [{ url, index }], grid, interval, frameCount }
GET /api/sprite/:episodeId?sheet=0  → image/jpeg
```

前端定位第 `n` 帧：

```ts
const cellsPerSheet = gridX * gridY;
const sheet = Math.floor(n / cellsPerSheet);
const cell = n % cellsPerSheet;
const col = cell % gridX;
const row = Math.floor(cell / gridX);
// background-image: url(sheets[sheet].url)
// background-position: -col*cellWidth  -row*cellHeight
```

两个坑：

1. **不要用 `img_y_len` 推算有效帧数。** 每张图都补满完整网格，最后一张也是满的。
2. **`img_num` 与 `duration / interval` 不一定相等。** 实测某集 `img_num=110`、`duration=110.334`、`interval=1`，向上取整是 111 帧，但只有 110 张。所以按时间取帧时要 `Math.min(Math.floor(t / interval), frameCount - 1)`，否则最后一秒会越界。

### 5.4 数据层

```ts
// 服务端数据：TanStack Query
useInfiniteQuery({
  queryKey: ['feed'],
  queryFn: ({ pageParam }) => api.feed({ cursor: pageParam }),
  initialPageParam: undefined,
  getNextPageParam: (last, all) => nextFeedCursor(last, all),
  // 离线快照只做首屏占位，不写进 cache（见下）
  ...buildFeedQueryOptions(snapshot),
});

// 客户端状态：Zustand
usePlayerStore; // 当前剧集、当前集、音量、倍速、静音
useHistoryStore; // 播放进度（持久化到 localStorage）
useFollowStore; // 收藏/追更两个独立开关 + 集数高水位（持久化到 localStorage）
```

首页分页判定全部集中在 `web/src/features/feed/feed-paging.ts`，不散在路由里：

- `nextFeedCursor(last, all)`：末页 `cursor === null` 或页数达 40 就停；去重时
  跳过 `cursor === null` 的页（那是离线快照，不是网络分页历史）；整页没有新 id 也停。
- `buildFeedQueryOptions(snapshot)`：有快照时返回 `placeholderData`，**不返回
  `initialData`**。`initialData` 会把快照页写进 cache 并当成真实分页历史，导致
  `last.cursor === null` 直接把无限滚动词成终止。
- `shouldFallBackToSnapshot(isError, hasSnapshot)`：只在请求最终失败且快照存在时
  才退回快照。不能改用 `isPlaceholderData`：它在进入 `error` 状态后会被置回 `false`。

收藏页 `/favorites` 用三个 tab（在看 / 想看 / 看完）替代纵向平铺：
`role="tablist"` / `role="tab"` / `role="tabpanel"`，`aria-selected`、
`aria-controls`、`aria-labelledby` 成对存在，DOM 里同时只有一个 panel。
tab 上带数量；默认选第一个非空 tab，全空时选第一个；键盘支持
Left/Right/Up/Down/Home/End。取消收藏后停留当前 tab，变空时在 panel 内显示空状态。
分组、tab 映射与默认选中逻辑在 `web/src/features/follow/favorites-view.ts`（纯逻辑）。

localStorage 键沿用上游，便于迁移：

```
dsh-hongguo.watch-history.v1
dsh-hongguo.watch-history.v1.volume
dsh-hongguo.follow.v1
dsh-hongguo.catalog.v1
dsh-hongguo.search-history.v1
hongguo.theme.v1
dsh-hongguo
```

`dsh-hongguo.catalog.v1` 是首页第一页的离线快照：最多 30 条、序列化后
不超过 200 KB、7 天过期、不含播放地址。读取时逐字段校验，任何一条不合法就整体丢弃。
常量见 `web/src/features/feed/offline-catalog.ts` 的 `MAX_ITEMS` / `MAX_SERIALIZED_BYTES` / `MAX_AGE_MS`。

`dsh-hongguo.search-history.v1` 是搜索历史：最多 20 条、单条 80 字符、
最新在前，重复词提到最前。常量见 `web/src/features/search/search-history-store.ts` 的 `MAX_HISTORY_ITEMS`。

`hongguo.theme.v1` 是主题偏好（`light` / `dark` / `system`），与上游键名一致。

### 5.5 目录

```
apps/hongguo/web/src/
├── main.tsx
├── app.tsx
├── routes/
│   ├── feed-route.tsx
│   ├── search-route.tsx
│   ├── series-route.tsx
│   ├── player-route.tsx
│   ├── history-route.tsx
│   ├── favorites-route.tsx         我的收藏（路由级懒加载）
│   └── ranking-route.tsx           热度榜（路由级懒加载）
├── features/
│   ├── feed/
│   │   ├── offline-catalog.ts        离线目录快照的校验与序列化（纯逻辑）
│   │   ├── offline-catalog-store.ts  localStorage 读写
│   │   └── feed-paging.ts            首页分页游标、快照查询配置、失败回退判定（纯逻辑）
│   ├── download/                     单集与批量下载
│   │   ├── download-state.ts         状态机、进度与字节格式化、失败文案（纯逻辑）
│   │   ├── download-queue.ts         并发闸门与排队（纯逻辑）
│   │   ├── download-selection.ts     批量勾选、全选三态、可提交集过滤（纯逻辑）
│   │   ├── download-media.ts         流式拉取 + 触发保存
│   │   ├── download-media-url.ts     媒体 URL 构造（纯逻辑）
│   │   ├── use-download.ts           进度、排队、取消、重试
│   │   ├── download-panel.tsx        详情页下载面板
│   │   └── episode-download-button.tsx 单集下载按钮（状态即按钮文案）
│   ├── search/
│   ├── series/
│   ├── navigation/                   返回目标计算（纯逻辑）
│   ├── theme/                        主题偏好
│   ├── diagnostics/                  导出诊断（收集 + 序列化 + 写剪贴板）
│   │   └── export-diagnostics.ts     依赖全注入，便于测试
│   ├── player/
│   │   ├── player.tsx                播放器主组件
│   │   ├── progress-bar.tsx          进度条（按合并后的缓冲区间分段绘制）
│   │   ├── volume-control.tsx        音量滑块
│   │   ├── speed-menu.tsx            倍速菜单
│   │   ├── definition-menu.tsx       清晰度菜单
│   │   ├── episode-drawer.tsx        选集抽屉
│   │   ├── sprite-preview.tsx        拖动时的雪碧图预览
│   │   ├── buffered-ranges.ts        buffered / seekable 区间合并（纯逻辑）
│   │   ├── frame-mode.ts             画幅三档到 object-fit 的映射（纯逻辑）
│   │   ├── playback-error.ts         服务端错误码到文案与动作的映射（纯逻辑）
│   │   ├── prefetch-policy.ts        下一集预热时机判定（纯逻辑）
│   │   ├── prefetch-next.ts          预热请求触发
│   │   ├── definition-selection.ts   清晰度选择与持久化（纯逻辑）
│   │   ├── episode-groups.ts         选集分组（纯逻辑）
│   │   ├── resume-target.ts           续播目标计算（已看完 → 下一集）
│   │   ├── resume-initial-time.ts    首帧定位（纯逻辑）
│   │   ├── shortcuts.ts              键位表与按键规范化（纯逻辑）
│   │   ├── pointer-motion.ts         指针移动去重判定（纯逻辑）
│   │   ├── controls-lock.ts          控件隐藏锁的来源集合（纯逻辑）
│   │   ├── player-store.ts           播放器偏好持久化
│   │   ├── use-focus-trap.ts         对话框焦点陷阱
│   │   ├── use-fullscreen.ts         全屏
│   │   └── use-gestures.ts           单击/双击/长按/上滑手势
│   ├── history/
│   ├── follow/            收藏与追更两个独立开关
│   │   ├── follow-model.ts           状态机（纯逻辑）
│   │   ├── follow-store.ts           持久化
│   │   └── favorites-view.ts        收藏列表分组与汇总（纯逻辑）
│   └── ranking/           热度榜
│       ├── ranking-view.ts          分区/榜单选择、名次与分值展示、分页合并（纯逻辑）
│       └── ranking-card.tsx         榜单专用卡片
├── components/            通用组件（含内联 Phosphor 图标）
├── lib/
│   ├── api-client.ts
│   ├── client-events.ts              前端事件环形缓冲（200 条）
│   ├── diagnostics-report.ts         诊断包装配与形状校验（纯逻辑）
│   ├── debounced-suggest.ts          联想输入的防抖与取消（纯逻辑）
│   ├── write-queue.ts                串行持久化队列（纯逻辑）
│   ├── random-entry.ts               随机入口（纯逻辑）
│   ├── query-keys.ts
│   ├── use-grid-columns.ts
│   ├── use-infinite-scroll.ts
│   ├── use-scroll-intent.ts
│   ├── use-wide-viewport.ts
│   └── format.ts
├── assets/
└── styles/
    └── index.css
```

---

## 6. 工程配置

### 6.1 monorepo

```
apps/hongguo/
├── AGENTS.md
├── README.md
├── THIRD_PARTY_NOTICES.md
├── docs/
├── design-system/         设计基准（MASTER.md）
├── scripts/               仓库内脚本（如 ui-audit）
├── shared/                @mlzwl/hongguo-shared
├── server/                @mlzwl/hongguo-server
├── web/                   @mlzwl/hongguo-web
├── eslint.config.js       子包 ESLint（额外启用 curly）
└── tsconfig.base.json     子包 TS 严格项
```

本包是仓库根 pnpm workspace 的三个成员（`pnpm-workspace.yaml` 的 `apps/hongguo/*`）。
根目录还有共享的 ESLint、Prettier、TypeScript 配置与 `pnpm hongguo:*` 脚本。

依赖方向（单向，不允许反向）：

```
apps/hongguo/web  ──►  shared  ◄──  apps/hongguo/server
```

`web` 不得 import `server`，也不得直接 import `openhongguo`。

### 6.2 tsconfig

`tsconfig.base.json`（各包继承，**不得关闭任何一项**）：

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",

    // 严格性
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,

    // 模块
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
  },
}
```

`server/tsconfig.json` 追加：

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "types": ["node"],
  },
  "include": ["src"],
}
```

`noUncheckedIndexedAccess` 实测效果（已用 tsc 6.0.3 验证）：

```ts
const buf = new Uint8Array(10);
const b = buf[3];
const n: number = b; // ❌ TS2322: Type 'number | undefined' is not assignable to type 'number'

const obj: { a?: string } = {};
const s: string = obj.a; // ❌ TS2322: Type 'string | undefined' is not assignable
```

这对 MP4 解析是必需的：`stsz` 样本表、`stsc` run 表、`senc` IV 表全是下标访问，越界必须被编译器拦住。

收敛方式（禁止 `!`）：

```ts
// shared/src/bytes.ts
export function at(buf: Uint8Array, i: number): number {
  const v = buf[i];
  if (v === undefined) throw new RangeError(`byte ${i} out of range (len ${buf.length})`);
  return v;
}
export function readU32(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset);
}
```

### 6.3 lint / format / hooks

`eslint.config.js`（flat config）：

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  prettier, // 必须最后
);
```

`no-floating-promises` 实测有效：Nest 的 `bootstrap()` 不加 `void` 会报错。

`.prettierrc.json`（仓库根）：

```json
{ "semi": true, "singleQuote": true, "printWidth": 120, "trailingComma": "all" }
```

注意 `semi` 是 `true`。本包原仓库用 `semi: false`，迁入时已全部重格式化。

**没有 Git 钩子。** 仓库不用 lefthook、husky 或其他 hook 管理器，
`core.hooksPath` 也未指向仓库内目录。格式与 lint 检查靠手动或 CI 执行，
不阻断提交。

### 6.4 脚本

仓库根 `package.json` 与本包相关的脚本（本包是 monorepo 的一个成员，根脚本还含其他 app）：

```json
{
  "scripts": {
    "hongguo:dev": "pnpm -r --filter './apps/hongguo/*' --parallel dev",
    "hongguo:build": "pnpm -r --filter './apps/hongguo/*' build",
    "hongguo:typecheck": "pnpm -r --filter './apps/hongguo/*' typecheck",
    "hongguo:lint": "pnpm -r --filter './apps/hongguo/*' lint",
    "hongguo:test": "pnpm -r --filter './apps/hongguo/*' test",
    "hongguo:verify": "pnpm -r --filter './apps/hongguo/*' verify",
    "hongguo:start": "pnpm --filter @mlzwl/hongguo-server start"
  }
}
```

每个子包各自有 `typecheck: tsc --noEmit`、`lint: eslint .`、`test: vitest run`、
`format:check: prettier --check .`、`verify`（前三项串行）。`web` 的 `test` 带
`--passWithNoTests`。

日常只跑对应范围，不要动辄全仓 `pnpm verify`。具体取舍见本包 `AGENTS.md` 的「测试范围」。

---

## 7. 实施顺序

按这个顺序做，每步都能独立验证：

1. **骨架**：pnpm workspace + tsconfig.base + eslint + prettier，跑通 `pnpm hongguo:typecheck`。
2. **shared**：Zod schema（上游响应 + 自有契约）+ `bytes.ts` + spade 还原 + MP4 box 解析，配单元测试。
3. **server / hongguo**：SDK 封装 + 设备档案持久化，验证 `discover` 能出数据。
4. **server / media**：`resolvePlayback` → spade → CENC 解密 → Range 流式，验证 Chrome 能播。
5. **server / cover**：HEIC → JPEG + 缓存，验证封面正常显示。
6. **server / sprite**：雪碧图转码 + 多图切片。
7. **web**：feed → series → player，先功能后样式。
8. **web 响应式**：移动端手势与布局。

第 4 步是核心链路，验证通过即可确认整体方案成立。我已经单独验证过「解密后 MP4 → Nest Range → Chrome 播放 1080p」这条路可行。

---

## 8. 风险与缓解

| 风险      | 说明                               | 缓解                                                                                    |
| --------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| HEVC 兼容 | Firefox 多数平台不支持 HEVC        | 检测 `MediaSource.isTypeSupported('video/mp4; codecs="hvc1..."')`，不支持时提示换浏览器 |
| 接口变更  | 签名算法是黑盒逆向                 | 用 WASM SDK 而非自写签名；升级 `openhongguo` 即可                                       |
| 匿名配额  | 单设备 25 次连续播放正常，上限未测 | 设备池轮换；`ANONYMOUS_LIMITED` 时切换设备                                              |
| 磁盘占用  | 解密视频与图片缓存                 | 视频 LRU 40 个；图片按天清理；都放可配置目录                                            |
| 转码 CPU  | HEIC 转码是 CPU 密集               | 转一次即缓存；并发限制（同时最多 2 个）                                                 |
| 密钥泄漏  | 内容密钥在服务端内存               | 不落日志、不落库、不进响应；密钥表仅内存                                                |
| 滥用      | 服务对公网开放                     | 域名白名单、限流、不暴露上游签名 URL                                                    |
| 合规      | 第三方客户端，绕过 DRM             | 仅个人研究，不公开部署，不分发解密内容                                                  |

---

## 9. 待确认

| 项                        | 状态                                 |
| ------------------------- | ------------------------------------ |
| 雪碧图                    | ✅ 确认要做                          |
| 设备档案存储              | ✅ SQLite                            |
| 视频转码                  | ✅ 不做                              |
| API 契约                  | ✅ REST + 共享 Zod                   |
| 播放器实现                | ✅ 原生 `<video>` + 自写控件         |
| 文件命名                  | ✅ 全部 kebab-case                   |
| 是否加 `watchProgress` 表 | ⬜ 待定（也可只放前端 localStorage） |
