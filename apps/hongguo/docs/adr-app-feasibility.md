# 独立 App 可行性调研：去掉自建后端的 Android 客户端

本文回答一个问题：**能不能做一个不依赖自建后端的 Android App，功能与现有 web 移动端一致？**

本文只写能从代码与实测记录确证的事实。凡属推断，一律标【推导】。凡无法从现有证据确证的，列入第 7 节「待实测」。

---

## 1. 结论

> **2026-11-13 23:00 修正（第二次）**：上一版「匿名设备拿不到播放源、换架构不能绕开」的结论**作废**。
> 匿名身份完全正常。根因是 `novel/player/video_model/v1/` 已被上游下线，
> 替代接口 `multi_video_model/v1` 可用，但**不能同时带 `device_platform=android` 与 `aid=8662`**。
> 已用本仓库现有代码打通「取流 → 下载 → 推导密钥 → CENC 解密 → 1080p 出画面」全链路（4/4 集）。
> 详见 7.1.2。

**技术层面可行，但有两个前提：不能靠「复用现有 web 端」实现，且必须绕开 SDK 里已下线的接口。**

三个服务端能力搬到 App 的可行性（与上游策略无关，仍然成立）：

| 服务端今天做的事 | 搬到 App 后的做法 | 证据 |
| --- | --- | --- |
| 调用上游 SDK、持有匿名设备档案 | 在 App 内跑同一份 `dist/openhongguo.wasm`（见 2.1） | `Transport` 可自定义，见 2.2；已实测可行 |
| 还原 `spade_a` 得到内容密钥 | 已有现成实现 `shared/src/spade.ts` | `deriveContentKey()` 是纯函数 |
| CENC 原地解密后输出明文流 | 已有一份实现，只差换掉 `node:crypto` | `server/src/media/cenc.ts` 仅一处平台依赖 |

关键判断：**前两件几乎零成本，第三件是小改动。真正的工作量在播放器与 UI 重写，不在协议层。**
2026-11-13 23:00 已用这三件在真实集上跑通全链路，见 7.1.2。

**2026-11-13 已实测验证的部分**（Android 模拟器，见 7.1）：

| 能力 | 结果 |
| --- | --- |
| WebView 内加载 6.5 MB WASM | 可行（下载 540–2051 ms，实例化 361–602 ms） |
| Kotlin 侧 OkHttp 桥接 `Transport` | 可行（`discover` 返回 8–9 条真实数据） |
| WebView 内 `fetch` 直连上游 | **被 CORS 拦截**，必须桥接 |
| HEVC（`hvc1`）播放 | **可行**（1080x1920 实测出画面） |
| 官网 SSR 明文 MP4（T8） | **失效**（`protectedPlayback: true`，无 `contentUrl`） |
| 播放接口取内容密钥 | **已打通**（换 `multi_video_model/v1`，避开 `device_platform=android`+`aid=8662`） |
| CENC 解密 + 1080p 出画面 | **已打通**（`shared/dist/spade.js` + `server/dist/media/cenc.js`，未改动） |

【推导】最省力的路线仍是「Android WebView + 本地静态资源 + 原生桥接 Transport」，
它能直接复用现有 `web/` 的 React 代码与全部 shared 逻辑。

**但 SDK 目前仍在调已下线的 `video_model/v1`，必须先做适配层（或等上游修）。**
适配层的做法与风险见 7.1.2 与 10.2 的 T0。

---

## 2. 协议层能否脱离服务端

### 2.1 SDK 是纯 WASM，签名全在里面

`openhongguo@0.1.0` 的运行时核心是 `dist/openhongguo.wasm`（6,855,007 B，约 6.5 MiB）。下文用 `$SDK` 指代该包的安装目录 `node_modules/.pnpm/openhongguo@0.1.0/node_modules/openhongguo`。用 `strings` 探测可确认签名与 DRM 算法都编译在 WASM 内：

```
github.com/beilunyang/openhongguo/internal/protocol/sign.assembleMedusa
github.com/beilunyang/openhongguo/internal/protocol/sign.medusaAESKey
github.com/beilunyang/openhongguo/internal/protocol/sign.rc4Gorgon
github.com/beilunyang/openhongguo/internal/protocol/sign.sm3Sum
github.com/beilunyang/openhongguo/internal/protocol/sign.xGorgon
github.com/beilunyang/openhongguo/internal/drm/spade.go
```

**含义**：不需要在 App 里重写 6 个签名头。加载 WASM 即得到与 Node 端完全一致的签名行为。

### 2.2 WASM 只依赖四个浏览器标准 API

`$SDK/dist/wasm_exec.js` 的启动检查只有四处硬依赖：

```js
if (!globalThis.crypto)      throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");
if (!globalThis.performance) throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");
if (!globalThis.TextEncoder) throw new Error("globalThis.TextEncoder is not available, polyfill required");
if (!globalThis.TextDecoder) throw new Error("globalThis.TextDecoder is not available, polyfill required");
```

`crypto.getRandomValues`、`performance.now`、`TextEncoder`、`TextDecoder` 在 Android WebView 与 Chrome 中均为标准能力。

`Transport` 契约（`$SDK/index.d.ts`）允许替换传输层：

```ts
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;
export declare function nodeTransport(options?: { timeoutMs?: number }): Transport;
```

**含义**：`nodeTransport` 只是默认实现，不是唯一实现。App 可以传入自己的 `Transport`，用平台原生 HTTP 发请求。

### 2.3 现有 web 端为什么需要服务端

`docs/reverse-engineering.md` 第 5 节记录了三条实测障碍。它们都是**浏览器**的限制，不是协议的限制。

| 障碍 | 实测现象 | 原生 App 是否仍存在 |
| --- | --- | --- |
| `device_register` 无 CORS | `OPTIONS` 返回 404，无 `access-control-allow-*` | **不存在**。CORS 是浏览器强制策略，原生 HTTP 客户端不发起预检、不校验 `ACAO` |
| API 预检被拒 | 带 `x-gorgon`/`x-medusa` 的 `OPTIONS` 返回 403 | **不存在**。同上，无预检这一步 |
| 带 `Origin` 判未授权 | Node 侧加一个 `Origin` 头即 `AUTHENTICATION_REQUIRED` | **需注意**。这是服务端反盗链策略，与浏览器无关。原生客户端只要不发 `Origin` 就不触发 |

第三条要单独说明：它**不是**「原生就没有了」，而是「原生默认不发 `Origin`，所以不触发」。这是行为差异，不是能力差异。

**旁证**：`guoapp` 用 Go 的 `net/http` 直接请求上游，从未涉及 CORS 或预检。它的 `signHongguoRequest()` 只设置 `X-Gorgon`、`X-Khronos`、`X-SS-STUB`、`X-SS-Req-Ticket` 四个头，没有 `Origin`。

### 2.4 但媒体与封面本来就是开放的

`docs/reverse-engineering.md` 5.4 节实测：

```
视频 CDN   → 206  access-control-allow-origin: *
剧集封面   → 200  content-type: image/jpeg  ACAO: *
```

**含义**：即使走 WebView 路线，媒体也能直接跨域拉取。只有 API 层需要 Transport 介入。

---

## 3. 现有 web 端功能清单与依赖归属

### 3.1 服务端 API 一览

`server/src` 下的全部路由（`*.controller.ts`，排除测试）：

| 路由 | 用途 | 能否搬到设备端 |
| --- | --- | --- |
| `GET /api/feed` | 首页推荐流 | ✅ 调 SDK 即可 |
| `GET /api/search` | 搜索 | ✅ 同上 |
| `GET /api/suggest` | 搜索联想 | ✅ 同上 |
| `GET /api/ranking/catalog` | 榜单分区 | ✅ 同上 |
| `GET /api/ranking` | 榜单内容 | ✅ 同上 |
| `GET /api/random` | 随机一部 | ✅ 同上 |
| `GET /api/series/:id` | 剧集详情 | ✅ 同上 |
| `GET /api/series/:id/episodes` | 分集列表 | ✅ 同上 |
| `GET /api/episodes/:id/playback` | 播放信息（含档位） | ✅ 同上 |
| `GET /api/media/:episodeId` | 解密后的明文流，支持 Range | ⚠️ 见 3.2 |
| `GET /api/cover/:token` | HEIC/JPEG 封面代理 | ⚠️ 见 3.3 |
| `GET /api/sprite/:episodeId` | 雪碧图元数据 | ✅ 元数据可在端上算 |
| `GET /api/sprite/:episodeId/:sheet` | 雪碧图图片 | ⚠️ 见 3.3 |
| `GET /api/diagnostics`、`GET /api/health` | 运维用 | ❌ App 不需要 |

### 3.2 `/api/media/:episodeId` 是唯一真正必须搬的能力

这个路由不是转发，是**解密后输出明文**。看它的注释：

```ts
// 解析 + 下载 + 解密 + 落盘全部在写响应头之前完成（见 `MediaCacheService.produce`
// 的约束注释）。任何一步失败都在这里抛出，浏览器拿到的是错误状态码而不是
// 一个开头正常、中途断掉的 200/206。
```

**关键事实**：`GET /api/episodes/:id/playback` 的响应**不含内容密钥**。它只返回：

```ts
{
  episodeId, streamUrl, duration, definition,
  availableDefinitions, codec?, width?, height?
}
```

