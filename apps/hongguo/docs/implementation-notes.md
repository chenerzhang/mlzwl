# 实现记录

本文记录**已实际跑通并验证**的事实，与 `docs/tech-stack.md`（设计）和 `docs/reverse-engineering.md`（上游逆向）区分开。

只在浏览器或命令行里亲眼确认过的内容才写进来。推测另起一行标明「推测」。

---

## 1. 环境

| 项 | 值 |
| --- | --- |
| Node | 22.20.0 |
| pnpm | 10.17.1 |
| 后端端口 | 9133 |
| 前端端口 | 5173 |

启动方式：

```bash
# 后端（先编译，tsx 不生成装饰器元数据，Nest DI 会失败）
cd apps/server && npx tsc -p tsconfig.build.json && node dist/main.js

# 前端
cd apps/web && npx vite
```

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

**修法**：不用 `tsx` 跑 Nest。改为 `tsc` 编译到 `dist/`，再 `node dist/main.js`。`package.json` 的 `dev` 脚本改成 `tsc --watch` + `node --watch`。

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

---

## 5. 当前实现状态

### 已完成

| 模块 | 文件 | 状态 |
| --- | --- | --- |
| shared / 字节工具 | `packages/shared/src/bytes.ts` | ✅ |
| shared / spade 还原 | `packages/shared/src/spade.ts` | ✅ 6 组真实向量通过 |
| shared / MP4 解析 | `packages/shared/src/mp4.ts` | ✅ |
| shared / API 契约 | `packages/shared/src/schemas/api.ts` | ✅ |
| server / CENC 解密 | `apps/server/src/media/cenc.ts` | ✅ ffmpeg 验证 + 4 个用例 |
| server / Range 解析 | `apps/server/src/media/range.ts` | ✅ 9 个边界用例 |
| server / SDK 封装 | `apps/server/src/hongguo/hongguo.service.ts` | ✅ |
| server / 目录服务 | `apps/server/src/catalog/` | ✅ |
| server / 播放 | `apps/server/src/media/` | ✅ |
| server / 封面 | `apps/server/src/cover/` | ✅ |
| server / 雪碧图 | `apps/server/src/cover/sprite*.ts` | ✅ |
| server / 数据库 | `apps/server/src/db/` | ✅ Drizzle 迁移已生成 |
| web / 首页 | `apps/web/src/routes/feed-route.tsx` | ✅ |
| web / 搜索 | `apps/web/src/routes/search-route.tsx` | ✅ |
| web / 详情 | `apps/web/src/routes/series-route.tsx` | ✅ |
| web / 播放 | `apps/web/src/routes/player-route.tsx` | ✅ |
| web / 历史 | `apps/web/src/routes/history-route.tsx` | ✅ |
| web / 手势 | `apps/web/src/features/player/use-gestures.ts` | ✅ 上滑切集已验证 |

### 未完成 / 待办

| 项 | 说明 |
| --- | --- |
| 设备池轮换 | 当前只有一台设备。`ANONYMOUS_LIMITED` 时没有备用设备 |
| `playback` 表未实际使用 | schema 已建，但播放解析结果还没落库（当前每次重新解析） |
| 雪碧图清理 | `evict` 方法写了但没接定时任务 |
| 封面缓存清理 | 同上 |
| 竖屏视频适配 | 当前 `object-contain`，竖屏短剧会有黑边。需要按 `videoWidth/videoHeight` 判断 |
| 双击点赞 | 手势 hook 支持，界面未接 |
| 长按倍速 | 手势 hook 支持，界面未接 |
| 键盘快捷键 | 桌面端空格/方向键未接 |
| Firefox HEVC 提示 | 有错误提示文案，但没做能力预检测 |
| 生产构建 | `vite build` 未跑过 |
| 移动端真机 | 只用 Playwright 模拟过视口，没上真机 |

---

## 6. 命令与检查

```bash
pnpm -r typecheck   # 3 个包全通过
pnpm -r lint        # 3 个包全通过
pnpm -r test        # shared 10 个，server 13 个（含 Range 边界 9 个）
```

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
| 只支持 HEVC 直放 | Firefox 多数平台播不了 | 有错误提示，无预检测 |
| 单设备 | 配额耗尽即不可用 | 未实现轮换 |
| 无转码 | 老设备可能性能不足 | 已明确不做 |
| 密钥仅内存 | 进程重启要重新解析 | 可接受 |
| 视频缓存按集+清晰度 | 同集切档会占两份磁盘 | LRU 40 个兜底 |
