# 实现记录

本文记录**已实际跑通并验证**的事实，与 `docs/tech-stack.md`（设计）和 `docs/reverse-engineering.md`（上游逆向）区分开。

只在浏览器或命令行里亲眼确认过的内容才写进来。推测另起一行标明「推测」。

包结构是 pnpm workspace 的三个包：`@mlzwl/hongguo-shared`（`shared/`）、
`@mlzwl/hongguo-server`（`server/`）、`@mlzwl/hongguo-web`（`web/`）。
下文路径都相对 `apps/hongguo/`。

---

## 1. 环境

| 项 | 值 |
| --- | --- |
| Node | 22.20.0 |
| pnpm | 11.24.0（仓库根 `package.json` 的 `packageManager` 字段已钉死） |
| 生产端口 | 9133（server 同时托管 `web/dist`） |
| 开发端口 | 5173（Vite，仅开发期） |

启动方式：

```bash
pnpm hongguo:dev     # 开发：并行启动 server（tsc --watch + node --watch）与 Vite
pnpm hongguo:start   # 生产：只启动 server，单端口 9133
```

`server` 的 `dev` 脚本是 `tsc -p tsconfig.build.json --watch` 加 `node --watch dist/main.js`，
不用 `tsx`。原因见 3.2。

---

## 2. 已跑通的完整链路

浏览器实测（Chrome，Playwright 驱动）：

```
首页 /api/feed            → 9 部剧，封面全部显示
点卡片 → /series/:id      → 104 集，简介、封面正常
点第 1 集 → /watch/:id    → 视频播放，1280×720，readyState 4
拖进度条到 8:20           → 雪碧图预览显示第 500 秒画面（第 6 张图第 0 格）
播放到 42s → 回历史页      → 记录写入，进度条 7.7%
再进播放页                → 自动续播到 42s
上滑                      → 切到第 2 集
搜索「长生」              → 6 条结果，封面全部显示
```

关键验证点：

| 项 | 结果 |
| --- | --- |
| CENC 解密后 `codec_tag` | `hvc1`（原为 `encv`），`mp4a`（原为 `enca`） |
| ffmpeg 全量解码 | 360p / 720p / 1080p 均无错误输出 |
| 解密耗时 | 360p 4.3MB / 23ms；1080p 14.8MB / 18–20ms |
| Range | `0-99 → 206 + 100 字节`；`99999999- → 416`；`HEAD → 200` |
| 封面转码 | HEIC 92KB → JPEG 400×572，首次 105ms，命中缓存 13ms |
| 封面缩放 | `w=240` → 240×343，30KB |
| 雪碧图 | 545 帧 → 6 张 2400×1360 JPEG，单张约 500KB |
| 雪碧图分片 | 第 500 秒 → `sheet 5`、`position 0px 0px`，正确 |

---

## 3. 实现中踩到并修掉的问题

### 3.1 SDK 解构 `ProfileStore` 方法导致 `this` 丢失

**现象**：`/api/feed` 返回 500，日志 `OpenhongguoError: Cannot read properties of undefined (reading 'cached')`。

**原因**：SDK 内部把 store 的方法解构出来调用（相当于 `const { load } = store; load()`），原型方法此时 `this` 是 `undefined`。

**修法**：把 `load` / `save` / `reset` 写成箭头函数类字段：

```ts
load = (): Promise<string | null> => { ... }
```

### 3.2 `tsx` / esbuild 不生成装饰器元数据

**现象**：Nest 启动时报 `The XxxService has no decorator metadata ... will be undefined`，全部 DI 失效。

**原因**：esbuild 不支持 `emitDecoratorMetadata`。

**修法**：不用 `tsx` 跑 Nest。改为 `tsc` 编译到 `dist/`，再 `node dist/main.js`。
`server/package.json` 的 `dev` 脚本是 `tsc --watch` 加 `node --watch`。

### 3.3 Fastify 自动挂载 HEAD 导致路由重复

**现象**：启动即失败，`FST_ERR_DUPLICATED_ROUTE: Method 'HEAD' already declared for route '/api/media/:episodeId'`。

**原因**：Fastify 默认给每个 GET 自动挂一个 HEAD，而 HEAD 会执行 GET 的 handler——那会触发整片下载 + 解密。我显式实现了轻量 HEAD。

**修法**：

```ts
new FastifyAdapter({ exposeHeadRoutes: false })
```

### 3.4 `encv` sample entry 固定字段是 78 字节