密钥留在服务端内存，用于解密。**所以现有 web 端无法自行解密，也无法自行下载**——`web/src/features/download/download-media-url.ts` 里 `buildDownloadUrl()` 拼的就是 `/api/media/...`。

要把这个能力搬进 App，需要两样东西：

1. **`spade_a` → 内容密钥**：`shared/src/spade.ts` 已实现，导出 `deriveContentKey(spadeA)`，是纯函数，无运行时依赖。
2. **CENC 原地解密**：`server/src/media/cenc.ts` 已实现，但用了 `node:crypto`：

```ts
import { createDecipheriv } from 'node:crypto';
import { planTracks, type TrackPlan } from '@mlzwl/hongguo-shared';
```

只有这一行是平台相关的。其余 MP4 解析全在 `shared/src/mp4.ts`：`readBoxes`、`readStsz`、`readStsc`、`expandStsc`、`sampleOffsets`、`readTenc`、`readSenc`、`planTracks` 都是纯 `Uint8Array` 操作。

**移植成本**：把 `createDecipheriv('aes-128-ctr', key, iv)` 换成 WebCrypto 的 `crypto.subtle` AES-CTR（或 Kotlin 的 `Cipher.getInstance("AES/CTR/NoPadding")`），然后 `server/src/media/cenc.ts` 就能下沉到 `shared/`。

### 3.3 封面与雪碧图代理：可以不要，但会退化

`server/src/cover/cover.controller.ts` 的注释说明了为什么存在代理：

```ts
// 路径里是**不透明令牌**，不是上游地址。上游是签名 URL，`x-signature` 就在
// 查询串里；把它放进浏览器可见的任何位置都等于把签名交给客户端。
```

**含义**：代理是为了**不让签名 URL 暴露给浏览器**。在 App 里，客户端本来就是「自己人」，签名 URL 直接给播放器/图片库没问题。所以这个代理**不需要**。

但代价是：上游封面是 HEIC，需要端上解码。`docs/reverse-engineering.md` 5.4 节实测封面 `content-type: image/heic`。Android 原生支持 HEIF 解码（API 28+），WebView 内的浏览器也支持。**这不是阻塞项，但需要验证。**

### 3.4 功能清单归属总表

`web/src/features/` 下的模块，逐个判断搬迁性质：

| 模块 | 文件数 | 搬迁性质 |
| --- | --- | --- |
| `web/src/features/player/` | 23 | **重写**。`web/src/features/player/player.tsx` 用原生 `<video>` 元素 + `useRef`；手势、快捷键、控件逻辑可搬，播放与全屏需换平台实现 |
| `web/src/features/download/` | 8 | **重写传输层**。`web/src/features/download/download-queue.ts`、`web/src/features/download/download-state.ts`、`web/src/features/download/download-selection.ts` 纯逻辑可复用；`web/src/features/download/download-media.ts` 用 `URL.createObjectURL` + `<a>`，需换平台下载器 |
| `web/src/features/feed/` | 3 | 可复用（`web/src/features/feed/offline-catalog.ts`、`web/src/features/feed/feed-paging.ts` 纯逻辑） |
| `follow/` | 3 | 可复用（纯逻辑 + `localStorage` 换平台存储） |
| `ranking/` | 2 | 可复用 |
| `search/` | 1 | 可复用 |
| `diagnostics/` | 1 | 可复用（依赖全注入） |
| `theme/` | 2 | 可复用 |
| `history/` | 1 | 可复用 |
| `navigation/` | 1 | 可复用 |
| `series/` | 0 | 无独立文件 |

`web/src/lib/` 下的 `web/src/lib/client-events.ts`、`web/src/lib/diagnostics-report.ts`、`web/src/lib/debounced-suggest.ts`、`web/src/lib/write-queue.ts`、`web/src/lib/random-entry.ts` 均为纯逻辑。

**结论**：`web/src` 与 `shared/src` 共 77 个非测试源文件，其中 40 个（约 52%）不引用 `document.`、`window.`、`localStorage`、`URL.createObjectURL` 或 JSX 元素，是可直接搬的纯逻辑。需要重写的是 `player/`（23 个文件）与 `download/` 的传输部分（8 个文件中依赖 DOM 的那几个）。

---

## 4. 上游四个仓库的做法对比

### 4.1 guoapp：Flutter + Go（最接近目标形态）

- **技术栈**：Flutter（`guoapp/lib/` 下 85 个 Dart 文件，另有 35 个测试相关 Dart 文件）+ Go（122 个 .go 文件，全在 `guoapp/native/core/`，经 FFI 调用）
- **明确目标**（`AGENTS.md`）："站源请求、解析、在线播放及后续下载、合并均在设备端完成；成品不依赖旧短剧库程序、旧项目路径或远程自建服务"

**它怎么解决四个问题：**

| 问题 | guoapp 的做法 | 证据 |
| --- | --- | --- |
| 签名 | 自己实现 `X-Gorgon`（47 行，含 `bits.RotateLeft8`/`Reverse8` 混淆），另加 `X-SS-STUB`、`X-Khronos`、`X-SS-Req-Ticket` | `guoapp/native/core/provider_hongguo_sign.go` |
| 设备档案 | **不做注册**。直接本地随机生成 `device_id` / `iid`，当作查询参数发出去 | `guoapp/native/core/provider_hongguo_sign.go` 的 `newHongguoDeviceID()`，`guoapp/native/core/provider_hongguo_app.go:140` |
| DRM | 实现 `hongguoContentKey()` 还原 `spade_a`（不支持 v2），但**不做 CENC 解密** | `guoapp/native/core/provider_hongguo_playback.go:160-202` |
| 播放 | 把密钥以 `decryption_key=` 塞进 mpv 的 `demuxer-lavf-o`，由 FFmpeg demuxer 解密 | `guoapp/lib/player_screen.dart:1040` |

**可复用点：**
- 「不注册、本地生成 device_id」这条路**已被真实 App 验证可用**。这比走 `device_register` 简单得多。
- `spade_a` 还原的 Go 实现可作交叉验证（与 `shared/src/spade.ts` 对照）。
- 用播放器自带解密能力（mpv/ExoPlayer 的 `decryption_key`）而不用自己解 CENC，是重要思路。

**不适用点：**
- 它不用 `openhongguo` SDK，自己重写了 122 个 Go 文件。我们没必要走这条路——SDK 的 WASM 已经能用。
- `hongguoContentKey()` 明确拒绝 v2（`"红果媒体密钥版本暂不支持"`），比 `shared/src/spade.ts` 弱。
- 播放依赖本地 `127.0.0.1` HTTP 服务器（`guoapp/native/core/app_stream.go`，`net.Listen("tcp4", "127.0.0.1:0")`）来改写 HLS 与注入 referer。这套在 Flutter 里必要，在 WebView 里不必要。

### 4.2 hongguoTV：React Native + **必须有 Node 后端**

- **技术栈**：React Native（`react-native-tvos`），`react-native-video`
- **关键事实**：仓库里有 `server/` 目录，`hongguoTV/server/index.mjs` 起一个监听 8787 的 HTTP 服务。README 明确要求 `npm run bridge -- --lan` 或 Docker 部署，还提供 `ghcr.io/n3urda/hongguotv-bridge` 镜像。

**结论**：这正是「依赖自建后端」的反例。它的 TV 端只是壳，内容全由 Node 服务提供。

**可复用点**：几乎没有。**可作为反面参照**：证明「App + 独立 bridge」是业界常见做法，但那不是你要的形态。

### 4.3 hongguo-player：无源码

仓库只有 `README.md` 与 7 张截图，无任何代码。README 自称 Windows/macOS 桌面客户端，功能包含弹幕、评论、竖屏模式。

**结论**：不可作为技术参考。仅可作功能对标（它的功能集比现有 web 端多弹幕与评论）。

### 4.4 hongguo-drama：Electron + Node 主进程（思路最接近 web 端）

- **技术栈**：Electron + React + Vite，`hongguo-drama/main.js` 为主进程
- **签名与设备**：直接请求 `https://hongguoduanju.com` 的 SSR 页面，用浏览器 UA 与 Referer，从页面内嵌的 `ld+json` 里取 `VideoObject.contentUrl`

**它的关键发现**（`src/native/hongguo.js:246`）：

```js
/**
 * 从官网取单集可直接下载的 MP4 直链
 * 官网页里与当前分集绑定的 VideoObject.contentUrl 是明文 MP4，无 CENC 加密，
 * 因此不需要 spade_a / 解密这一步。
 */
```

**这是一条绕过 DRM 的独立路径**：走官网 SSR 而非 App API，拿到的是明文 MP4。

**同时它也保留了完整 CENC 路径**：`hongguo-drama/src/native/hongguo.js` 里有完整解密链——`deriveKey()`（627 行）还原 `spade_a`、`senc` IV 表解析（883、913 行）、逐样本 `decryptSample()`（689 行，用 AES-128-ECB 手工构造 CTR 计数器）、`encv`/`enca` 改回 `hvc1`/`mp4a`（779–781 行）。

注意它**不解析 `tenc`**：直接按「每样本 8 字节 IV」处理，并在 `prune()`（749 行）里删掉 `senc`/`saio`/`saiz` 等加密元数据。这意味着它只能处理与红果样本同构的文件；换成标准布局的 CENC 文件会出错。

**可复用点：**
- **SSR 明文路径值得实测**。若成立，App 完全不需要 CENC 解密，播放器直接播明文 MP4。
- 它的 `deriveKey()` 与 `shared/src/spade.ts` 是第三份独立实现，可交叉验证。

