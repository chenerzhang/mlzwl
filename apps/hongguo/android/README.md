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

| 项                                   | 结果                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| WebView 内加载 6.5 MB WASM           | 可行。下载 540 ms，实例化+启动 602 ms                                                 |
| WebView 内 `fetch` 直连上游 API      | **被 CORS 拦截**。自动带 `Origin`，上游无 `ACAO` 响应头                               |
| WebView 内 `fetch` 直连视频 CDN      | **403**。UA 是 Android WebView，响应体为空                                            |
| Kotlin 侧 OkHttp 发签名请求          | 可行。`device_register` 200，`discover` 返回 9 条                                     |
| `WebViewAssetLoader` 托管 `web/dist` | 可行。绝对路径 `/assets/*` 无需改 vite base                                           |
| WebCrypto AES-CTR 解 CENC            | 可行。与 server 的 `node:crypto` **逐字节一致**，8663 样本 110 ms（并发 32 时 49 ms） |
| HEVC 在 WebView 内播放               | 可行。`hvc1.1.6.L120.90` → `probably`                                                 |
| 上游封面是 HEIC                      | WebView 不解码，必须原生转 JPEG（`BitmapFactory`，API 28+）                           |

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

## CI 构建与签名

`.github/workflows/hongguo-android-apk.yml` 在合码后自动构建 release APK。

### 触发条件

| 事件                | 条件                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `push`              | 目标分支为 `master`，且改动命中 `apps/hongguo/**`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`package.json` 或 workflow 文件本身 |
| `workflow_dispatch` | 任意分支，手动触发                                                                                                              |

PR 上不跑这个 workflow。构建约 5 分钟，而 APK 只在合入后才需要。
同一分支的连续推送会取消上一次构建（`concurrency`）。

### 产物

| 情况           | 产物名                               | 能否直接安装   |
| -------------- | ------------------------------------ | -------------- |
| secrets 齐全   | `hongguo-shell-release.apk`          | 是             |
| 缺任一 secrets | `hongguo-shell-release-unsigned.apk` | 否，需本地签名 |

两种情况都上传为 artifact `hongguo-shell-release`，保留 30 天。
从 GitHub 网页或 `gh run download <run-id> -n hongguo-shell-release` 取回。

### 构建可复现

同一份源码在 CI 与本地构建出的 unsigned APK 字节完全相同。
实测 `sha256sum` 两边都是 `e07d2a51...ddae`。

这条性质依赖两个前提，破坏任一个就会失去可复现性：

1. `assets/` 下的调试样本被显式排除。`hevc-sample.mp4` 这类文件在
   `.gitignore` 里，但 Gradle 扫的是目录而不是 git 索引。不排除就会被
   静默打进本地 APK，而 CI 上没有该文件。
2. build-tools 版本固定。workflow 用 `36.0.0`，与 `compileSdk` 对齐。
   改成「取最新」会随 runner 镜像漂移。

### 签名材料如何配置

四个 secrets，缺任意一个就退化成 unsigned：

| Secret                 | 含义                   |
| ---------------------- | ---------------------- |
| `HG_KEYSTORE_BASE64`   | keystore 文件的 base64 |
| `HG_KEYSTORE_PASSWORD` | keystore 口令          |
| `HG_KEY_ALIAS`         | 密钥别名               |
| `HG_KEY_PASSWORD`      | 密钥口令               |

生成 keystore 并转 base64（只在本机执行，产物不要提交）：

```bash
keytool -genkeypair -v -keystore hongguo-release.jks \
  -alias hongguo -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass '<口令>' -keypass '<口令>' \
  -dname 'CN=hongguo, OU=mlzwl, O=mlzwl, L=, ST=, C=CN'

base64 -i hongguo-release.jks | tr -d '\n' > hongguo-release.b64
```

写入 GitHub secrets（在仓库根执行，命令会提示粘贴）：

```bash
gh secret set HG_KEYSTORE_BASE64 < hongguo-release.b64
gh secret set HG_KEYSTORE_PASSWORD
gh secret set HG_KEY_ALIAS
gh secret set HG_KEY_PASSWORD
```

配完执行 `gh secret list` 应看到四项。