**现象**：`Mp4ParseError: encrypted entry encv has no sinf`。

**原因**：`VisualSampleEntry` 在 8 字节 box header 之后有 **78** 字节固定字段（不是 70）。偏移错 1 字节就找不到 `sinf`。

**修法**：

```ts
const childStart = entry.type === 'encv' ? entry.body + 78 : entry.body + 28
```

### 3.5 生命周期顺序：装饰器必须在 client 创建前注册

**现象**：`cannot add transport decorator after client is created`。

**原因**：`HongguoService.onModuleInit` 先于 `MediaModule.onModuleInit` 执行，此时 client 已预热完毕。

**修法**：把预热从 `onModuleInit` 挪到 `onApplicationBootstrap`，装饰器注册放 `MediaModule` 构造函数（构造函数早于所有钩子）。

### 3.6 封面域名白名单写死会静默失效

**现象**：部分封面 502，日志显示 `p9-reading-sign.fqnovelpic.com` 不在白名单。

**原因**：白名单按主机名硬编码，漏了 `p9-reading-sign`。

**修法**：改为按**域名后缀**放行（`.fqnovelpic.com`、`.byteimg.com`、`.douyinpic.com`），仍然只放行字节的图片 CDN，不做任意 URL 代理。

### 3.7 搜索接口不返回封面

**现象**：搜索结果全部「无封面」。

**原因**：上游 `PathSearch` 的响应没有 `cover_url` 字段（实测 6/6 条都缺）。

**修法**：用 `getSeriesBatch` 一次请求补齐 6 条的封面。失败时降级为无封面，不让搜索整体失败。

### 3.8 `exactOptionalPropertyTypes` 与可选属性

开启后不能给可选属性显式赋 `undefined`。上游数据到处是 `string | undefined`，所以映射代码要写成：

```ts
{
  id: source.id,
  ...(source.description === undefined ? {} : { description: source.description }),
}
```

一开始想用「重复调用读取函数 + 三元展开」，被 `exactOptionalPropertyTypes` 挡下（展开类型仍是 `T | undefined`）。正确写法是先取到局部变量再条件赋值。

### 3.9 `react-router` 8 的 `navigate` 返回 Promise

`onClick={() => navigate('/x')}` 会触发 `@typescript-eslint/no-misused-promises`。必须 `onClick={() => { void navigate('/x') }}`。

### 3.10 离线快照必须用 `placeholderData`，不能用 `initialData`

**现象**：首页无限滚动失效。快照存在时 reload，`/api/feed` 零请求，页面停在 8 条加「没有更多了」。

**原因**：快照页的 `cursor` 是 `null`。它一旦作为 `initialData` 写进 Query cache，就进了 `allPages`，而 `last.cursor === null` 直接把分页判成终止。

**修法**：把快照从 `initialData` 换成 `placeholderData`。placeholder 不写 Query cache，cache 为空时挂载必然 fetch；从详情页返回首页时 cache 里已有真实数据，`refetchOnMount: false` 仍生效，「切页回来不重取」的语义不变。

分页判定抽到 `web/src/features/feed/feed-paging.ts` 的 `nextFeedCursor`，同时保留两条防环语义：整页没有新 id 就停；硬上限 40 页。去重时**跳过 `cursor === null` 的页**，否则真实第一页会被快照页误判成重复页。

配置本身必须可测。`buildFeedQueryOptions(snapshot)` 是纯函数，测试直接断言「有快照时没有 `initialData` 键、有 `placeholderData` 键」。只测 `nextFeedCursor` 防不住「有人把 `placeholderData` 改回 `initialData`」这类配置回退。

### 3.11 `isPlaceholderData` 不能当离线兜底判据

TanStack Query 只在 `pending` 状态应用 placeholder，进入最终 `error` 后会把 `isPlaceholderData` 置回 `false`，数据也不再来自 placeholder。

所以「失败时退回快照」抽成 `shouldFallBackToSnapshot(isError, hasSnapshot)`，只看请求已失败与快照存在两件事。

实测：有 7 条快照时断网 reload，修复前 0 张卡片只剩一行报错，修复后 7 张封面全部渲染并显示「当前显示的是离线缓存」。

底部「没有更多了」必须同时排除「占位数据」与「退回快照」两种情况，否则首次请求还没回来就会误报到底。

---

## 4. 上游数据的实测补充

### 4.1 雪碧图分片规律（已确认）

每张固定 `gridX × gridY` 格，帧数超出就分多张，**最后一张也补满**：