**不适用点：**
- 依赖 Node 的 `axios`、`Buffer`、Electron 主进程。搬到 Android 需替换网络层。
- 明文路径依赖官网 SSR 结构，随时可能变。

---

## 5. 密钥与设备档案的端上存储风险

### 5.1 设备档案

- 体积：605 字节（`docs/reverse-engineering.md` 5.7 节实测）
- 内容：`ttreq`、`store-region`、`install_id`、`device_id` 等匿名票据
- 风险等级：**低**。这是匿名游客身份，不含用户凭据。泄露的后果是别人可冒用你的配额。

**存储建议**：Android 用 `EncryptedSharedPreferences` 或普通 `SharedPreferences` 均可。Web 端用 `localStorage`（`dsh-hongguo.*` 系列键）已经跑通，说明服务端不校验存储介质。

### 5.2 内容密钥

**这里有一个必须澄清的点**：内容密钥**不是长期凭据**。

- 来源：每次播放时由 `spade_a` 现算
- 生命周期：单次播放
- `docs/reverse-engineering.md` 第 4 节明确："密钥永远不进 URL、不进日志、不进 localStorage。每次播放时从 `spade_a` 现算。"

**风险等级：低。** 不需要持久化，因此没有「密钥落盘被提取」的问题。唯一要求是不要写日志。

### 5.3 真正的风险在别处

| 风险 | 说明 |
| --- | --- |
| 上游接口变更 | 非官方接口，随时可能改。这是最大的不确定性，与架构无关 |
| 明文流落盘 | 若做离线下载，解密后的 MP4 会在设备上留明文。这是产品决策，不是技术风险 |
| 分发合规 | 应用商店对「非官方客户端」有明确限制。侧载可绕开，但用户门槛高 |
| `spade_a` 算法失效 | 上游若升级到 v3 置换，`shared/src/spade.ts` 需跟进 |

**没有发现的安全阻塞项。** 设备档案与内容密钥都不构成「必须在服务端保管」的理由。

---

## 6. 推荐路线

### 6.1 三条候选路线

| 路线 | 做法 | 复用度 | 播放器体验 | 工作量【推导】 |
| --- | --- | --- | --- | --- |
| A. WebView 壳 | Android WebView 加载 `web/dist` 静态资源，注入自定义 `Transport` | **最高**，现有 React 代码几乎全用 | 受限于 WebView（后台播放、画中画较弱） | 小 |
| B. 原生 UI + WASM | Kotlin/Compose 重写 UI，用 WebView 或 WASM 运行时跑 SDK，ExoPlayer 播放 | 中，shared 纯逻辑可搬 | 最好 | 大 |
| C. Flutter | 参照 `guoapp`，Dart UI + Go/FFI | 低，等于另起项目 | 好 | 最大 |

### 6.2 播放源阻塞后的路线取舍（T8 实测后新增）

T8 与播放接口实测（7.1.1、7.1.2）之后，「走明文路径」这个选项已消失。
两条候选路径的真实对比如下。**播放源本身已打通（见 7.1.2），但两条路都依赖同一个前置改造：
把 SDK 的 `video_model/v1` 调用换成 `multi_video_model/v1`，且不发送
`device_platform=android` + `aid=8662` 这个组合。**

| 维度 | 路径一：端上跑完整 CENC 解密 | 路径二：保留一个极薄的服务端 |
| --- | --- | --- |
| 前提 | 必须能拿到 `spade_a` + 密文流 | 同左 |
| 当前可行性 | 取流已打通（7.1.2），但 SDK 仍在调已下线接口，需适配层 | 同左 |
| 工作量 | 大：`cenc.ts` 迁 WebCrypto + MP4 解析 + 整集下载后解密 | 小：server 已实现，App 只需把 `/api/media` 当普通视频源 |
| 首播延迟 | 高：整集下载 + 解密都在设备上完成 | **同样高**：server 也必须先整集下载、解密、落盘，才写响应头 |
| 后续 Range 请求 | 需设备侧自建缓存才能避免重下 | 命中 server 磁盘缓存，直接 206 |
| 内存峰值 | 高：整集密文 + 明文同时在内存（1080p 单集约 2×14.7 MB） | 低：解密发生在 server，设备只需播放缓冲 |
| 稳定性 | 依赖 App 内解密实现正确性 | 依赖自建 server 可用性 |
| 与「不依赖后端」目标 | 符合 | **不符合**，但退化最小 |
| 合规风险 | 与路径二相同（都是解密受保护内容） | 同左 |

**首播延迟这一行需要澄清**：两条路径**都不能边下边播**。
`server/src/media/media-cache.service.ts:143` 的约束注释写明「解析、下载、解密、落盘是一个原子步骤，
必须在 `reply.send()` 之前全部完成」，`media.controller.ts:100` 也确实是
`await this.cache.get()` 之后才写响应头（响应头在第 102 行之后才设置）。所以「server 支持 Range」指的是
**对本地已解密文件**的 Range，不是对上游的流式转发。

**两条路径的真实差异只有三点**：

1. **后续请求**：server 命中磁盘缓存后是本地 206；设备侧要自己实现等价的磁盘缓存，否则每次重下。
2. **内存峰值**：设备侧必须同时持有整集密文与明文；server 侧不需要。
3. **后端依赖**：设备侧为零；server 侧需要一个可运行的服务。

**判断**：T0（适配层）解决后，路径二省掉的是「设备侧解密 + 设备侧缓存」两块工作量，
**但省不掉首播等待**。若「完全不依赖后端」是硬性要求，则路径一必须补上设备侧磁盘缓存，
否则每集都要重新下载整集。

### 6.3 推荐：先做路线 A 验证，再决定是否投入路线 B

**理由：**

1. 路线 A 能最快验证「无后端可行」这个核心假设。三个直连障碍在 WebView 里的表现、HEIC 封面能否解码、解密性能是否够，都能在几天内测出来。
2. 现有 `web/` 代码里 77 个非测试源文件中有 40 个是纯逻辑（不碰 DOM），路线 B 也能全部复用，不会浪费。
3. 路线 C 的 `guoapp` 已经存在，若目标只是「有个能用的 Android App」，可以直接用或 fork 它，不必重写。

**路线 A 的关键改造点：**

1. `web/src/lib/api-client.ts` 的 `request()` 从 `fetch('/api/...')` 改为调用 WASM SDK。
   **注意**：不能只转发字节，`server/src/catalog/catalog.mapper.ts:43` 做了字段改名
   （`episode_count` → `episodeCount`），`cover()`（第 29–35 行）做封面 URL 代理替换，转换层必须一起搬。
2. `/api/media/:id` 改为端上解密：`deriveContentKey(spade_a)` + CENC 解密，`createObjectURL` 给 `<video>`。
   **链路已验证可跑通**（7.1.2），但需先做 T0 适配层拿到 `spade_a`。
   若改走路径二，这一项不需要做。
3. HEVC 能力探测必须用完整 codec 串（见 7.1.3），不能写 `codecs="hvc1"`。
4. `/api/cover/:token` 改为直接用上游签名 URL（App 内无需隐藏）。
5. `localStorage` 在 WebView 里可用，无需改动。

**必须验证的前置条件（已实测完成，见 7.1）**：`docs/reverse-engineering.md` 5.5 节验证的是「浏览器内 WASM + 哑转发器」。注意该转发器把请求转给本地 Node 代理，**不是浏览器直连上游**，所以它只证明 WASM 能在浏览器内加载与运行。

2026-11-13 已在 Android 模拟器上补完另一半证据：WebView 内 `fetch` 直连上游**会被 CORS 拦截**（自动带 `Origin`，上游无 `ACAO` 响应头），而经 Kotlin 侧 OkHttp 发请求可以正常拿到数据（`discover` 返回 8–9 条）。因此路线 A 的 transport 必须桥接到原生，不能复用 WebView 内的 `fetch`。

#### 路线 A 已落地并实测通过（2026-11-14）

实现与验证证据见 [`../android/README.md`](../android/README.md)。模拟器实测结果：

| 目标 | 结果 |
| --- | --- |
| 首页 feed 有真实数据 | 通过。8–12 条/页，真实剧名、集数、封面（`naturalWidth` 400） |
| 搜索返回结果 | 通过。`大明` 返回 10 条；联想 10 条 |
| 进剧集详情 | 通过。真实点击卡片 → `/series/<id>`，标题/简介/集数/分集列表全部渲染 |
| 选集换集 | 通过。选集抽屉显示「共 78 集」「第 1–20 集」，点第 3 集 → URL 换集 → 新集播放 |
| 点播放看到真实画面 | 通过。`readyState:4`、1920x1080、`currentTime` 正常推进、截图为真实视频帧 |
| `./gradlew :app:assembleDebug` | 通过。APK 8,000,223 B |
| 解密后 MP4 的 ffprobe | 通过。1080p：`hevc`/`hvc1` 1920x1080 + `aac`/`mp4a`，146.83 s，`ffmpeg -f null -` exit 0 |

实施中发现的四个新事实（上面 6.3 的改造点里没有写到）：

