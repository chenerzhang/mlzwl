# hongguo Android 壳（自包含客户端）

不依赖自建后端的 Android 客户端。可行性结论与证据见
[`../docs/adr-app-feasibility.md`](../docs/adr-app-feasibility.md)。

**当前状态：路线 A 已跑通**。`web/dist` 正式页面在 WebView 内可以直接工作，
不连任何自建 server：首页 feed 有真实数据与封面、搜索返回结果、能进详情、
能选集换集、点播放能在 `<video>` 里看到真实画面。

## 它是怎么工作的

页面以为自己在跟自建 server 说话，实际上全部在设备上完成：

```
web/dist 页面
   │  fetch('/api/*')
   ▼
assets/hg-adapter.js        注入到 <head> 最前，拦截 window.fetch
   │
   ├─ WASM SDK（openhongguo.wasm）  → 拿目录、搜索、集数、播放信息
   │      │  Transport 回调
   │      ▼
   │  WebMessageListener(hgBridge) → Kotlin OkHttp → 上游
   │
   ├─ 移植的 mapper（catalog.mapper / ranking-rows / random-pick）
   ├─ /api/cover → CoverHandler.kt    HEIC → JPEG（BitmapFactory）
   ├─ /api/video → VideoProxyHandler.kt 视频字节（流式落盘）
   └─ assets/hg-cenc.js + hg-mp4.js  WebCrypto AES-CTR 解 CENC
```

关键点：

- **注入必须在页面 bundle 之前**。`api-client.ts` 在模块顶层取 `fetch`，
  所以 `InjectingAssetHandler.kt` 把 `<script>` 插在 `<head>` 之后第一行，
  且用普通脚本（非 module）同步执行。
- **播放不能直接把 CDN 地址交给 `<video>`**。上游视频是 CENC 加密的
  （`protected:true` + `cenc-aes-ctr`），浏览器要播必须走 EME + license，
  而上游不提供 license。所以端上先下载、再解密、最后生成 blob URL。
- **`<video src>` 必须由 JS 侧接管**。页面把 `playback.streamUrl`
  （`/api/media/:id?definition=...`）直接赋给 `<video>`，这个请求不经
  `window.fetch`，也不经任何适配层路由，`shouldInterceptRequest` 也接不住
  （返回的会是 CENC 加密字节，浏览器解不了）。所以适配层拦
  `HTMLMediaElement.prototype.src` 的 setter 与 `setAttribute('src')`，
  解密后换成 blob URL。
- **视频下载必须流式落盘**。39 MB 的 1080p 视频读进 `ByteArray` 会撞爆
  WebView 进程的 Java 堆（实测 `Failed to allocate a 39101711 byte allocation`）。

## 这个工程验证了什么

| 项 | 结果 |
| --- | --- |
| WebView 内加载 6.5 MB WASM | 可行。下载 540 ms，实例化+启动 602 ms |
| WebView 内 `fetch` 直连上游 API | **被 CORS 拦截**。自动带 `Origin`，上游无 `ACAO` 响应头 |
| WebView 内 `fetch` 直连视频 CDN | **403**。UA 是 Android WebView，响应体为空 |
| Kotlin 侧 OkHttp 发签名请求 | 可行。`device_register` 200，`discover` 返回 9 条 |
| `WebViewAssetLoader` 托管 `web/dist` | 可行。绝对路径 `/assets/*` 无需改 vite base |
| WebCrypto AES-CTR 解 CENC | 可行。与 server 的 `node:crypto` **逐字节一致**，8663 样本 110 ms（并发 32 时 49 ms） |
| HEVC 在 WebView 内播放 | 可行。`hvc1.1.6.L120.90` → `probably` |
| 上游封面是 HEIC | WebView 不解码，必须原生转 JPEG（`BitmapFactory`，API 28+） |

## 环境要求

- JDK 17 或更高（实测 JDK 25）
- Android SDK：`platforms/android-36`、`build-tools/36.0.0`、`platform-tools`、`emulator`
- 环境变量 `ANDROID_HOME`（或本目录 `local.properties` 里写 `sdk.dir=`）

版本：Gradle 9.9.1、AGP 9.5.1。AGP 9 已内置 Kotlin 支持，**不要再加 `org.jetbrains.kotlin.android` 插件**，它与新 DSL 不兼容。

## 构建

三个前置件都不在仓库里，按顺序准备：

```bash
# 1) WASM 运行时
./sync-wasm.sh

# 2) 前端产物（本工程把 ../web/dist 作为 assets 目录）
cd ../.. && pnpm hongguo:build

# 3) MP4 解析器（从 shared/src/mp4.ts 打一份自包含 bundle）
cd apps/hongguo && npx esbuild shared/src/mp4.ts --bundle --format=iife \
  --global-name=HgMp4 --target=es2020 \
  --outfile=android/app/src/main/assets/hg-mp4.js
```

最后编译：

```bash
./gradlew :app:assembleDebug
```

## 运行

模拟器：