### 为什么 secrets 可以放在公开仓库

GitHub 官方文档写明：

> With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner
> when a workflow is triggered from a forked repository.

本 workflow 只由 `push: master` 与 `workflow_dispatch` 触发。两者都需要仓库
写权限，fork 无法触发。

**绝不要给这个 workflow 加 `pull_request_target` 或 `workflow_run`**。
这两类触发器会在有 secrets 的前提下 checkout 不可信代码，是 secrets
泄漏最常见的原因。

### 本地开发不受影响

`app/build.gradle.kts` 按以下顺序读签名参数：

1. 环境变量 `HG_KEYSTORE_FILE` / `HG_KEYSTORE_PASSWORD` / `HG_KEY_ALIAS` /
   `HG_KEY_PASSWORD`
2. `local.properties` 的 `hg.keystore.file` / `hg.keystore.password` /
   `hg.key.alias` / `hg.key.password`
3. 都没有 → 产出 unsigned，构建不失败

本地要出签名包，把四项写进 `local.properties` 即可。
该文件已在 `.gitignore` 里：

```properties
hg.keystore.file=/绝对路径/hongguo-release.jks
hg.keystore.password=口令
hg.key.alias=hongguo
hg.key.password=口令
```

两条路径都已实测：

| 场景                                                           | 结果                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 只有 `local.properties` 配齐四项                               | 产出 `app-release.apk`，证书正确                                       |
| 环境变量与 `local.properties` 都配，但环境变量指向不存在的文件 | 产出 unsigned。环境变量优先，且文件不存在时不回退到 `local.properties` |
| 两边都没配                                                     | 产出 unsigned，日志打印提示                                            |

第二条是有意设计：环境变量优先意味着 CI 的意图明确。若环境变量写错却
静默回退到 `local.properties`，CI 会用一个本地文件签出包，问题被掩盖。

### 六种签名方案对比

选型依据是真实项目做法与官方文档，不是直觉。

| 方案                                      | 适用场景                   | 公开仓库下的风险                          | 本项目是否采用                               |
| ----------------------------------------- | -------------------------- | ----------------------------------------- | -------------------------------------------- |
| ① CI 内 `keytool` 临时生成                | 产物只用于测试，不对外分发 | 无。密钥每次构建都变，用完即弃            | 否。侧载包必须签名稳定，否则用户无法覆盖安装 |
| ② secrets 存 base64 keystore              | 个人或小团队、侧载分发     | 低。见下方说明                            | **是**                                       |
| ③ `environment` + required reviewers      | 团队协作，需要人工卡口     | 更低。审批通过前拿不到 secrets            | 否。单人项目，人工审批只增加摩擦             |
| ④ Play App Signing / 上传密钥分离         | 上架 Google Play           | 低。签名密钥在 Google 侧，CI 只持上传密钥 | 否。本项目不上架 Play                        |
| ⑤ OIDC + 云 KMS 签名                      | 中大型团队，密钥不出硬件   | 最低。私钥不可导出                        | 否。需要云账号与费用，对个人项目过重         |
| ⑥ `local.properties` / 环境变量读签名配置 | 所有场景的落地方式         | 取决于材料存在哪                          | **是**，作为②的读取层                        |

方案②的风险边界要讲清。GitHub 官方文档写明：

> With the exception of `GITHUB_TOKEN`, secrets are not passed to the runner
> when a workflow is triggered from a forked repository.

所以只要不使用 `pull_request_target` / `workflow_run`，fork 无法拿到 secrets。
本 workflow 的触发器是 `push: master` 与 `workflow_dispatch`，两者都要求仓库
写权限。`pull_request_target` 的危险在于它会在有 secrets 的前提下 checkout
不可信代码，这正是 secrets 泄漏最常见的原因。

参考的真实项目：

| 项目            | 仓库 | 做法                                                                  |
| --------------- | ---- | --------------------------------------------------------------------- |
| Signal-Android  | 公开 | 只出 unsigned。workflow 注释原文「No credentials are available here」 |
| Element-Android | 公开 | 只出 unsigned                                                         |
| Bitwarden       | 公开 | Azure Key Vault 取 keystore（方案⑤的托管版）                          |
| FadCam          | 公开 | secrets 存 base64 keystore，直接出签名包（方案②）                     |