| `img_num` | 网格 | 张数 | `ceil(num/100)` |
| --- | --- | --- | --- |
| 97 | 10×10 | 1 | 1 ✅ |
| 147 | 10×10 | 2 | 2 ✅ |
| 355 | 10×10 | 4 | 4 ✅ |
| 545 | 10×10 | 6 | 6 ✅ |

所有张转 JPEG 后都是 2400×1360，**不能用图片高度推断有效帧数**。

### 4.2 `img_num` 与 `duration/interval` 可能差 1

实测某集 `img_num=110`、`duration=110.334`、`interval=1`，`ceil` 得 111 但只有 110 帧。按时间取帧必须 clamp：

```ts
const frame = Math.min(Math.floor(position / interval), frameCount - 1)
```

### 4.3 同一集不同清晰度共用一把密钥

360p 与 1080p 下载后分别用同一把 `contentKey` 解密，两者都通过 ffmpeg 全量解码。所以密钥缓存按 `episodeId` 存即可，不需要按清晰度区分。

**反例警示**：早期我用「17:35 下载的 1080p 文件 + 另一次调用的密钥」测试，ffmpeg 报 `Invalid NAL unit size`。那是密钥与文件不配对，不是算法问题。测试必须用同一次调用取得的文件与密钥。

### 4.4 `video_id` 与 `episode_id` 相同

实测 `video_model` 请求体的 `video_id` 与响应里的 `episode_id` 是同一个值。捕获器仍两个键都存一份，不依赖这个巧合。

### 4.5 搜索与 `getSeriesBatch`

`getSeriesBatch` 一次可传多个 id，按顺序返回，每项含完整 `series`（带 `cover_url`）与 `episodes`。适合用来补封面。

### 4.6 榜单名次用 `position`，不用 `rank`

实测热播榜的 `rank` 为 `1,2,3,4,5,5,6,7,8,10,9,10`——重复且跳号，推广行会照抄下一行名次。`position` 连续（`1..12`，第二页 `13..22`）。

`votes` 在短剧榜恒为 `undefined`，因此不暴露。`score` 是展示文本（`"8835万热度"` / `"平台推荐"`），原样透传不解析——解析成数字会丢失 `"平台推荐"` 这种非数字值。

上游数组本身就是榜单展示顺序，**不按 `position` 重排**，重排会擅自改写语义。

### 4.7 缓存键不能用固定分隔符拼接

`z.string()` 不拒绝 NUL，URL 的 `%00` 能还原成真实 NUL 字节，所以 `{content:'a\0b', board:'c'}` 与 `{content:'a', board:'b\0c'}` 会拼出同一个键；`cursor ?? 'first'` 又会让字面量游标 `"first"` 撞上「没有游标」。

`server/src/catalog/cache-key.ts` 的 `cacheKeyOf` 用 `JSON.stringify` 对字段数组做可逆序列化，并用 `null` 表示缺失，因此缺失、空串、含任意字符的值都能区分。`feed`、`search`、`ranking` 三处共用该函数。

---

## 5. 当前实现状态

### 5.1 已完成