```bash
emulator -avd <你的 AVD> &
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**正式页面（自包含模式）**：

```bash
adb shell am start -n com.mlzwl.hongguo.shell/.MainActivity --es target index
```

注意：debug 构建的默认 `SHELL_START_URL` 是 Vite dev server（`http://10.0.2.2:5173/`），
它不经过适配层。**要看自包含效果必须传 `--es target index`**，那条路径走
`https://appassets.androidplatform.net/index.html`。

其它探针页：

```bash
# WASM 探针：加载 WASM、注入 Transport、调 discover
adb shell am start -n com.mlzwl.hongguo.shell/.MainActivity --es target probe

# Origin 测试：验证 WebView fetch 是否带 Origin 并被 CORS 拦
adb shell am start -n com.mlzwl.hongguo.shell/.MainActivity --es target origin-test

# HEVC 播放探针：用 <video> 加载 assets/hevc-sample.mp4
adb shell am start -n com.mlzwl.hongguo.shell/.MainActivity --es target media-probe
```

`media-probe` 需要先放样本，样本本身不入仓：

```bash
ffmpeg -f lavfi -i testsrc2=size=1080x1920:rate=30:duration=6 \
  -f lavfi -i sine=frequency=440:duration=6 \
  -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -b:v 1500k \
  -c:a aac -b:a 96k -movflags +faststart \
  app/src/main/assets/hevc-sample.mp4
```

看日志：

```bash
adb logcat -s HgShell:* HgConsole:* HgTransport:* HgCover:* HgVideo:*
```

用 CDP 在页面上下文里取证（验证 `/api/*` 实际响应体）：