Signal 与 Element 出 unsigned 是因为它们有独立的发布流水线，不是技术上
做不到。侧载分发的项目用方案②是通行做法。

### 轮换密钥

注意：换 keystore 会改变签名证书。已安装旧版的设备必须先卸载，
因为 Android 拒绝签名不一致的覆盖安装。

```bash
# 1) 生成新 keystore（同上）
# 2) 覆盖四个 secrets
gh secret set HG_KEYSTORE_BASE64 < hongguo-release.b64
# 3) 手动跑一次 workflow 验证
gh workflow run hongguo-android-apk.yml
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

| 文件                       | 作用                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `MainActivity.kt`          | WebView 装配、`WebViewAssetLoader`、`WebMessageListener` 桥接                      |
| `InjectingAssetHandler.kt` | 托管 assets，并把适配层脚本插到 `index.html` 的 `<head>` 最前                      |
| `HttpTransport.kt`         | OkHttp 发请求；`execute` 走 Base64（SDK 用），`downloadToFile` 流式落盘（视频用）  |
| `CoverHandler.kt`          | `/api/cover`：HEIC → JPEG，LRU 缓存                                                |
| `VideoProxyHandler.kt`     | `/api/video`：视频字节流式落盘后交给 `FileInputStream`；引用计数保护正在播放的那份 |
| `DownloadHandler.kt`       | 下载落盘：三段式桥接命令 + MediaStore 写入公共下载目录                             |
| `SpriteHandler.kt`         | `/api/sprite-sheet`：HEIC 雪碧图 → JPEG，**不降采样**                              |
| `assets/hg-adapter.js`     | `/api/*` 适配层：15 个端点、mapper、视频接口改写、CENC 触发、`<a download>` 接管   |
| `assets/hg-cenc.js`        | WebCrypto AES-CTR 解 CENC                                                          |
| `assets/hg-mp4.js`         | 从 `shared/src/mp4.ts` 打包的 MP4 box 解析器                                       |
| `assets/probe.html`        | WASM 探针                                                                          |
| `assets/origin-test.html`  | WebView `fetch` 的 `Origin` 与 CORS 行为                                           |
| `assets/media-probe.html`  | HEVC 播放探针                                                                      |
| `sync-wasm.sh`             | 从 `node_modules` 同步 `openhongguo.wasm` 与 `wasm_exec.js`                        |

`openhongguo.wasm`、`wasm_exec.js`、`hg-mp4.js`、`hevc-sample.mp4`、`build/`、
`.gradle/`、`local.properties` 均已 gitignore，不入仓。

## 端点的实现状态

页面一共调 15 个端点。

| 端点                                     | 实现                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `feed` / `search` / `suggest`            | WASM SDK + mapper                                                      |
| `series/:id` / `series/:id/episodes`     | WASM SDK + 分页收集                                                    |
| `episodes/:id/playback`                  | SDK 解析元数据，返回自有 `/api/media/:id` 地址（**不下载视频**）       |
| `media/:id`                              | SDK 解析 + 原生代理下载 + 端上解密，返回明文 MP4 字节                  |
| `ranking` / `ranking/catalog` / `random` | SDK `shortRank` + 严格过滤                                             |
| `cover`                                  | 原生 `CoverHandler`（HEIC → JPEG）                                     |
| `sprite/:id` / `sprite/:id/:n`           | 适配层从 `video_model.big_thumbs` 读元数据；图片走原生 `SpriteHandler` |
| `health` / `diagnostics`                 | 端上自答                                                               |

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

## 壳必须自己实现的五件事

这五项在移动端浏览器上由浏览器提供，Android WebView 不提供。缺任何一项都会表现为
「页面功能坏了」，但根因在宿主：

| 能力                  | 缺了会怎样                                                                                              | 实现                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOM 全屏              | `requestFullscreen()` 抛 `Fullscreen is not supported`                                                  | `WebChromeClient.onShowCustomView` / `onHideCustomView`                                                                                                          |
| 横屏锁                | 全屏后仍竖屏，16:9 视频上下大黑边                                                                       | `requestedOrientation = SCREEN_ORIENTATION_SENSOR_LANDSCAPE`                                                                                                     |
| 下载落盘              | `<a download href="blob:">` 点了没反应，文件不落盘                                                      | 接管 `HTMLAnchorElement.prototype.click` + 分块桥接 + MediaStore                                                                                                 |
| 非 `fetch` 的媒体请求 | `background-image` 拿到 `FileNotFoundException`；`<video src="/api/media/...">` 永远停在 `readyState 0` | `shouldInterceptRequest` 拦 `/api/cover` 与 `/api/sprite-sheet`；适配层拦 `HTMLMediaElement.src` 换成 blob URL                                                   |
| 安全区                | 标题被状态栏压住；底部内容被导航栏压住                                                                  | 顶部：`setDecorFitsSystemWindows(false)` 让页面的 `env()` 生效。底部：WebView 的 `env(safe-area-inset-bottom)` 实测恒为 0，改由原生上报 `WindowInsets`（见下节） |

`screen.orientation.lock()` 在 WebView 里直接抛
`NotSupportedError: ... is not available on this device`，所以横屏必须由宿主设置。

下载的字节**必须**经 JS 传递：`/api/video` 的缓存文件是 CENC **加密**的，解密只在
`hg-cenc.js` 里做过。一次传 8–39 MB 会 OOM，所以按 512 KB 分块。

`background-image` 与 `<img src>` 都不经过 `window.fetch`，只能由
`shouldInterceptRequest` 接管。`/api/cover` 与 `/api/sprite-sheet` 都走这条路。

### 为什么安全区必须由宿主开

`targetSdk = 36`。Android 15（API 35）起，`targetSdk >= 35` 的应用**强制
edge-to-edge**：窗口默认铺满整屏，绘制到状态栏后面。

页面已经写了 `viewport-fit=cover` 与 `padding-top: env(safe-area-inset-top)`
（`web/src/styles/index.css:177`），这是移动端 Chrome 的正确写法。但 WebView
只有在宿主调过 `setDecorFitsSystemWindows(false)` 时才向页面报告安全区，
否则一律报 **0**——于是那个 padding 在壳里等于没写。

不要在原生侧写死一个状态栏高度：那样会与页面的 `env(safe-area-inset-*)`
叠加成双倍留白，而且横屏时状态栏高度不同。

### 为什么底部安全区必须由原生上报

`setDecorFitsSystemWindows(false)` 只解决了**顶部**。实测（1080x2400 / 420dpi）：

| 导航模式 | 导航栏物理高度 | `env(safe-area-inset-bottom)` | `env(safe-area-inset-top)` |
| -------- | -------------- | ----------------------------- | -------------------------- |
| 三键     | 126px          | **0**                         | 52px                       |
| 手势     | 63px           | **0**                         | 52px                       |

WebView 不把导航栏算进 safe-area。页面因此拿不到底部真实高度，内容会被压住。

做法：原生用 `ViewCompat.setOnApplyWindowInsetsListener` 监听
`systemBars() or displayCutout()`，除以 `density` 换算成 CSS px，通过
`evaluateJavascript` 派发 `hg:insets` 事件；适配层（`hg-adapter.js`）把它写进
`--hg-inset-top/bottom/left/right`。

页面侧 `styles/index.css` 的 `.pb-safe` / `.pt-safe` / `.pb-safe-page` 读这些变量，
并用 `max(var(--hg-inset-bottom, 0px), env(safe-area-inset-bottom, 0px))` 回退到
`env()`：桌面浏览器与 iOS Safari 没有原生桥接，仍然走标准路径。

`max()` 而不是直接取变量：将来 WebView 修好了两者都有值，取大的不会少留白。

实测两种模式下变量都跟随：三键 48.00px、手势 24.00px。

### 系统栏空间由原生 margin 管，不让页面算安全区

`targetSdk = 36`，Android 15 起强制 edge-to-edge：窗口铺满整屏，内容绘制到系统栏
后面。WebView 的可见区域因此包含状态栏与导航栏，页面标题会被状态栏压住。

做法：`applyWindowInsetsToWebView()` 把 `systemBars() or displayCutout()` 的四个边
设成 **WebView 的 margin**。WebView 的测量尺寸因此缩小，CSS viewport 跟着变小，
页面拿到的就是系统栏之间的矩形。全屏时 `immersive = true`，方法直接返回不动
WebView（`customView` 自己 `MATCH_PARENT` 铺满）；退出全屏重算 margin。

**必须用 margin，不能用 `setPadding()`。** WebView 内部是独立渲染 surface，
`setPadding()` 只裁绘制区域，CSS viewport 不变，页面内容照样从 y=0 开始画。实测
加 padding 后标题直接压到状态栏上。

**全屏期间不能改 WebView 的布局参数。** 全屏时 WebView 已 `GONE`，此时改 margin
会触发 `root` 重排，WebView 认为自身尺寸变化，立刻取消 DOM 全屏——实测进入全屏
256ms 后自动 `onHideCustomView()`。

页面侧配套：`hg-adapter.js` 的 `applyInsets()` 给 `<html>` 加 `hg-native-insets`
类并把 `--hg-inset-*` 全写 0；`styles/index.css` 在该类下把 `.pt-safe` / `.pb-safe`
归零、`.pb-safe-page` 改成 `5rem`、`.h-safe-screen` 改成 `100dvh`。

**必须连 `env()` 一起关掉。** WebView 加了 margin 之后仍会向页面报告非 0 的
`env(safe-area-inset-top)`（实测 51.81px）。若页面继续按
`max(--hg-inset-*, env(...))` 取大值，系统栏会留两次，标题下方多出一段空白。

实测（1080x2400 / 420dpi，三键导航）：视口 815px = 915 − 51.81（状态栏）−
48.00（导航栏）；`header` 的 `padding-top` 为 0；`.pb-safe-page` 为 80px。

### 系统栏底色为什么用透明

`targetSdk = 36`：Android 15（API 35）起 `window.statusBarColor` /
`window.navigationBarColor` 已废弃，赋值不再生效。实测浅色主题下把状态栏涂成
`#f5f5f7` 后它仍是黑的。

所以改成透明：`window.statusBarColor = Color.TRANSPARENT`，同时把
`window.backgroundDrawable` 设成页面底色（浅色 `#f5f5f7` / 深色 `#08080a`）。
系统栏在 WebView 的 margin 之外，不会被页面覆盖，靠窗口背景着色即可。

图标明暗仍要单独管：浅色底画深色图标，深色底画白色图标。页面主题写在
`<html data-theme>`，适配层用 `MutationObserver` 监听，通过 `theme` 命令转告
原生，原生设 `APPEARANCE_LIGHT_STATUS_BARS | APPEARANCE_LIGHT_NAVIGATION_BARS`。

`enterImmersive()` 全屏时把窗口背景涂黑，`exitImmersive()` 按 `lastLightSurface`
还原成页面底色。存布尔值而不是重新问页面：`exitImmersive()` 是同步调用，问页面
要异步往返，那一帧会闪一下错色。

逐项功能走查结果见 [`docs/feature-parity.md`](docs/feature-parity.md)。

## 为什么 transport 必须桥接到 Kotlin

`web/dist` 页面在 WebView 里运行，`fetch` 行为与桌面浏览器一致：跨源请求自动带 `Origin`，且要求上游返回 `Access-Control-Allow-Origin`。上游不返回该头，请求被拦。

OkHttp 是原生 HTTP 客户端，不受同源策略约束，所以签名请求由 Kotlin 发出。WebView 与 Kotlin 之间用 `WebMessageListener`（异步、带 replyProxy）通信，消息体用 JSON，二进制走 Base64。

## 与 server 的差异

| 项        | server                           | 端上                                     |
| --------- | -------------------------------- | ---------------------------------------- |
| 设备档案  | SQLite `devices.profile`         | `localStorage['ohg']`                    |
| 封面      | `heic-convert` + `sharp`         | `BitmapFactory`（API 28+ 原生支持 HEIF） |
| 视频      | 落盘 + Range 分段响应            | 流式落盘 + 一次性返回                    |
| CENC 解密 | `node:crypto`                    | `crypto.subtle` AES-CTR                  |
| 缓存      | TtlCache（内存）                 | 简单 Map / LRU                           |
| `sprite`  | 有 `big_thumbs` 时返回，无则 404 | 同样                                     |

## 已知问题

1. **`AGENTS.md` 契约冲突**：`../AGENTS.md` 规定「浏览器不接触上游」，签名只在服务端。本工程把签名下移到设备端，属于对既有契约的扩展。该约束针对 `web/`，本工程是独立客户端，不引用 `web/` 的签名路径。
2. **模拟器性能不代表真机**：`discover` 3.8–10.6 秒，主要成本是上游网络（其中 `cell/change` 响应体 2.7 MB）与 WASM 首次启动。真机会更快。
3. **首次播放要等下载 + 解密**：1080p 约 16 秒（含 39 MB 下载）。这是端上解密的固有成本，不是 bug。
4. **`sprite` 依赖上游数据**：有 `big_thumbs` 的集才有缩略图，没有的集返回 404。
   server 侧行为完全一致（实测同一集两边都是 200 或都是 404）。
5. **下载要经过 JS 内存**：受 CENC 解密只在 JS 侧的限制，下载比播放多一次完整字节拷贝。1080p 单集约 9 MB，实测下载 + 落盘约 2 秒。
6. **全屏提示只在首次出现**：系统会弹一次「Viewing full screen / To exit, swipe down」，这是 Android 的系统级提示，不是本应用的 UI。
7. **播放页会同时缓存两份视频**：`player-route.tsx` 会预取下一集，所以缓存目录里最多同时有当前集和下一集。淘汰只在文件没被读取时才生效，所以峰值占用大约是两集之和（1080p 最多约 30 MB）。
8. **同一集的并发请求串行化**：`VideoProxyHandler` 用一把 per-URL 锁。8 路并发打同一集时，只有 1 次真实下载，另外 7 次等锁后命中缓存。代价是并发请求同一集时最慢那一路要等第一路下完；收益是不会出现「两路同时写同一个文件」。
9. **首帧等待受网络限制**：端上是「下载整集 → 解密 → 给 blob URL」，没有 Range 分段响应，所以首帧要等整集下载完。实测网络 89 KB/s 时 1080p 一集 24 MB 要 94 秒；5.4 MB/s 时只要 2.3 秒。壳内已保证这段等待不会误报「播放停滞」（见缺陷 21），但等待本身无法消除。要真正缩短首帧，需要服务端支持 Range。
10. **播放设置收进二级菜单**：播放页底部常驻进度条与「设置 / 选集 / 全屏」。音量、清晰度、倍速、画幅模式收在齿轮图标打开的设置面板里。进度条**不**收起——进度是播放页最核心的信息。短剧用户的高频动作只有继续看与换集，其余是低频开关，常驻它们会挤窄进度条并遮住画面。

    设置面板里的**音量滑块常显**，不做「悬停/点击展开」。原因：原来的展开依赖两条路径——鼠标悬停，或点击滑块本身。触屏没有悬停；滑块收起时宽度是 0，点击也点不到。两条路径都断了，用户只能看到喇叭按钮，反馈「只能开和关，调不了音量」。`VolumeControl` 因此新增 `inline` 属性：滑块常显、宽度撑满、不做焦点陷阱。`allowSlider` 仍由设备能力决定——iOS 的 `video.volume` 只读，那种设备上不渲染滑块。

11. **横向拖动调进度只在有总时长时生效**：`duration` 未知（元数据还没到）时手势不接管，避免算出无意义的位置。灵敏度固定 90 秒/屏宽，不是按片长百分比——短剧一集只有 1–3 分钟，百分比模式会让一屏拖过半个片子。
12. **预取会给首帧让路**：页面的预取请求（`range: bytes=0-1`）会先等当前集 `readyState >= 2` 再开始，上限 30 秒。代价是切下一集时缓存可能还没就绪；收益是网络差时首帧不被预取抢带宽。

## 本工程不是 npm 包

`pnpm-workspace.yaml` 已用 `!apps/hongguo/android` 排除本目录。不要在这里加 `package.json`。