1. **视频 CDN 对 WebView 的 `fetch` 回 403**，UA 是 Android WebView 时响应体为空；同一地址在 Kotlin OkHttp 里 200。所以视频字节也必须由原生转发（`/api/video`）。封面 CDN 不同，它带 `access-control-allow-origin: *`。
2. **视频字节不能走 base64 桥接**。39 MB 的 1080p 视频会让 WebView 堆 OOM（实测 `Failed to allocate a 40137608 byte allocation`）。必须原生流式落盘、同源 URL 返回。
3. **封面是 HEIC，WebView 不解码**。`coverOf()` 不能直接返回上游地址，必须走原生 `/api/cover` 用 `BitmapFactory` 转 JPEG（API 28+）。
4. **WebCrypto AES-CTR 与 `node:crypto` 逐字节一致**。8663 个样本串行 110 ms、并发 32 时 49 ms（基线 `node:crypto` 16 ms）。另需注意：解密后必须把 sample entry 类型从 `encv`/`enca` 改回 `hvc1`/`mp4a` 并清 `tenc` 保护位，漏了只差 8 字节但 demuxer 会拒绝解码。
5. **端上也要做 `video_model` → `multi_video_model` 改写**。SDK 是 WASM，端上只能在 Transport 回调里改写，逻辑与 `server/src/media/playback-transport.ts` 相同（含「只删 `aid`、保留 `device_platform`」）。
6. **`/api/sprite` 端上不支持**（返回 404）。上游新播放接口的原始响应没有 `big_thumbs`，不是适配层回归；前端对该查询设了 `retry: false`，不影响播放。

---

## 7. 待实测

以下项目无法从现有代码确证，必须实测。不得把推测当作结论。

### 7.1 已实测完成（2026-11-13，Android 模拟器）

实测环境：Android 16 模拟器（`sdk_gphone64_arm64`，API 36，arm64-v8a），WebView `133.0.6943.137`，JDK 25 + Gradle 9.9.1 + AGP 9.5.1，`apps/hongguo/android/`。

| # | 项目 | 实测结果 | 证据 |
| --- | --- | --- | --- |
| 1 | Android WebView 内加载 6.5 MB WASM | **可行**。WASM 下载 540–2051 ms（三次实测），实例化+启动 361–602 ms，SDK 就绪累计 1045–2662 ms | `apps/hongguo/android/app/src/main/assets/probe.html`；logcat 标签 `HgConsole` |
| 2 | WebView 的 `Transport` 直连上游是否触发 `Origin` 拦截 | **会拦，且与桌面浏览器一致**。`fetch` 自动带 `Origin: https://appassets.androidplatform.net`，上游无 `Access-Control-Allow-Origin`，被 CORS 拦截报 `Failed to fetch` | `apps/hongguo/android/app/src/main/assets/origin-test.html`；实测回显请求头含 `Origin`、`Sec-Fetch-Mode: cors`、`Sec-Fetch-Site: cross-site` |
| 9 | 自定义 `Transport` 注入后能否拿到真实数据 | **可行**。`device_register` 返回 200（384 B），`discover` 返回 8–9 条，总耗时 7174–7408 ms，共 3 次请求，设备档案落盘 603–605 B | 同上 `probe.html`；logcat 标签 `HgTransport` / `HgConsole` |
| 3 | 官网 SSR 明文 MP4 路径（T8） | **已失效**。`/player/{sid}/{vid}` 返回 200 但无 `contentUrl`，`protectedPlayback: true`。详见 **7.1.1** | `.tmp/hongguo-t8/play.html`、`t8-conclusion.md` |
| 4 | HEVC（`hvc1`）在 WebView 内能否播放 | **可以**。1080x1920 实测出画面；但 `canPlayType` 须用完整 codec 串。详见 **7.1.3** | `assets/media-probe.html`；`.tmp/hongguo-t8/hevc-repro.md`、`hevc-probe.png` |
| 5 | 上游播放接口能否取到内容密钥 | **阻塞**。匿名设备返回 HTTP 200 + 0 字节 body。详见 **7.1.2** | `.tmp/hongguo-t8/playback-blocked.md` |

**结论 1 推翻了原先的乐观假设**：第 2 项的实测结果说明，WebView 内的 `fetch` **不是**「原生就自由」。WebView 是 Chromium 内核，同源策略与 CORS 检查照常生效。因此「Kotlin 侧发请求 + 消息通道桥接」不是可选优化，而是**路线 A 的必要条件**。

**结论 2**：`docs/reference/wasm-full.html` 之所以能跑通，是因为它的 `transport` 把请求转给了本地 Node 代理（`http://127.0.0.1:8902/proxy`），并非浏览器直连上游。该文件只证明「WASM 能在浏览器内加载并运行」，不证明「浏览器能直连上游」。本次实测补上了后半段证据。

**三次实测明细**（同一 APK，不同缓存状态）：

| 次数 | 状态 | WASM 下载 | 实例化+启动 | `discover` | 条数 | 档案大小 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 热（已运行过） | 540 ms | 602 ms | 7408 ms | 9 | 605 B |
| 2 | 全新安装 | 2051 ms | 502 ms | 7174 ms | 8 | 603 B |
| 3 | `pm clear` 后 | 684 ms | 361 ms | 7339 ms | 9 | 605 B |

下载耗时的 3.8 倍差异来自系统页缓存，不是代码差异。`discover` 条数在 8–9 之间波动，因推荐流本身有随机性。

### 7.1.1 T8：官网 SSR 明文 MP4 路径已失效

| 检查项 | 实测结果 |
| --- | --- |
| `/player/{sid}/{vid}` 是否可达 | 可达，HTTP 200，132,374 B |
| ld+json 的 `VideoObject.contentUrl` | **不存在**。该 `VideoObject` 的实际字段（共 13 个）：`@context`、`@type`、`about`、`description`、`genre`、`image`、`inLanguage`、`isFamilyFriendly`、`name`、`publisher`、`thumbnailUrl`、`uploadDate`、`url` |
| `_ROUTER_DATA` 的播放数据 | `protectedPlayback: true`、`videoList: {}`（空对象，len=0）。`player_(series_id)/(vid)/page` 的全部键：protectedPlayback / req / isSuccess / series_id / vid / seriesSocialInfo / episodeSocialInfo / seriesDetail / videoList / recommendationsFromSearch |
| 页面内 `.mp4` 直链 | 0 个 |

结论：`hongguo-drama` 依赖的 `VideoObject.contentUrl` 明文直链**已不存在**，站点改为 `protectedPlayback`。
因此「走明文路径省掉 CENC 解密」在当前站点上**不成立**。

**前置条件检查（对应 T8 第 3 点）**：四种请求头组合全部返回 200，且全部是 `protectedPlayback: true`，
说明缺 `contentUrl` 不是请求头导致的，而是站点本身不再下发。

| 组合 | UA | Referer | HTTP | 字节 | `protectedPlayback` |
| --- | --- | --- | --- | --- | --- |
| A | curl 默认 | 无 | 200 | 128,769 | `true` |
| B | Chrome 122 / Windows | 无 | 200 | 132,816 | `true` |
| C | curl 默认 | 有 | 200 | 128,834 | `true` |
| D | Chrome 122 / Windows | 有 | 200 | 132,845 | `true` |

四份响应内容互不相同，但**都不含 `contentUrl`**。
带 Chrome UA 的两份比 curl 默认 UA 大约 4 KB，差异来自站点按 UA 下发的资源清单，与播放地址无关。

**注意字节数的可复现性**：上表是一次运行的精确值。重复执行会得到相近但不同的数值
（复验时得到 128,834 / 132,816 / 128,202 / 132,830），因为页面内嵌时间戳与随机 ID。
稳定的判据只有两个：**HTTP 200** 与 **`contentUrl` 计数为 0**。字节数仅作量级参考。

**T8 第 2、4 点无法实测**：没有 `contentUrl` 就没有 MP4 可下载，
因此「MP4 是否明文（`encv`/`senc`/`tenc` box）」与「单集大小 / Range 支持」这两项**无从测量**。
这两项不是「测了没通过」，而是「前提消失导致测不了」，报告中不给出任何推测值。

复现命令：

以下命令在**仓库根**执行，抓下来的文件放在当前目录（或任意临时目录）。

```bash
REPO=$(pwd)                 # 仓库根
SID=<series_id>; VID=<episode_id>

curl -s -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36" \
  -H "Referer: https://hongguoduanju.com/" \
  "https://hongguoduanju.com/player/$SID/$VID" -o play.html
grep -c contentUrl play.html                     # 0
grep -o 'protectedPlayback":[a-z]*' play.html    # protectedPlayback":true

# 结构化确认 VideoObject 的字段清单与 _ROUTER_DATA 的键
python3 "$REPO/.tmp/hongguo-t8/parse-play.py" play.html
# 期望输出：VideoObject 字段数 13、有 contentUrl: False
#           page 键含 protectedPlayback: True、videoList: dict len=0

# 四种请求头组合，验证「不是缺头导致的」
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
URL="https://hongguoduanju.com/player/$SID/$VID"
curl -s -o a.html -w "A %{http_code} %{size_download}\n" "$URL"
curl -s -o b.html -w "B %{http_code} %{size_download}\n" -A "$UA" "$URL"
curl -s -o c.html -w "C %{http_code} %{size_download}\n" -H 'Referer: https://hongguoduanju.com/' "$URL"
curl -s -o d.html -w "D %{http_code} %{size_download}\n" -A "$UA" -H 'Referer: https://hongguoduanju.com/' "$URL"
grep -c contentUrl a.html b.html c.html d.html   # 全为 0
```

### 7.1.2 播放源失效：根因已定位（接口下线 + 身份指纹组合）