```bash
PID=$(adb shell pidof com.mlzwl.hongguo.shell | tr -d '\r')
adb forward tcp:9333 localabstract:webview_devtools_remote_$PID
curl -s http://127.0.0.1:9333/json/list
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `MainActivity.kt` | WebView 装配、`WebViewAssetLoader`、`WebMessageListener` 桥接 |
| `InjectingAssetHandler.kt` | 托管 assets，并把适配层脚本插到 `index.html` 的 `<head>` 最前 |
| `HttpTransport.kt` | OkHttp 发请求；`execute` 走 Base64（SDK 用），`downloadToFile` 流式落盘（视频用） |
| `CoverHandler.kt` | `/api/cover`：HEIC → JPEG，LRU 缓存 |
| `VideoProxyHandler.kt` | `/api/video`：视频字节流式落盘后交给 `FileInputStream`；引用计数保护正在播放的那份 |
| `DownloadHandler.kt` | 下载落盘：三段式桥接命令 + MediaStore 写入公共下载目录 |
| `SpriteHandler.kt` | `/api/sprite-sheet`：HEIC 雪碧图 → JPEG，**不降采样** |
| `assets/hg-adapter.js` | `/api/*` 适配层：15 个端点、mapper、视频接口改写、CENC 触发、`<a download>` 接管 |
| `assets/hg-cenc.js` | WebCrypto AES-CTR 解 CENC |
| `assets/hg-mp4.js` | 从 `shared/src/mp4.ts` 打包的 MP4 box 解析器 |
| `assets/probe.html` | WASM 探针 |
| `assets/origin-test.html` | WebView `fetch` 的 `Origin` 与 CORS 行为 |
| `assets/media-probe.html` | HEVC 播放探针 |
| `sync-wasm.sh` | 从 `node_modules` 同步 `openhongguo.wasm` 与 `wasm_exec.js` |

`openhongguo.wasm`、`wasm_exec.js`、`hg-mp4.js`、`hevc-sample.mp4`、`build/`、
`.gradle/`、`local.properties` 均已 gitignore，不入仓。

## 端点的实现状态

页面一共调 15 个端点。

| 端点 | 实现 |
| --- | --- |
| `feed` / `search` / `suggest` | WASM SDK + mapper |
| `series/:id` / `series/:id/episodes` | WASM SDK + 分页收集 |
| `episodes/:id/playback` | SDK 解析元数据，返回自有 `/api/media/:id` 地址（**不下载视频**） |
| `media/:id` | SDK 解析 + 原生代理下载 + 端上解密，返回明文 MP4 字节 |
| `ranking` / `ranking/catalog` / `random` | SDK `shortRank` + 严格过滤 |
| `cover` | 原生 `CoverHandler`（HEIC → JPEG） |
| `sprite/:id` / `sprite/:id/:n` | 适配层从 `video_model.big_thumbs` 读元数据；图片走原生 `SpriteHandler` |
| `health` / `diagnostics` | 端上自答 |

页面的 15 个端点在壳内全部可用。`/api/video` 与 `/api/sprite-sheet` 不经
`window.fetch`：前者是视频字节，后者是 `background-image`，两者都由
`shouldInterceptRequest` 原生接管。`/api/media/:id` 同样不经 `window.fetch`
（它只作为 `<video src>` 出现），由适配层拦 `src` 写入后换成 blob URL。

### 为什么 `/playback` 不下载视频

`GET /api/episodes/:id/playback` 只返回元数据（`streamUrl` / 档位 / 时长），
字节在 `GET /api/media/:id` 里懒加载。这与 server 完全同构。

早期版本在这个端点里就下载 + 解密整份视频，为了直接给出 blob URL。后果是：
下载面板只需要「有哪几档」，却要为此拉完整集；遇到大集（实测一集 360p 就有
248 MB）会撞体积上限，整个端点 502，面板报「清晰度获取失败」——而移动端 web
同一集能正常列出 5 档。拆开后 `/playback` 实测 194 ms 返回 5 档，与 web 一致。

## 壳必须自己实现的四件事

这四项在移动端浏览器上由浏览器提供，Android WebView 不提供。缺任何一项都会表现为
「页面功能坏了」，但根因在宿主：

| 能力 | 缺了会怎样 | 实现 |
| --- | --- | --- |
| DOM 全屏 | `requestFullscreen()` 抛 `Fullscreen is not supported` | `WebChromeClient.onShowCustomView` / `onHideCustomView` |
| 横屏锁 | 全屏后仍竖屏，16:9 视频上下大黑边 | `requestedOrientation = SCREEN_ORIENTATION_SENSOR_LANDSCAPE` |
| 下载落盘 | `<a download href="blob:">` 点了没反应，文件不落盘 | 接管 `HTMLAnchorElement.prototype.click` + 分块桥接 + MediaStore |
| 非 `fetch` 的媒体请求 | `background-image` 拿到 `FileNotFoundException`；`<video src="/api/media/...">` 永远停在 `readyState 0` | `shouldInterceptRequest` 拦 `/api/cover` 与 `/api/sprite-sheet`；适配层拦 `HTMLMediaElement.src` 换成 blob URL |

`screen.orientation.lock()` 在 WebView 里直接抛
`NotSupportedError: ... is not available on this device`，所以横屏必须由宿主设置。

下载的字节**必须**经 JS 传递：`/api/video` 的缓存文件是 CENC **加密**的，解密只在
`hg-cenc.js` 里做过。一次传 8–39 MB 会 OOM，所以按 512 KB 分块。

`background-image` 与 `<img src>` 都不经过 `window.fetch`，只能由
`shouldInterceptRequest` 接管。`/api/cover` 与 `/api/sprite-sheet` 都走这条路。

逐项功能走查结果见 [`docs/feature-parity.md`](docs/feature-parity.md)。

## 为什么 transport 必须桥接到 Kotlin

`web/dist` 页面在 WebView 里运行，`fetch` 行为与桌面浏览器一致：跨源请求自动带 `Origin`，且要求上游返回 `Access-Control-Allow-Origin`。上游不返回该头，请求被拦。

OkHttp 是原生 HTTP 客户端，不受同源策略约束，所以签名请求由 Kotlin 发出。WebView 与 Kotlin 之间用 `WebMessageListener`（异步、带 replyProxy）通信，消息体用 JSON，二进制走 Base64。

## 与 server 的差异

| 项 | server | 端上 |
| --- | --- | --- |
| 设备档案 | SQLite `devices.profile` | `localStorage['ohg']` |
| 封面 | `heic-convert` + `sharp` | `BitmapFactory`（API 28+ 原生支持 HEIF） |
| 视频 | 落盘 + Range 分段响应 | 流式落盘 + 一次性返回 |
| CENC 解密 | `node:crypto` | `crypto.subtle` AES-CTR |
| 缓存 | TtlCache（内存） | 简单 Map / LRU |
| `sprite` | 有 `big_thumbs` 时返回，无则 404 | 同样 |

## 已知问题

1. **`AGENTS.md` 契约冲突**：`../AGENTS.md` 规定「浏览器不接触上游」，签名只在服务端。本工程把签名下移到设备端，属于对既有契约的扩展。该约束针对 `web/`，本工程是独立客户端，不引用 `web/` 的签名路径。
2. **模拟器性能不代表真机**：`discover` 3.8–10.6 秒，主要成本是上游网络（其中 `cell/change` 响应体 2.7 MB）与 WASM 首次启动。真机会更快。
3. **首次播放要等下载 + 解密**：1080p 约 16 秒（含 39 MB 下载）。这是端上解密的固有成本，不是 bug。
4. **`sprite` 依赖上游数据**：有 `big_thumbs` 的集才有缩略图，没有的集返回 404。
   server 侧行为完全一致（实测同一集两边都是 200 或都是 404）。
5. **下载要经过 JS 内存**：受 CENC 解密只在 JS 侧的限制，下载比播放多一次完整字节拷贝。1080p 单集约 9 MB，实测下载 + 落盘约 2 秒。
6. **全屏提示只在首次出现**：系统会弹一次「Viewing full screen / To exit, swipe down」，这是 Android 的系统级提示，不是本应用的 UI。
7. **播放页会同时缓存两份视频**：`player-route.tsx` 会预取下一集，所以缓存目录里最多同时有当前集和下一集。淘汰只在文件没被读取时才生效，所以峰值占用大约是两集之和（1080p 最多约 30 MB）。

## 本工程不是 npm 包

`pnpm-workspace.yaml` 已用 `!apps/hongguo/android` 排除本目录。不要在这里加 `package.json`。