| 模块 | 文件 | 状态 |
| --- | --- | --- |
| shared / 字节工具 | `shared/src/bytes.ts` | ✅ |
| shared / spade 还原 | `shared/src/spade.ts` | ✅ 6 组真实向量通过 |
| shared / MP4 解析 | `shared/src/mp4.ts` | ✅ 含 `moov` 前置校验、`frma` codec 恢复 |
| shared / API 契约 | `shared/src/schemas/api.ts` | ✅ |
| server / CENC 解密 | `server/src/media/cenc.ts` | ✅ ffmpeg 验证 + 26 个用例 |
| server / Range 解析 | `server/src/media/range.ts` | ✅ 9 个边界用例 |
| server / SDK 封装 | `server/src/hongguo/hongguo.service.ts` | ✅ |
| server / 目录服务 | `server/src/catalog/` | ✅ 含榜单、缓存键、搜索归一化 |
| server / 播放 | `server/src/media/` | ✅ 清晰度按短边判定（`resolutionOf` 用 `Math.min(width, height)`）、多地址回退、超时、大小上限、错误分类 |
| server / 封面 | `server/src/cover/` | ✅ 令牌化代理，上限 100 个 / 24 MB |
| server / 雪碧图 | `server/src/media/sprite.service.ts`、`server/src/cover/sprite-cache.service.ts` | ✅ 写后异步清理 |
| server / 数据库 | `server/src/db/` | ✅ Drizzle 迁移已生成，`devices` 表在用 |
| web / 首页 | `web/src/routes/feed-route.tsx` | ✅ 含离线快照与 18/12 分页 |
| web / 搜索 | `web/src/routes/search-route.tsx` | ✅ 防抖、历史、建议 |
| web / 详情 | `web/src/routes/series-route.tsx` | ✅ 含单集与批量下载 |
| web / 播放 | `web/src/routes/player-route.tsx` | ✅ |
| web / 历史 | `web/src/routes/history-route.tsx` | ✅ |
| web / 收藏 | `web/src/routes/favorites-route.tsx` | ✅ 收藏与追更两个独立开关 |
| web / 榜单 | `web/src/routes/ranking-route.tsx` | ✅ |
| web / 手势 | `web/src/features/player/use-gestures.ts` | ✅ 上滑切集、双击播放暂停、长按 2× 均已接 |
| web / 键盘 | `web/src/features/player/shortcuts.ts` | ✅ Space / 方向键 / F / M，按 `event.code` 规范化 |
| web / 画幅 | `web/src/features/player/frame-mode.ts` | ✅ contain / cover / fill 三档，不持久化 |
| web / 缓冲区间 | `web/src/features/player/buffered-ranges.ts` | ✅ 合并相邻区间后分段绘制 |
| web / 错误分类 | `web/src/features/player/playback-error.ts` | ✅ 按服务端 `code` 给文案与动作 |
| web / 下载 | `web/src/features/download/` | ✅ 并发上限 2，排队可取消 |
| 构建产物 | `shared/dist`、`server/dist`、`web/dist` | ✅ 三个包的 `dist/` 均已存在，且由 `apps/hongguo/.gitignore` 的 `dist/` 规则排除 |

### 5.2 未完成 / 待办

| 项 | 说明 |
| --- | --- |
| 设备池轮换 | 当前只有一台设备。`ANONYMOUS_LIMITED` 时 `resetDevice()` 可重置，但没有多设备池 |
| `playback` 表未实际使用 | schema 已建，但播放解析结果还没落库（当前每次重新解析） |
| Firefox HEVC 预检测 | 有按错误码分类的提示，但没做 `MediaSource.isTypeSupported` 预检测 |
| 移动端真机 | 只用 Playwright 模拟过视口，没上真机 |
| 外链 URL 安全校验 | 当前没有用户可输入的外链入口，未做统一白名单 |
| 播放偏好严格校验 | 偏好项少且都是枚举，未引入独立 Zod 校验层 |
| 封面与雪碧图的定时清理 | 两个 `evict` 都是写后触发，没有定时任务 |

### 5.3 明确不做

| 项 | 理由 |
| --- | --- |
| 访问口令 | 无威胁模型。实际隔离依赖主机防火墙与路由器 |
| 请求作用域取消 | 上游 `discover` 约 2.5 秒，提前中止只省服务端开销；SDK 的 `Transport` 类型不接受 `AbortSignal` |
| 并发播放上限 | 单用户单机，多标签页同时播放是低频场景；同一集的并发请求已共享 Promise |
| 弹幕与评论 | `openhongguo` 没有评论或弹幕接口，只有 `Episode.comment_count` 一个计数字段。上游弹幕走 `/novel/commentapi/comment/list/<vid>/v1/`，需要独立的 `X-Argus` + `metasec`（`app_id=3019`）签名体系，与 SDK 现有签名不是同一套。这是新增逆向工作，不是可吸收的实现 |
| 局域网传输与同步 | 单机单用户 |
| 多源管理、浏览器 HEIC 解码、自定义协议、HTML 解析 | 当前架构下不适用 |
| 解密放 Worker | 1080p 14.8 MB 实测 18–20 ms，主线程阻塞可接受 |
| 睡眠定时器 | 单集 2–3 分钟，用户看完就走；维护 deadline、后台唤醒、跨集递减三套状态与「不做复杂状态机」的取舍冲突 |
| 视频转码 | 不引入 ffmpeg。CENC 原地解密长度不变，Range 与偏移表都依赖这个前提 |
| 纯前端化 | 见 `docs/reverse-engineering.md` 第 4 节：跨域预检失败，带 `Origin` 头会被判 `AUTHENTICATION_REQUIRED` |

### 5.4 已完成批次的实现要点

这一节保留从早期改进计划里沉淀下来的结论。每条都能在当前代码里找到对应实现。