> **2026-11-13 23:00 修正**：本节早前的结论「上游对匿名设备封锁」是**错的**。
> 匿名身份完全正常。两个根因：`video_model/v1` 接口已下线；`multi_video_model/v1` 在
> `device_platform=android` 与 `aid=8662` **同时出现**时返回空（这是官方 App 的身份指纹）。
> 改掉任一参数即可拿到数据。完整取证见 `.tmp/hongguo-t8/breakthrough/README.md`。

#### 现象

`resolvePlayback()` 全部失败，错误 `openhongguo: anonymous response was empty`。
请求 `POST https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/`
签名头齐全，上游返回 **HTTP 200 + 0 字节 body**。

#### 根因一：`video_model/v1` 已下线

对任何请求体（`{}`、`garbage`、空串、正确的 `video_id` body）都返回 0 字节。
对比同域下仍在服务的接口：

| 接口 | 空 body 的响应 | 判定 |
| --- | --- | --- |
| `video_model/v1` | HTTP 200，**0 字节** | 已下线 |
| `multi_video_model/v1` | HTTP 200，125 字节，`Code: 110001`「未知异常」 | 活接口 |
| `album_detail/v1` | HTTP 200，192 字节，`code: 0` | 活接口 |

活接口会对错误输入返回结构化错误码；下线接口返回空，**没有任何错误信息**。

#### 根因二：`device_platform=android` + `aid=8662` 的组合触发空响应

请求：`POST https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/<query>`
Body：`{"biz_param":{"need_all_video_definition":true,"video_platform":1024},"mixed_video_id_map":{"1004":["<vid>"]}}`

2×2 矩阵（其余参数固定为 `device_id`）：

| `device_platform` | `aid` | 响应 |
| --- | --- | --- |
| 无 | 无 | 14,352 字节 |
| 无 | `8662` | 14,366 字节 |
| `android` | 无 | 15,543 字节 |
| **`android`** | **`8662`** | **0 字节** |

保持 `device_platform=android` 不变，改 `aid`：

| `aid` | 响应 |
| --- | --- |
| `8662` | **0 字节** |
| `1967` | 15,369 字节 |
| `13` | 14,194 字节 |
| `999` | 14,175 字节 |
| `1` | 14,137 字节 |

保持 `aid=8662` 不变，改 `device_platform`：

| `device_platform` | 响应 |
| --- | --- |
| `android` | **0 字节** |
| `ios` | 15,378 字节 |
| `web` | 14,365 字节 |
| `pc` | 14,365 字节 |
| 空串 | 14,367 字节 |

**这是「官方 App 身份指纹」级别的判定，不是匿名配额。** 只要请求看起来完全像官方
Android App（`device_platform=android` + `aid=8662`），上游就返回空；伪装成 iOS / Web / PC，
或换一个 `aid`，都能拿到数据。

**定位过程的两个坑**（都实际踩过，记下来避免重犯）：

1. **`x-medusa` 绑定 URL**。它是签在完整 URL 上的，改任何一个 query 参数都会让签名失效，
   响应变成 0 字节。所以「改一个参数看响应」必须**重新签一次**，否则测到的是签名失效，
   不是参数本身的效应。用裸 `curl` 重放必然 0 字节，会得出「必须带签名」的错误结论。
2. **两个变量互相掩盖**。只在完整 31 参数 query 上剔除时，去掉 `aid` 但留着
   `device_platform=android` 能恢复；只带 `aid` 不带 `device_platform` 也能恢复。
   正确做法是从最小可用集（仅 `device_id`）开始逐个加入参数，才暴露
   `device_id` + `device_platform=android` + `aid=8662` 这个三元组合。

**签名头里只有 `x-medusa` 是必需的**：逐个剔除 SDK 的 20 个请求头，只有去掉 `x-medusa` 会让响应变 0 字节，
其余（`x-argus`、`x-gorgon`、`x-ladon`、`x-khronos`、`x-ss-stub`、Cookie、UA…）去掉都仍能拿到 14–15 KB。

#### 签名：只有 `x-medusa` 是必需的

逐个剔除 SDK 发出的 20 个请求头，**只有去掉 `x-medusa` 会让响应变 0 字节**。
其余全部去掉仍能拿到 14–15 KB：`x-argus`、`x-gorgon`、`x-ladon`、`x-khronos`、
`x-ss-stub`、`x-helios`、`Cookie`、`User-Agent`、`Accept`、`Content-Type`、`x-ss-dp` 等。

`x-medusa` 签在**完整 URL** 上。改动任何一个 query 参数都必须重新签一次，
否则响应变 0 字节——这与参数本身无关，纯粹是签名失效。
用裸 `curl` 重放必然 0 字节。

对已下线的 `video_model/v1` 做对照：签名有效、签名篡改、完全无签名，
三种情况**响应完全一致（0 字节）**。说明该路径在业务逻辑之前就返回空，与签名无关。

#### 已排除的假设（每项都有受控实验）

| 假设 | 排除依据 |
| --- | --- |
| 设备档案损坏 / 配额耗尽 | 用 11-12 注册、14:52 仍在用的同一档案（`device_id=2662395830102864`）重放，仍 0 字节 |
| 匿名身份被封 | 同一档案的目录接口正常：`device_register` 200/384 B、`tab/v` 1.19 MB、`change/v` 4.17 MB |
| 签名算法过期 | `x-medusa` 是唯一必需的签名头，且能正常签出可用签名；其余签名头剔除不影响结果 |
| 请求体参数不对 | 加 `content_type: 1`、换 guoapp 全套参数、`video_platform` 试 10 个值，均 0 字节（在 `video_model/v1` 上） |
| Host 不对 | 在 `multi_video_model/v1` 上重测：`sinfonlinea` 14,409 B / `sinfonlineb` 14,385 B / `lq` 14,363 B / `hl` 14,381 B，四个 host 全部非空 |
| UA 被识别 | 在 `multi_video_model/v1` 上重测：SDK 原值 14,380 B / `okhttp/4.12.0` 14,381 B / 空 UA 14,410 B，全部非空 |
| IP 被封 | 同一 IP 上，改掉 `device_platform` 或 `aid` 任一参数立刻拿到 14–15 KB |
| 我们的实现有 bug | guoapp 的 Go、hongguo-drama 的 JS、openhongguo 的 WASM，三个独立实现都失败——但它们都调已下线的 `video_model/v1`，失败原因一致 |

#### 完整链路已验证（4/4 集）

取流 → 下载 → 推导密钥 → CENC 解密 → 解码出画面，全链路成功：

| 集 ID | 响应大小 | 档位 | 带 `spade_a` |
| --- | --- | --- | --- |
| 7671977926971116568 | 19,338 B | 360p/480p/540p/720p/1080p | 5/5 |
| 7700877568869665816 | 26,049 B | 同上 | 5/5 |
| 7678678025646394430 | 20,458 B | 同上 | 5/5 |
| 7671977933363235864 | 19,340 B | 同上 | 5/5 |

单集实测（7671977926971116568，1080p）：

1. `video_list` 第 5 项 → `video_meta.definition=1080p`，`1080x1920`
2. `encrypt_info`：`encrypt=true`、`kid=6a785746f8818bde4c4caeee0002ebeb`、
   `encryption_method=cenc-aes-ctr`、`spade_a=obwv9meMLMtmjR30ULoAwFK6HMNWuB7zV4kp9FSJBcVUjByhoQ==`
3. 下载 `main_url` → 7,923,313 字节
4. `deriveContentKey(spade_a)` → `key=d41d4020db578b9d7b2d030cfede8373`，`version=1`
5. `decryptCenc(bytes, key)` → 轨道 `encv→hvc1`（3555 samples）、`enca→mp4a`（5108 samples），`ivSize=8`
6. `ffprobe` → `hevc` / `hvc1` / 1080x1920 / `aac` / `mp4a` / 118.56 秒
7. `ffmpeg -i ... -f null -` → 退出码 0，无解码错误
8. 第 60 秒取帧 → 真实剧集画面（古装人物 + 中文字幕「汉人羌人都住着」）

**这条链路用的正是本仓库已有的实现**：`shared/dist/spade.js` 的 `deriveContentKey`
与 `server/dist/media/cenc.js` 的 `decryptCenc`，未做任何改动。

#### 为什么 14:52 之后失效（时间边界已解释）

可观测的时间边界：`apps/hongguo/server/data/media/7700877568869665816-720p.mp4`
的 mtime 是 **2026-11-13 14:52:56**（最后一次成功的产物），首次测到 0 字节是 **22:36**。

**决定性对比实验**：用 14:52 成功时 server 正在用的**同一台设备档案**
（`apps/hongguo/server/data/hongguo.db` 的 `devices` 表，`device_id=2662395830102864`，
`created_at` 的 epoch ms 是 `1794464772389`），在现在这个时间点分别打两个接口：

| 接口 | 同一设备档案的响应 |
| --- | --- |
| `video_model/v1`（server 一直在用） | HTTP 200，**0 字节** |
| `multi_video_model/v1`（新接口） | HTTP 200，**20,675 字节** |

**设备档案没变、IP 没变、代码没变，只有接口变了。** 这就是时间边界的完整解释：

1. 14:52 之前 `video_model/v1` 还在服务，server 正常取流、下载、解密、落盘。
2. 上游下线该接口后，`openhongguo@0.1.0` 与 `@0.2.0` 两个版本都只调它，
   于是 server 与所有下游实现同时失效。