| 主题 | 结论 | 证据 |
| --- | --- | --- |
| 首页分页 | 离线快照必须用 `placeholderData`，用 `initialData` 会把 `cursor: null` 写进 cache 并终止分页 | `web/src/features/feed/feed-paging.ts` 的 `buildFeedQueryOptions`；测试断言有快照时没有 `initialData` 键 |
| 离线兜底 | `isPlaceholderData` 不能当判据，进入 `error` 后会被置回 `false` | `shouldFallBackToSnapshot(isError, hasSnapshot)` |
| 缓存键 | 不用固定分隔符，也不用 `?? 'first'` 默认值 | `server/src/catalog/cache-key.ts` 的 `cacheKeyOf` |
| 榜单名次 | 用 `position`，不用 `rank` | `server/src/catalog/ranking-rows.ts` |
| 批量下载 | 不新增接口与队列，逐集 `enqueue` 进同一个 `DownloadQueue`，并发上限 2 | `web/src/features/download/use-download.ts` 的 `MAX_CONCURRENT_DOWNLOADS = 2` |
| 批量选择 | `selectionState` 返回 `none` / `partial` / `all`；部分选中时再点全选变全选，不清空 | `web/src/features/download/download-selection.ts` |
| 下载档位 | `definition` 在入队时冻结，之后不读全局偏好 | `web/src/features/download/download-queue.ts` 的 `DownloadTask` |
| 集号列 | `w-16` 加 `whitespace-nowrap`。48px 装不下「第 53 集」会折行 | `web/src/features/download/download-panel.tsx` |
| 收藏与追更 | 两个独立布尔量 `favorite` / `following`，不是三态枚举；只有 `following` 产生更新角标 | `web/src/features/follow/follow-model.ts` |
| 收藏页卡片 | 另写专用卡片，不复用 `SeriesCard`。整卡是 `<button>`，内层再放取消收藏按钮会造成嵌套按钮 | `web/src/routes/favorites-route.tsx` |
| 首页分页尺寸 | 宽视口 18 条、窄视口 12 条；补页序列是 7 → 13 → 19，按页粒度落不到目标值，所以渲染量由独立门槛控制 | `web/src/features/feed/feed-paging.ts` |

已落地的稳定性项：搜索输入 300 ms 防抖与请求取消（`web/src/lib/debounced-suggest.ts`）、
目录 TTL 缓存（`server/src/catalog/catalog.service.ts`）、封面上限 100 个 / 24 MB
（`server/src/cover/cover-proxy.service.ts`）、雪碧图写后异步清理
（`server/src/media/sprite.service.ts`）、播放错误按码分类
（`web/src/features/player/playback-error.ts`）、诊断导出
（`web/src/features/diagnostics/export-diagnostics.ts`）。

---

## 6. 命令与检查

全部在仓库根目录执行。

```bash
pnpm hongguo:typecheck   # 三个包 tsc --noEmit
pnpm hongguo:lint        # 三个包 eslint
pnpm hongguo:test        # 三个包 vitest run
pnpm hongguo:build
pnpm hongguo:verify      # 上面四项串行
```

当前测试规模（`pnpm hongguo:test` 实测）：52 个 `*.test.ts` / `*.test.tsx` 文件，
745 个用例。按包分：`shared` 2 个文件 14 个用例、`server` 19 个文件 280 个用例
（279 通过 + 1 跳过，跳过的是依赖真实加密样本的那组）、`web` 31 个文件 451 个用例。

`tsc` 严格项已实际验证生效：

- `noUncheckedIndexedAccess`：`const n: number = buf[2]` → TS2322
- `exactOptionalPropertyTypes`：给可选属性赋 `undefined` → TS2375
- `noPropertyAccessFromIndexSignature`：`process.env.DATA_DIR` → TS4111
- `noUnusedLocals` / `noUnusedParameters` → TS6133
- `noImplicitReturns` → TS7030

---

## 7. 已知限制

| 限制 | 影响 | 现状 |
| --- | --- | --- |
| 只支持 HEVC 直放 | Firefox 多数平台播不了 | 有错误码分类提示，无预检测 |
| 单设备 | 配额耗尽即不可用 | 未实现轮换 |
| 无转码 | 老设备可能性能不足 | 已明确不做 |
| 密钥仅内存 | 进程重启要重新解析 | 可接受 |
| 视频缓存按集+清晰度 | 同集切档会占两份磁盘 | LRU 40 个兜底 |