3. `apps/hongguo/server/dist/main.js` 里 `multi_video_model` 出现 **0 次**，
   说明 server 从未走过新接口——它没有别的路可走。

无法确证的只有「上游具体在哪个时刻下线」。这不影响修复：换成 `multi_video_model/v1`
即可恢复，与时刻无关。

#### 对方案的影响

**播放能力本身没有消失，只是调用方式变了。** 上一版「匿名设备拿不到播放源、换架构不能绕开」
的结论**作废**。

#### 恢复路径已落地（`server/src/media/playback-transport.ts`）

`openhongguo` 是 WASM，改不动。但 `hongguo.service.ts` 已用 `Transport` 装饰器包了 SDK
（`video-model-capture.service.ts` 就是这么做的），所以在这一层做适配。
实现见 `apps/hongguo/server/src/media/playback-transport.ts`，在 `media.module.ts` 里注册。

适配器做三件事：

1. **请求改写**：URL `/novel/player/video_model/v1/` → `/novel/player/multi_video_model/v1/`，
   **只删 `aid`**（见下方「只删 `aid`」）。
2. **请求体改写**：`{"video_id": X}` →
   `{"biz_param":{"need_all_video_definition":true,"video_platform":1024},"mixed_video_id_map":{"1004":[X]}}`。
3. **响应改写**：新接口把 `video_model` 放在 `data[<vid>].video_model`，旧接口在
   `data.video_model`。转换时提升一层。

   **保持字符串形态，不要解析成对象**。旧接口的 `data.video_model` 本来就是字符串
   （`JSON.parse` 前的形态），而 `VideoModelCapture.readVideoModel`
   （`video-model-capture.service.ts:216-220`）明确要求 `typeof raw === 'string'`，
   不是字符串就直接返回 `null`、放弃捕获。解析成对象会让 `spade_a` 与 `big_thumbs`
   的捕获静默失效。已实测：保持字符串时 `capture.take()` 能拿到
   `spadeA=obwv9meMLMtmjR30…`、`videoId`、`durationSeconds`。

##### 只删 `aid`，保留 `device_platform`

这一步我一开始做错了：把 `device_platform` 和 `aid` 一起删。两个都删**也能拿到数据**，
但上游会降级成另一套响应形态。同一个 `video_id`、同一份请求体，两种改法的实测对比：

| 改法 | 响应大小 | `video_list` | 档位 | `spade_a` 位置 | `main_url` |
| --- | --- | --- | --- | --- | --- |
| 只删 `aid`（保留 `device_platform=android`） | 19,209 B | 数组 | **5 档（含 1080p）** | `encrypt_info.spade_a` | 明文 |
| 两个都删 | 14,350 B | 对象 `{video_1:…}` | 4 档（缺 1080p） | 顶层 `spade_a` | base64 编码 |

保留 `device_platform=android` 时上游返回的是**旧接口原样结构**，SDK 和
`VideoModelCapture` 都不用改。删掉它则会掉进降级形态，需要额外处理数组展平、
URL base64 解码、`spade_a` 换位置三件事——我最初就是这么写的，白做了一轮。

`playback-transport.ts` 里保留了一个 `normalizeVideoModel` 兜底，用于上游以后改回
降级形态的情况，正常情况下不会触发。

##### 端到端实测（独立端口 9411 + 独立 `DATA_DIR`）

`PORT=9411 DATA_DIR=/tmp/hg-verify/data node dist/main.js`，与用户默认 9133（未打补丁的旧
`dist`）在同一时刻对照：

| 接口 | 9133（旧代码） | 9411（打了适配层） |
| --- | --- | --- |
| `GET /api/episodes/7671977926971116568/playback` | **500** | **200** |
| `availableDefinitions` | — | `360p/480p/540p/720p/1080p`（5 档） |
| `GET /api/media/7671977926971116568?definition=1080p` | — | **200，7,923,313 B** |

下载后的文件：`ffprobe` 报 `hevc` / `hvc1` / 1080x1920 / `aac` / `mp4a` / 118.56s；
`ffmpeg -i … -f null -` 退出码 0；第 60 秒取帧为真实剧集画面（古装人物 + 中文字幕）。
7,923,313 B 与 1080x1920 这两个数字和手工全链路验证完全一致。

`VideoModelCapture` 仍能取到 `spade_a`（`obwv9meMLMtmjR30…`）、`videoId`、`durationSeconds`。
`readSpadeA` 补了一条 `video_list[].spade_a` 的顶层路径，兼容降级形态。

**sprite 接口在上游没有 `big_thumbs` 时返回 404**（`GET /api/sprite/:episodeId`）。
这不是适配层引入的回归：同一时刻 9133 上是 500。`big_thumbs` 在新接口的原始响应里
就不存在（试了 `need_big_thumbs`、`need_thumb`、`need_sprite`、`video_platform` 多组取值，
全部没有该字段）。前端把它当可选装饰（`player-route.tsx:122` 起 `retry: false`），
失败不阻塞播放。写入待实测。

两条落地路线：

1. **给上游 `openhongguo` 提 issue / PR**（治本）。把本节的三处改写作为修复建议。
2. **本仓库 server 侧适配层**（已落地，见 `playback-transport.ts`）。


### 7.1.3 HEVC 播放：WebView 可以

**样本来源说明（对应必测点 1）**：目标要求的优先顺序是「T8 明文直链 → server `/api/media` 产物 → 本地样本」。
前两条本次都不可用：T8 已失效（7.1.1），server 的 `/api/media` 依赖 `resolvePlayback`，
而该接口对匿名设备返回空 body（7.1.2），因此拿不到任何上游密文或明文。
所以本次用**本地合成样本**，参数严格对齐 `shared/src/mp4.ts:365` 记录的上游格式（HEVC `hvc1` + AAC `mp4a`）：

```bash
ffmpeg -f lavfi -i testsrc2=size=1080x1920:rate=30:duration=6 \
  -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -b:v 1500k \
  -c:a aac -b:a 96k -movflags +faststart hevc-sample.mp4
```

样本经 ffprobe 复核，格式与上游一致：

```
codec_name=hevc  codec_tag_string=hvc1  1080x1920      （视频轨）
codec_name=aac   codec_tag_string=mp4a                  （音频轨）
```

**先排除「样本本身有问题」**（这是目标要求的判定前提）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 完整解码 | `ffmpeg -v error -i hevc-sample.mp4 -f null -` | 无错误输出，退出码 0 |
| 帧数与时长 | `ffprobe -count_frames ... -show_entries stream=nb_read_frames,r_frame_rate,duration` | 30 fps × 6 s = **180 帧**，无丢帧 |
| box 结构 | 见下方 | `hvc1` 直接挂在 `stsd` 下，**无 `sinf`/`encv` 包裹** |
| 加密 box | 遍历全部 box | `encv`/`senc`/`tenc`/`saiz`/`saio`/`pssh` **全部不存在** |

box 结构（节选）：

```
moov
  trak (视频) → stbl → stsd (2593 B) → hvc1 (2577 B) → hvcC / fiel / pasp / btrt
  trak (音频) → stbl → stsd (126 B)  → mp4a (110 B)  → esds / btrt
mdat (1187268 B)
```

对照：标准 CENC 加密文件的 `stsd` 下会是 `encv`（内含 `sinf` → `frma`/`schm`/`schi` → `tenc`），
`stbl` 下还有 `senc`/`saiz`/`saio`。本样本一个都没有，是**明文文件**。
因此「播放成功」不是因为样本被宽松处理，而是它确实与上游格式一致（`hvc1` + `mp4a`）且完全明文。
完整取证见 `.tmp/hongguo-t8/hevc-box-check.md`。

`canPlayType` 的返回值如下（两次独立运行结果完全一致）：

| 查询串 | 返回值 |
| --- | --- |
| `video/mp4; codecs="hvc1"` | `""`（空，**误判为不支持**） |
| `video/mp4; codecs="hev1"` | `""`（空） |
| `video/mp4; codecs="hvc1.1.6.L120.90"` | `"probably"` |
| `video/mp4; codecs="avc1.42E01E"` | `"probably"` |
| `video/mp4` | `"maybe"` |

实际播放日志（第二次独立运行，时间戳为页面内相对时间）：

```
[1532ms] 开始加载 hevc-sample.mp4
[3111ms] loadedmetadata: 1080x1920, duration=6.00s
[3947ms] loadeddata
[3948ms] canplay
[3948ms] playing —— 真的开始播了
[4467ms] 播放进度 0.38s
===== HEVC RESULT: 可播放 1080x1920 =====
```

截图 `.tmp/hongguo-t8/hevc-probe.png` 可见彩条测试图真实渲染，不是只有元数据。

**解码器类型（对应第 3 点）**：`dumpsys media.player` 显示本机只有

- `c2.goldfish.hevc.decoder`（模拟器软解）
- `c2.android.hevc.decoder`（Google 参考软解）

没有 `c2.qti.*` / `c2.exynos.*` / `OMX.MTK.*` 这类 SoC 硬解。因此**本次实测走的是软件解码路径**。

**可操作结论**：用 `canPlayType` 探测 HEVC 时必须写完整 codec 串（`hvc1.1.6.L120.90` 形式）。
只写 `hvc1` 会得到空字符串，导致误判为「不支持 HEVC」而提前报错。
`web/src/features/player/playback-error.ts:19` 的兜底文案如果依赖 `canPlayType` 判断，
在 Android WebView 上会误触发，需按完整串重写判断。

**局限（对应第 4 点，必须明确）**：

**本次结论不能外推到真机。** 具体有四点：

1. 本次是**模拟器**（`sdk_gphone64_arm64`，API 36）。真机能否硬解 HEVC 取决于 SoC，
   软解性能也不代表真机；本机解码器全是软件实现（见上）。
2. 本次样本是 **6 秒 1.1 MB** 的合成视频，不是上游真实 1080p 长片（实测无法取得，见 7.1.2）。
   长片的解码吞吐、发热、功耗**均未验证**。
3. 未测 MediaError 分支：本次没有失败样本（样本已验证完整可解码），所以
   `MEDIA_ERR_DECODE` / `MEDIA_ERR_SRC_NOT_SUPPORTED` 的实际取值**未取证**。
   探针页已实现该分支（`media-probe.html` 监听 `error` 并打印 code 与名称），
   但本次未触发。真机上若遇到不支持的 profile（如 Main 10 / 4:4:4），行为未知。
4. 因此结论只能表述为「**WebView 133 内核具备 HEVC 解码能力且能出画面**」，
   **不能**表述为「真机上播放上游视频流畅」，也**不能**表述为「真机一定支持上游的 HEVC profile」。

复现命令：

```bash
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"

# 1) 生成样本（对齐上游 HEVC hvc1 + AAC mp4a）
ffmpeg -f lavfi -i testsrc2=size=1080x1920:rate=30:duration=6 \
  -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -b:v 1500k \
  -c:a aac -b:a 96k -movflags +faststart hevc-sample.mp4

# 2) 复核样本格式
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,codec_tag_string,width,height \
  -of default=nw=1 hevc-sample.mp4

# 3) 确认本机只有软件解码器
adb shell "dumpsys media.player | grep -A2 \"Media type 'video/hevc'\""

# 4) 装 APK 并启动探针页
cd apps/hongguo/android && ./gradlew :app:installDebug
adb shell am force-stop com.mlzwl.hongguo.shell
adb logcat -c
adb shell am start -n com.mlzwl.hongguo.shell/.MainActivity --es target media-probe
sleep 8
adb logcat -d | grep HgConsole          # 看 canPlayType 返回值与 HEVC RESULT 行
adb exec-out screencap -p > /tmp/hevc-probe.png
```

### 7.2 仍未实测

已从本表移除的两项：第 3 项（官网 SSR 明文路径）已在 7.1.1 实测为**失效**；
第 6 项（后台播放/锁屏/画中画）经用户确认**不在需求范围内**，不再验证。

| # | 项目 | 为什么必须实测 | 建议验证方式 |
| --- | --- | --- | --- |
| 4 | Android 端 CENC 解密性能 | 桌面 Chrome 实测 1080p 14,764,649 B 中位 62 ms（区间 58–306 ms，冷启动 261–306 ms），见 `docs/reverse-engineering.md` 第 4 节表。移动端 CPU 更慢，可能 200–500 ms【推导】 | 用 WebCrypto 版 `server/src/media/cenc.ts` 在真机跑同一份样本 |
| 5 | HEIC 封面在 WebView 内能否解码 | 桌面 Chrome 支持，Android WebView 未测 | 加载一张上游 HEIC 封面 |
| 7 | 上游是否校验 `Origin` 之外的其他指纹（如 UA、TLS 指纹） | 部分已证：本次实测用 OkHttp 直连，上游返回 200，说明不校验 `Origin` 与浏览器特有头。但 OkHttp 的 UA 是自行设置的，TLS 栈为 OkHttp 默认，未与 Go 默认栈对比 | 用不同 UA 与 TLS 栈对比响应 |
| 8 | 分发方式与合规边界 | 非技术问题，但决定产品是否成立 | 产品决策，不在本调研范围 |
| 10 | 真机上的 WASM 加载与 `discover` 耗时 | 模拟器为 arm64 虚拟化，性能不等同真机；本次 `discover` 7174–7408 ms 含 3 次真实上游请求，其中 `cell/change` 响应体 2.7 MB，网络占主要成本 | 同 `probe.html` 在真机复跑 |
| 11 | WebView 内 `web/dist` 正式页面的渲染与 `/api/*` 全 404 时的降级表现 | 本次只验证了探针页，未验证正式页面 | 用 `--es target` 不传参启动，观察错误态 |

---

## 8. 复现本文结论的命令

以下命令均在仓库根执行。先设一个变量指向 SDK 安装目录：

```bash
SDK=node_modules/.pnpm/openhongguo@0.1.0/node_modules/openhongguo

# 确认 SDK 的签名与 DRM 在 WASM 内
strings "$SDK/dist/openhongguo.wasm" | grep -iE "gorgon|medusa|sm3|spade" | sort -u

# 确认 WASM 依赖四个标准 API（crypto / performance / TextEncoder / TextDecoder）
grep -n "polyfill required" "$SDK/dist/wasm_exec.js"

# 确认 Transport 可替换
grep -n "Transport" "$SDK/index.d.ts"

# 确认 cenc.ts 只有一处平台依赖
grep -n "node:" apps/hongguo/server/src/media/cenc.ts

# 确认 MP4 解析全在 shared
grep -n "^export function" apps/hongguo/shared/src/mp4.ts

# 确认 guoapp 不注册设备、本地生成 device_id
grep -n "newHongguoDeviceID" .tmp/hongguo-repo-review/guoapp/native/core/*.go

# 确认 hongguoTV 必须有 Node 后端
sed -n '1,20p' .tmp/hongguo-repo-review/hongguoTV/server/index.mjs

# 确认 hongguo-drama 的 SSR 明文路径（这是 T8 的依据，现已失效）
sed -n '244,250p' .tmp/hongguo-repo-review/hongguo-drama/src/native/hongguo.js
```

T8（官网 SSR 明文 MP4）与 HEVC 播放的完整复现命令分别写在 7.1.1 与 7.1.3 的末尾。
两者的原始取证输出在 `.tmp/hongguo-t8/`（不入仓），索引见该目录的 `README.md`。
其中 `parse-play.py` 是解析 T8 页面的可复现脚本，`parse-play.out` 是它的输出。

7.1.2 的根因验证：2×2 矩阵。**必须用 SDK 签出的完整头**，因为 `x-medusa` 绑定 URL，
换 query 后签名失效，裸 `curl` 只会得到 0 字节，会得出错误结论（本节早前就是这么误判的）。

最省事的复现方式是借 `openhongguo` 的 Transport 捕获一份带签名头的请求，再用它重放：

```js
// repro.mjs —— 在装了 openhongguo 的目录下运行
import { createClient } from 'openhongguo';
const VID = '7671977926971116568';
let tmpl = null;
const transport = async (req) => {
  if (req.url.includes('video_model') && !tmpl) tmpl = { url: req.url, headers: req.headers };
  const res = await fetch(req.url, { method: req.method, headers: req.headers,
    body: req.body.length ? req.body : undefined });
  const buf = new Uint8Array(await res.arrayBuffer());
  const headers = Object.fromEntries(res.headers);
  delete headers['content-encoding']; delete headers['content-length'];
  const cookies = {};
  for (const c of (res.headers.getSetCookie?.() ?? [])) {
    const [p] = c.split(';'); const i = p.indexOf('=');
    if (i > 0) cookies[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return { status: res.status, headers, cookies, body: buf };
};
const c = await createClient({ transport, profile: '/tmp/repro.json' });
try { await c.discover(); } catch {}
try { await c.resolvePlayback(VID); } catch {}

const devid = new URL(tmpl.url).searchParams.get('device_id');
const API = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/';
const BODY = JSON.stringify({
  biz_param: { need_all_video_definition: true, video_platform: 1024 },
  mixed_video_id_map: { '1004': [VID] },
});
for (const [dp, aid] of [[null, null], [null, '8662'], ['android', null],
                         ['android', '8662'], ['ios', '8662'], ['android', '1967']]) {
  const p = [['device_id', devid]];
  if (dp) p.push(['device_platform', dp]);
  if (aid) p.push(['aid', aid]);
  const res = await fetch(`${API}?${new URLSearchParams(p)}`,
    { method: 'POST', headers: tmpl.headers, body: BODY });
  console.log(`${String((await res.text()).length).padStart(6)}B  dp=${dp ?? '(无)'} aid=${aid ?? '(无)'}`);
}
```

实测输出（设备号每次运行不同，字节数会小幅浮动）：

```
 14382B  dp=(无)      aid=(无)
 14414B  dp=(无)      aid=8662
 15419B  dp=android  aid=(无)
     0B  dp=android  aid=8662      ← 唯一空响应
 15419B  dp=ios      aid=8662
 15415B  dp=android  aid=1967
```

时间边界的决定性对比（用 server 14:52 时正在用的同一台设备档案）：

```bash
# 从 server 的 SQLite 取出当时在用的 device_id
DEV=$(sqlite3 apps/hongguo/server/data/hongguo.db \
  "select json_extract(profile,'\$.device_id_str') from devices limit 1;")

# 旧接口 → 0 字节
curl -s -o /dev/null -w "video_model:        %{size_download}B\n" -m 20 \
  -X POST "https://api5-normal-sinfonlinea.fqnovel.com/novel/player/video_model/v1/?device_id=$DEV" \
  -H "Content-Type: application/json" -d '{"video_id":"7700877568869665816"}'

# 新接口 → 约 20 KB
curl -s -o /dev/null -w "multi_video_model:  %{size_download}B\n" -m 20 \
  -X POST "https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/?device_id=$DEV" \
  -H "Content-Type: application/json" \
  -d '{"biz_param":{"need_all_video_definition":true,"video_platform":1024},"mixed_video_id_map":{"1004":["7700877568869665816"]}}'
```

注意：新接口这条命令用裸 `curl` 是可行的（`x-medusa` 缺失时上游仍返回数据，
见「签名：只有 `x-medusa` 是必需的」）。但**测参数差异时必须带 SDK 签出的完整头**，
因为签名绑定 URL。

另注意：上面这条命令只带 `device_id`，会得到降级形态（4 档、`video_list` 是对象）。
要拿旧接口原样结构（5 档含 1080p、`video_list` 数组），需要**保留
`device_platform=android`、只删 `aid`**——但那样必须带 SDK 签出的完整头，裸 `curl`
会因签名失效得到 0 字节。

已下线接口的验证（对任何 body 都是 0 字节）：

```bash
curl -s -o /dev/null -w "video_model: %{http_code} %{size_download}B\n" -m 20 \
  -X POST "https://api5-normal-sinfonlineb.fqnovel.com/novel/player/video_model/v1/" \
  -H "Content-Type: application/json" -d '{}'
# 预期：video_model: 200 0B
```

全链路（下载 + 推导密钥 + CENC 解密）的复现步骤与实测数字见
`.tmp/hongguo-t8/breakthrough/README.md`。该目录另有 `spade.json`
记录了单集的 `spade_a` / `kid` / `encryption_method`。

---

## 9. 相关文档

- `docs/reverse-engineering.md` 第 4 节：spade_a 与 CENC 的完整算法
- `docs/reverse-engineering.md` 第 5 节：三个直连障碍的实测记录
- `docs/tech-stack.md`：现有 monorepo 结构
- `docs/implementation-notes.md`：已完成与未完成项
- `android/README.md`：本报告 7.1 与 10.1 所述 Android 子包的构建与运行方式
- `android/app/src/main/assets/probe.html`：WASM + Transport 探针（对应 7.1 第 1、2、9 项）
- `android/app/src/main/assets/media-probe.html`：HEVC 播放探针（对应 7.1.3）
- `.tmp/hongguo-t8/breakthrough/README.md`：7.1.2 的完整取证与受控实验（不入仓）
- `.tmp/hongguo-t8/guoapp-cross-check.md`：guoapp 三路径失败的交叉验证（不入仓）

---

## 10. 后续 TODO

本节记录从本调研拆出的具体任务。状态以实际验证为准，不以「已写代码」为准。

### 10.1 已完成（2026-11-13）

| # | 任务 | 状态 | 证据 |
| --- | --- | --- | --- |
| T1 | 装 Android SDK（cmdline-tools 21.0 + platform-tools 37.0.1 + platforms/android-36 + build-tools 36.0.0 + emulator 37.2.13 + system-images android-36 google_apis arm64-v8a） | 完成 | `sdkmanager --list_installed`；共 6.0 GB |
| T2 | 建 `apps/hongguo/android/` Kotlin 子包（Gradle 9.9.1 + AGP 9.5.1 + JDK 25 + compileSdk 36 + jvmTarget 17） | 完成 | `./gradlew --version`：Gradle 9.9.1、内置 Kotlin 2.4.21、Launcher JVM 25 |
| T3 | `pnpm-workspace.yaml` 排除 `!apps/hongguo/android` | 完成 | `pnpm list -r --filter './apps/hongguo/*'` 仍列出 shared/server/web 三个包 |
| T4 | WebViewAssetLoader 托管 `web/dist` 到 `https://appassets.androidplatform.net/`，不改 vite base | 完成 | 正式页面渲染出标题与样式；logcat `HgShell: page finished` |
| T5 | Kotlin `HttpTransport` + WebMessageListener 桥接，JS 侧注入 `newClient({ transport, profile })` | 完成 | `discover` 返回 8–9 条；`device_register` 200 |
| T6 | §7 第 1 项：WebView 加载 6.5 MB WASM | 完成（**可行**） | 下载 540–2051 ms，实例化+启动 361–602 ms，SDK 就绪 1045–2662 ms |
| T7 | §7 第 2 项：WebView `fetch` 是否带 `Origin` | 完成（**会拦**） | `origin-test.html` 回显 `Origin: https://appassets.androidplatform.net`，上游无 `ACAO`，报 `Failed to fetch` |
| T8 | §7 第 3 项：官网 SSR 明文 MP4 路径 | 完成（**已失效**） | `/player/{sid}/{vid}` 返回 200，但 ld+json 的 `VideoObject` 无 `contentUrl`；`_ROUTER_DATA` 为 `protectedPlayback: true`、`videoList: {}` |
| T16 | HEVC（`hvc1`）在 WebView 内能否播放 | 完成（**可以**） | 两次独立运行：1080x1920 `loadedmetadata` → `playing` → 进度 0.38–0.50s；`canPlayType('...codecs="hvc1"')` 返回空，须用完整 codec 串；本机仅软解 |
| T17 | 定位播放源失效根因 | 完成（**接口下线 + 身份指纹组合**） | `video_model/v1` 对任何 body 返回 0 字节（已下线）；`multi_video_model/v1` 仅在 `device_platform=android` 且 `aid=8662` 时返回 0 字节，改任一参数即返回 14–26 KB、`code: 0`。见 7.1.2 |
| T18 | 验证「取流→下载→推导密钥→CENC 解密→出画面」全链路 | 完成（**4/4 集成功**） | 1080p 单集 7,923,313 B → `deriveContentKey` → `decryptCenc` → `hevc`/`hvc1`/1080x1920/118.56s，第 60 秒帧为真实画面 |
| T19 | 验证 SDK 适配器（Transport 层改写请求/响应） | 完成（**可行**） | `resolvePlayback()` 原生调用返回 4 档 + `contentKey=d41d4020db578b9d7b2d030cfede8373`，与手工 `deriveContentKey` 结果一致 |

### 10.2 待办

| # | 任务 | 依赖 | 备注 |
| --- | --- | --- | --- |
| T0 | 把适配器落进 `apps/hongguo/server/src/media/playback-transport.ts` | **完成** | `media.module.ts` 注册装饰器。9411 实测：playback 200 / 5 档 / 1080p 下载 7,923,313 B 可解码 |
| T0c | 查明 sprite（`big_thumbs`）缺失 | T0 | 新接口原始响应里没有 `big_thumbs`，试 6 组 `biz_param` 均无。前端 `retry: false` 不阻塞播放 |
| T0d | 给上游 `openhongguo` 提 issue / PR | 无 | 治本。把 `playback-transport.ts` 的三处改写作为修复建议提交 |
| T0b | 把根因与修复建议提给上游 `openhongguo` | 无 | 治本。与 T0 不冲突，可并行 |
| T9 | §7 第 4 项：Android 端 CENC 解密性能 | **T0** | 桌面中位 62 ms，移动端待测。T0 完成后即可用真实密文样本测 |
| T10 | §7 第 5 项：HEIC 封面在 WebView 内解码 | T4 | |
| T12 | 把 `server/src/media/cenc.ts` 的 `node:crypto` 换成 WebCrypto，下沉到 `shared/` | T9 | 仅一处平台依赖。若最终采用 6.2 的「路径二（极薄服务端）」，此项可不做 |
| T13 | 写 `/api/*` → SDK 适配层，让现有 web 页面真正拿到数据 | T5 | 目前正式页面 `api/feed` 报 404 |
| T14 | 真机复跑 T6/T9（模拟器性能不等同真机） | 真机 | |
| T15 | 按 T0 / T9 / T13 结果决定是否投原生（路线 B） | T0 | T11（后台播放）经用户确认已出需求范围，不再验证 |

### 10.3 已知遗留问题

| 项 | 现象 | 影响 |
| --- | --- | --- |
| **SDK 仍调已下线接口（P0）** | `openhongguo@0.1.0` 与 `@0.2.0` 都只调 `video_model/v1`，该接口返回 HTTP 200 + 0 字节 | 现有自建 server 因此 `/api/episodes/:id/playback` 500。绕过方式已确认（T0）。**注意**：不是设备身份问题，也不是 IP/UA/签名问题，见 7.1.2 的排除表 |
| 上游下线时刻未确证 | 可观测边界：14:52:56 最后一次成功产物，22:36 首次测到 0 字节 | 不影响修复，只影响「为什么今天下午还能用」的叙事。写入待实测 |
| `apps/hongguo/AGENTS.md:16` 核心契约冲突 | 原文要求「浏览器不接触上游」，签名只在服务端。Android App 必须把签名下移到设备端 | 需明确契约边界：该约束针对 `web/`；Android 是独立客户端，不引用 `web/` 的签名路径 |
| 正式页面无数据 | `api/feed` 等全部 404，页面显示「加载失败：HTTP 404」 | 预期行为，需 T13 解决 |
| `canPlayType` 探测陷阱 | `codecs="hvc1"` 返回空字符串（误判不支持），须用 `hvc1.1.6.L120.90` 形式 | 写能力探测时不得只用 `hvc1` |
| 模拟器性能不代表真机 | `discover` 7174–7408 ms 含 3 次真实上游请求（其中 `cell/change` 响应体 2.7 MB）；HEVC 仅软件解码 | 需 T14 |
