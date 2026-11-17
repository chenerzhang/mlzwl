# WebView 壳功能走查表

对照对象：移动端 web（`http://127.0.0.1:9133/`，移动视口）与模拟器内壳
（`https://appassets.androidplatform.net/index.html`，`--es target index`）。

验证方法：CDP `Input.dispatchTouchEvent` 真实触摸事件 + `Runtime.evaluate` 读 DOM 状态

- `adb logcat` + `adb exec-out screencap`。**不用** `dispatchMouseEvent`：实测它不算
  用户手势，`requestFullscreen()` 会以 `Permissions check failed` 失败，会误判成缺陷。

判定口径：`一致` 表示壳内行为与移动端 web 相同；`不一致` 表示有可观察差异且已修或需修；
`不适用` 表示该项在 web 侧不存在（壳独有能力）。

## 一、结果总表

| #   | 功能           | 移动端 web                  | 壳内实测                                                                                                                                                                 | 判定         |
| --- | -------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 1   | 首页 feed 数据 | 真实剧集                    | 8–12 部真实剧名/集数/封面                                                                                                                                                | 一致         |
| 2   | 首页滚动加载   | 滚动翻页                    | 卡片 12 → 24                                                                                                                                                             | 一致         |
| 3   | 搜索联想       | 输入即联想                  | 输入「大明」→ 9 条联想                                                                                                                                                   | 一致         |
| 4   | 搜索提交       | 回车出结果                  | 回车 → 结果页，标题「共 N 部」                                                                                                                                           | 一致         |
| 5   | 搜索结果封面   | 有封面                      | 修复后 12 张图 9 张 `naturalWidth` 507–800                                                                                                                               | 一致（已修） |
| 6   | 剧集详情       | 标题/简介/分集              | 正常渲染，63 集列表                                                                                                                                                      | 一致         |
| 7   | 点击卡片进详情 | 路由跳转                    | `/` → `/series/:id`                                                                                                                                                      | 一致         |
| 8   | 选集抽屉       | 打开显示集数                | 「共 63 集」+ 第 1–20 集 + 每集下载按钮                                                                                                                                  | 一致         |
| 9   | 换集播放       | 切集重载                    | 第 3 集 → 新 URL、`readyState:4`、1920x1080                                                                                                                              | 一致         |
| 10  | 播放出画面     | 有画面                      | `readyState:4`、`currentTime` 推进、截图有画面+字幕                                                                                                                      | 一致         |
| 10b | 预取下一集     | 播放中后台预热下一集        | **修复后** 两集并发播放信息请求都 200，二次并发 154 ms 命中缓存                                                                                                          | 一致（已修） |
| 11  | 单击画面       | 切换控件显隐                | `pointer-events` auto → none → auto                                                                                                                                      | 一致         |
| 12  | 双击画面       | 播放/暂停                   | 间隔 220 ms 双击 → `paused` 翻转                                                                                                                                         | 一致         |
| 13  | 长按画面       | 2 倍速                      | 按住 `rate=2`，松开 `rate=1`                                                                                                                                             | 一致         |
| 14  | 左右滑动       | 快进/快退                   | 右滑 `currentTime` 53.2 → 64.2                                                                                                                                           | 一致         |
| 15  | 进度条拖动     | 拖动跳转                    | 23.8 s → 86.4 s（总长 123 s）                                                                                                                                            | 一致         |
| 16  | 倍速菜单       | 0.5×–3×                     | 菜单 7 项，选 1.5× → `playbackRate=1.5`                                                                                                                                  | 一致         |
| 17  | 清晰度切换     | 换档重载                    | 1080p → 360p，实际 `videoWidth=640`                                                                                                                                      | 一致         |
| 18  | 静音           | 切换静音                    | `muted` false → true                                                                                                                                                     | 一致         |
| 18b | 音量滑块       | 桌面 hover 展开，触屏不展开 | `canSetVolume=true`（能写 `volume`）；滑块存在，写 30 → `video.volume` 1 → 0.3；触屏下容器宽 0（`onPointerEnter` 只在 `pointerType==='mouse'` 展开，`web/src` 设计如此） | 一致         |
| 19  | 全屏           | 元素全屏                    | **修复后** `fullscreenElement` = DIV                                                                                                                                     | 一致（已修） |
| 20  | 全屏横屏       | `orientation.lock`          | **修复后** 915x412 / landscape-primary                                                                                                                                   | 一致（已修） |
| 21  | 退出全屏       | 恢复竖屏                    | 915x412 → 412x915 / portrait-primary                                                                                                                                     | 一致         |
| 22  | 下载面板       | 清晰度+单集+批量            | 面板含 360p–1080p、批量下载、逐集按钮                                                                                                                                    | 一致         |
| 23  | 下载落盘       | 浏览器存盘                  | **修复后** `/sdcard/Download/<id>-360p.mp4` 3,047,225 B                                                                                                                  | 一致（已修） |
| 24  | 下载文件可播   | 明文 MP4                    | ffprobe hevc/hvc1 640x360 + aac，解码 exit 0                                                                                                                             | 一致         |
| 25  | 收藏切换       | 收藏/取消                   | 按钮 aria 翻转，收藏页显示「共 1 部」                                                                                                                                    | 一致         |
| 26  | 追更切换       | 追更/取消                   | 按钮 aria 翻转                                                                                                                                                           | 一致         |
| 27  | 观看历史       | 列出进度                    | 「观看历史」+ 3 部剧 + 百分比                                                                                                                                            | 一致         |
| 28  | 榜单页         | 分类+榜单                   | 14 个分类/榜单标签全部渲染                                                                                                                                               | 一致         |
| 29  | 榜单切换       | 切榜换数据                  | 点「热播榜」→ 10 条带热度/集数                                                                                                                                           | 一致         |
| 30  | 更多操作菜单   | 窄屏收进菜单                | 菜单含随机/收藏/热度榜/历史/搜索/主题                                                                                                                                    | 一致         |
| 31  | 菜单导航跳转   | 路由跳转                    | 点「搜索」→ `/search`                                                                                                                                                    | 一致         |
| 32  | 返回键         | 浏览器后退                  | `/series/:id` → `/`                                                                                                                                                      | 一致         |
| 33  | 屏幕旋转       | 响应式重排                  | 横屏 915x412，4 列网格，图标按钮展开                                                                                                                                     | 一致         |
| 34  | 安全区         | 状态栏不遮挡                | 横屏截图内容未被状态栏遮挡                                                                                                                                               | 一致         |
| 35  | 进度条缩略图   | sprite 预览                 | **修复后** meta 200（1181 帧 / 12 张）；拖动时 240x136 预览图显示真实画面 + 时间                                                                                         | 一致（已修） |

### 与移动端 web 的逐项对照证据

下表只列本轮新验或重新验的项，均为同一集、同一操作下的两侧实测。

| 项                     | 移动端 web（9133）                                                              | 壳内（模拟器）                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/sprite/:id` meta | 200，`gridX 10 / gridY 10 / cell 240x136 / 1181 帧 / 12 张`                     | 完全相同                                                                                         |
| `/api/sprite/:id/0`    | 200 `image/jpeg` 941,296 B                                                      | 200 `image/jpeg` 1,068,646 B（质量参数 88，体积不同）                                            |
| 拖动进度条预览         | `240x136`、`background-size 2400px 1360px`、`background-position -960px -952px` | `240x136`、`background-size 2400px 1360px`、`background-position -1680px -680px`（拖动位置不同） |
| 预览内容               | 截图可见真实画面 + 时间 1:14                                                    | 截图可见真实画面 + 时间 0:57                                                                     |
| 全屏                   | `fullscreenElement` = DIV，横屏                                                 | 同                                                                                               |
| 视频解码               | `readyState 4`、1920x1080                                                       | `readyState 4`、640x360（默认 360p）                                                             |

注：壳内默认档位是 360p，移动端 web 默认 1080p。这是 server 与端上的默认档位策略差异，
切换档位后两侧一致（已验证 1080p ↔ 360p 互切）。

## 二、功能走查阶段修复的 7 个缺陷

### 1. 全屏按钮无效（起点缺陷）

**现象**：点全屏按钮，`document.fullscreenElement` 恒为 `null`。

**根因**：`MainActivity` 的 `WebChromeClient` 只实现了 `onConsoleMessage`，没有
`onShowCustomView` / `onHideCustomView`。Android WebView 只在宿主实现了该回调时
才向页面暴露 Fullscreen API，否则 `requestFullscreen()` 直接抛
`TypeError: Fullscreen is not supported`。

**修复**：`MainActivity.kt` 补 `onShowCustomView` / `onHideCustomView`，用
`FrameLayout` 承载 custom view，全屏时隐藏 WebView、退出时恢复。

### 2. 全屏后不横屏

**现象**：全屏生效但仍竖屏，16:9 视频上下大黑边。

**根因**：页面全屏后调 `screen.orientation.lock('landscape')`，Android WebView
不实现该 API，实测抛
`NotSupportedError: screen.orientation.lock() is not available on this device.`。
移动端 Chrome 上它是可用的，所以壳必须自己补。

**修复**：`enterImmersive()` 里设
`requestedOrientation = SCREEN_ORIENTATION_SENSOR_LANDSCAPE`，退出时恢复
`SCREEN_ORIENTATION_UNSPECIFIED`。用 `SENSOR_LANDSCAPE` 而非 `LANDSCAPE`，
允许用户在两个横屏方向间翻转，与 Chrome 的 `lock('landscape')` 一致。

### 3. 下载按钮不落盘

**现象**：点下载后 UI 显示「已下载」，但 `/sdcard/Download/` 是空的。

**根因**：页面的 `saveBlob()` 造 `<a download href="blob:...">` 并 `click()`。
移动端 Chrome 会接管并存盘；**Android WebView 不会**——`DownloadListener` 只对
真实网络下载触发，`blob:` URL 不会。实测 `anchor.click()` 确实执行了，目录仍为空。

**修复**：新增 `DownloadHandler.kt` + 适配层接管 `HTMLAnchorElement.prototype.click`。
三段式桥接命令（`downloadBegin` / `downloadChunk` / `downloadFinish`），每块
512 KB 原始字节。字节**必须**经 JS 传递：原生侧的 `/api/video` 缓存文件是 CENC
**加密**的，解密只在 JS 侧（`hg-cenc.js`）做过。最终经 MediaStore 写入公共下载目录。

一次传完会 OOM（实测 `Failed to allocate a 39101711 byte allocation`），所以分块。

### 4. 搜索结果全部「无封面」

**现象**：搜索页每条结果都显示「无封面」。

**根因**：上游搜索接口不返回 `cover_url`，server 的 `loadSearch` 会额外调
`getSeriesBatch` 补齐。适配层写了同样的逻辑，但把返回结构读错了：
`getSeriesBatch` 返回 `[{ series: {...} }]`，代码读的是 `d.id` / `d.cover_url`，
全部拿到 `undefined`。

**修复**：映射改为 `d.series` 优先。

### 5. 返回键直接退出应用

**现象**：按返回键结束 Activity，页面路由历史全丢。

**根因**：没有接管返回键。

**修复**：`OnBackPressedCallback` 三级处理：全屏时先退全屏 → `canGoBack()` 时
`goBack()` → 否则交回系统。

### 6. 首次播放报「视频下载失败 HTTP 502」

**现象**：点播放先显示「播放失败：视频下载失败 HTTP 502 / 重试」，手动点重试
才成功。不是每次复现，只有播放页同时要预取下一集时出现。

**根因**：`VideoProxyHandler` 的淘汰策略是「新的一份进来就把旧的全删」。但
`web/src/routes/player-route.tsx` 有 `prefetchMedia`：剩余时间进入预热窗口时会
提前请求下一集。两个请求并发时，后完成的那份把先完成的文件删了。如果先完成的
那份正被 WebView 的 `FileInputStream` 读，读取就中断，页面收到错误。

**修复**（`VideoProxyHandler.kt`）：

1. 加引用计数 `refs: ConcurrentHashMap<String, Int>`。
2. `videoResponse()` 返回前 +1，用 `TrackingInputStream` 包装 `FileInputStream`，
   `close()` 时 -1。
3. 淘汰函数从「全删」改为 `evictUnused()`：只删计数为 0 的项。
4. 缓存文件名从 `Integer.toHexString(hashCode)` 改为 URL 的 SHA-256 前 16 字节：
   `hashCode` 会碰撞，撞上就读到另一集的内容。

**验证**：两个不同剧集并发请求 `/api/episodes/:id/playback` 都返回 200（7615 ms），
立即再并发一次 154 ms 全命中缓存；真实 UI 点播放无 502，直接出画面。

### 7. 进度条缩略图不显示

**现象**：拖动进度条只有时间文字，没有缩略图。

**根因（三层）**：

1. **适配层没有 sprite 路由**：`/api/sprite/*` 全部落 `not_adapter` 404。
2. **雪碧图元数据不在 SDK 返回值里**：`resolvePlayback` 只返回整理后的
   `PlaybackResult`，不含 `big_thumbs`。它只在上游原始 `video_model` 字符串里。
   server 侧用 `VideoModelCapture` 装饰器抓原始响应，端上没有这个装饰器。
3. **`background-image` 不经过 `window.fetch`**：即使适配层返回了图片字节，
   `sprite-preview.tsx` 把 URL 用在 `background-image` 上，这类请求由
   `WebViewAssetLoader` 处理，命中不到适配层路由表，只得到
   `FileNotFoundException: api/sprite/<id>/<n>`。

**修复**：

1. `hg-adapter.js`：在 `liftVideoModel` 解析 `video_model` 时顺手调
   `rememberSprite(readSprite(...))`，把 `big_thumbs` 存进 `spriteCache`
   （按 video id 与 episode id 双键，上限 32 条）。移植自
   `server/src/media/video-model-capture.service.ts` 的 `readSprite`。
2. 新增 `/api/sprite/:episodeId` 路由：返回 `gridX/gridY/cellWidth/cellHeight/
frameCount/interval/sheetCount/sheetUrls`，与 server 的 `sprite.controller.ts`
   字段完全一致。缓存未命中时补一次 `resolvePlayback`。
3. `sheetUrls` **指向 `/api/sprite-sheet?url=<upstream>`**，不是
   `/api/sprite/:id/:n`。前者由原生 `SpriteHandler` 在
   `shouldInterceptRequest` 接管，`background-image` 能拿到 JPEG。
4. 新增 `SpriteHandler.kt`：HEIC → JPEG，**不降采样**（`CoverHandler` 的
   `TARGET_PX=480` 会让 `background-size` 与实际图片尺寸不符，裁剪窗口全错）。
   允许域名加 `douyinpic.com`（雪碧图在 `p26-sign.douyinpic.com`，与封面不同域）。

**验证**：`/api/sprite/7600696808167181374` → 200，1181 帧 / 12 张，与移动端
web 完全一致；`/api/sprite-sheet` → 200 `image/jpeg` 1,068,646 B，magic
`ff d8 ff e0`，原生日志 `transcoded 2400x1360`（= `10×240` × `10×136`）；
真实拖动进度条时预览图 `240x136`、`background-size: 2400px 1360px`、
`background-position: -1680px -680px`，截图可见真实画面 + 时间 0:57。

## 三、附带补齐的壳侧设置

| 设置                                     | 值                                            | 理由                                                                 |
| ---------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `useWideViewPort`                        | `true`                                        | 不设时 WebView 用 980px 布局视口，页面被缩小成桌面样式，触摸热区错位 |
| `loadWithOverviewMode`                   | `true`                                        | 同上                                                                 |
| `setSupportZoom` / `builtInZoomControls` | `false`                                       | 应用内不该出现浏览器缩放控件                                         |
| `configChanges`                          | 加 `smallestScreenSize\|screenLayout\|uiMode` | 旋转时不重建 Activity，保住页面状态                                  |

## 四、提 PR 前的独立审查与修复（14 个缺陷）

在功能走查全部通过后，另起一轮针对代码本身的审查（安全 / 资源生命周期 /
文档真实性）。审查又查出 6 个问题，均已修复并复验。

### 8. 域名白名单可用 `endsWith` 绕过

**现象**：`CoverHandler` / `SpriteHandler` / `VideoProxyHandler` 三处都用
`host.endsWith("fqnovelpic.com")` 判断主机名。

**根因**：`endsWith` 不区分「域名本身」与「域名的子域」。
`evilfqnovelpic.com`.endsWith(`fqnovelpic.com`) 为 `true`，
`attacker.example.attackerbyteimg.com` 同理。这三个端点分别接受
`/api/cover?url=`、`/api/video?url=`、`/api/sprite-sheet?url=`，
绕过后就是任意 URL 代理（SSRF 入口）。

**修复**：新建 `HostAllowlist.kt`，三处 `isAllowed` 统一改为调用它。
判断条件从 `endsWith(suffix)` 改为 `host == suffix || host.endsWith("." + suffix)`。

**验证**：9 条用例全部符合预期（`p26-sign.douyinpic.com` / `fqnovelpic.com` 通过，
`evilfqnovelpic.com` / `attacker.example.attackerbyteimg.com` /
`evil.qznovelvod.com.attacker.net` / `file:///etc/passwd` / 非法 URL 全部拒绝）。

### 9. 下载会话泄漏与无体积上限

**现象**：`DownloadHandler.sessions` 只增不减。

**根因**：会话在 `begin()` 里加进 map，只有 `finish()` / `cancel()` 才移除。
页面在两者之前崩溃或刷新（或 JS 直接不再回调）时，`cacheDir` 下的 `.part`
文件永久残留。同时 `appendChunk` 不检查累计体积，异常脚本可以写满磁盘。

**修复**：

1. `begin()` 先 `sweepStale()`：清掉超过 10 分钟的会话，并把并发会话限制到 4 个。
2. `appendChunk` 加 256 MB 累计上限，超限时删文件并返回 -1。
3. `sanitize()` 增加 `..` → `_` 与长度截断（200 字节）。`..` 不含路径分隔符，
   单靠替换 `[\\/:*?"<>|]` 拦不住，而 `File(dir, "..")` 会指到父目录。

### 10. 引用计数在流构造前就 +1

**现象**：`videoResponse()` 先 `refs.merge(source, 1)`，再 `TrackingInputStream(file, ...)`。

**根因**：`FileInputStream` 构造会抛 `FileNotFoundException`（文件刚被别的路径删了）。
先加计数、构造失败，计数就永久停在 1，这份缓存从此不会被 `evictUnused()` 清掉。

**修复**：先构造流，成功后才 `merge`；构造失败时返回 502 并 `cache.remove(source)`。

### 11. 大视频写满磁盘后才被拒

**现象**：一集 360p 有 248 MB，`downloadToFile` 完整写入 12 秒，再由
`handleVideo` 判断超限并删除。

**根因**：`downloadToFile` 不读 `content-length`，`maxBytes` 检查在调用方事后做。

**修复**：`downloadToFile` 新增 `maxBytes` 参数。先查 `body.contentLength()`，
超限立即返回；声明长度不可信时（chunked）边写边查。
同时把壳的上限从 128 MB 改为 200 MB，与 server 的 `MEDIA_MAX_BYTES` 一致，
避免「网页能看、壳里报错」。

### 12. `/playback` 为拿档位下载整集（与 server 不同构）

**现象**：下载面板报「清晰度获取失败」，但移动端 web 同一集能正常列出 5 档。

**根因**：壳内 `/api/episodes/:id/playback` 直接调 `resolveDecrypted`——
下载 + 解密整份视频，再给 blob URL。只要视频超过体积上限，整个端点就 502。
而 server 的同名端点只返回元数据，字节在 `/api/media/:id` 里懒加载。

**修复**：拆成两层。`resolveMeta()` 只查元数据（选档 + 时长 + 档位列表）；
`resolvePlayback()` 返回与 server 同形的 `streamUrl: /api/media/:id?definition=...`；
`resolveDecrypted()` 才取字节。

**验证**：`/playback` 从 12 秒 + 502 变为 **194 ms 返回 5 档**，与 web 一致。

### 13. `<video src="/api/media/...">` 无人接管

**现象**：修完 #12 后播放失效，`readyState` 永远 0、`videoWidth` 0。

**根因**：页面把 `playback.streamUrl` 直接赋给 `<video>`。这个请求**不经
`window.fetch`**，也不经适配层路由，`shouldInterceptRequest` 里也没有
`/api/media` 分支，最终落到 asset loader 得到 `FileNotFoundException`。

也不能让原生 `shouldInterceptRequest` 返回字节：`/api/video` 缓存的是 CENC
**加密**文件，浏览器解不了，解密只在 JS 侧（`hg-cenc.js`）。

**修复**：适配层新增 `installMediaSrcInterceptor()`，同时拦
`HTMLMediaElement.prototype.src` 的 setter 与 `Element.prototype.setAttribute`
（实测 React 走 property、直接写 HTML 走 attribute，两条路都存在）。
命中 `/api/media/` 时先解密再写 blob URL。

**验证**：`readyState 4`、`640x360`、`currentSrc` 是 `blob:https://appassets...`。

### 14. 字节缓存只限条数、不限字节

**现象**：`byteCache` 与 `blobCache` 都只限 3 条。

**根因**：实测最长一集 1080p 有 80 MB。3 × 80 = 240 MB 全压在 WebView 的
JS 堆里，比之前 base64 桥接 OOM 那次（39 MB）严重得多。

**修复**：两个缓存都加总字节上限 96 MB，超限从最旧的开始删；单份超预算时
保留它（否则会「刚放进去就删掉自己」）。`blobCache` 淘汰时必须
`revokeObjectURL`，否则内存不会释放。

### 另外清理的两项

- `hg-adapter.js` 里两条调试日志（`'video_model 键: '`、`'sprite sheet url host: '`）已删除。
- README 与本文档中「`/playback` 返回 blob URL」的旧描述已改为「只返回元数据」。

### 15. 封面地址格式与 `shared` 约定不一致

**现象**：重进应用后首页 9 张卡片全部显示「无封面」，但刚打开时能正常显示。

**根因**：`@mlzwl/hongguo-shared` 的 `isCoverProxyUrl()` 只接受
`/api/cover/<base64url 令牌>`。它用在离线目录、观看历史、收藏三处的**持久化过滤**上——
早期版本把完整签名 URL 编进 `/api/cover?u=...`，那些值可能还在 `localStorage`，
所以读取时要把不符合新格式的丢掉。

壳内早期用 `/api/cover?url=` 形式，于是 `writeCatalogSnapshot()` 把 `coverUrl`
整个丢弃。首屏用快照做 `placeholderData`，就退化成「无封面」。
首次渲染正常、断网或重进才出问题，很容易漏。

**修复**：

1. `coverOf()` 改为输出 `COVER_PATH_PREFIX + base64UrlEncode(source)`，
   与 `shared/src/definitions.ts` 一致。先按 UTF-8 转字节再编码（上游地址可能含
   非 ASCII，直接 `btoa(str)` 会抛 `InvalidCharacterError`）。
2. `MainActivity` 的 `shouldInterceptRequest` 从 `path == "/api/cover"` 改为
   `path.startsWith("/api/cover")`，新增 `decodeCoverToken()` 还原地址。
   旧 `?url=` 形式保留兼容。

**与 server 的差异**：server 的令牌是 AES-GCM 加密的（密钥在服务端）；壳内没有
这个密钥，也不该有，所以用 base64url 明文编码。安全边界不同：server 的令牌防止
用户构造任意上游地址，壳内则由 `HostAllowlist` 把关，非法地址一律 403。

**验证**：`coverUrl` 变为 `/api/cover/aHR0cHM6Ly9wMy1yZWFk...`，首页 12/12 图片
`naturalWidth > 0`；离线快照 `dsh-hongguo.catalog.v1` 的 `items[0]` 包含
`coverUrl` 字段（修复前只有 `id`/`title`/`description`）。

### 16. 关闭明文流量

`AndroidManifest.xml` 的 `usesCleartextTraffic` 从 `true` 改为 `false`。
壳内所有上游都是 HTTPS（`appassets` 资源域也是 HTTPS），代码里出现的
`http://` 只是 URL 协议前缀判断，不是实际依赖。改后封面 12/12、播放
`readyState 4` 均正常。

### 17. 退出时不释放 WebView

`onDestroy()` 只 `io.shutdown()`，没有 `webView.destroy()`。WebView 内部的
渲染进程、定时器与 `WebMessageListener` 会跟着 Activity 泄漏；旋转或重入时
新旧两个 WebView 同时活着，内存翻倍。

修复：先从视图树摘掉，再 `stopLoading()` + `loadUrl("about:blank")` +
`clearHistory()` + `removeAllViews()` + `destroy()`，最后停执行器。顺序反过来
会让正在跑的 `shouldInterceptRequest` 向已销毁的 WebView 写数据。

### 18. 切清晰度时旧请求覆盖新请求

`installMediaSrcInterceptor` 里 `src` 写入触发异步解密。切档时 React 不重建
元素（`key` 是 `episodeId`，档位不在 key 里），所以同一元素会连续收到两次
`src`。两次解密并发跑，完成顺序不保证——先发起的慢请求后完成，就会把新档位的
地址覆盖回去，用户看到「选了 360p 却仍在放 1080p」。

修复：用 `WeakMap` 给每个元素记请求序号，只有序号仍是最新时才写入 blob URL。
同时把错误 `dispatchEvent` 也加同一道检查（否则旧请求失败会误报错误）。

**验证**：播放中切到 1080p，`videoWidth` 从 640 变为 1920，`readyState 4`。

### 19. 页面顶到状态栏下面

**现象**：首页标题、播放页控件都被系统状态栏（时间、信号、电量）压住。

**根因**：`targetSdk = 36`。Android 15（API 35）起，`targetSdk >= 35`
的应用**强制 edge-to-edge**：窗口默认铺满整屏，绘制到状态栏后面。

页面本身写得对：`web/index.html` 有 `viewport-fit=cover`，
`web/src/styles/index.css:177` 有 `padding-top: env(safe-area-inset-top)`。
但 WebView 只有在宿主声明「内容延伸到系统栏」时才向页面报告安全区，
否则一律报 **0**。实测 `env(safe-area-inset-top)` 返回 `0`，
所以那个 padding 在壳里等于没写。

**修复**：`onCreate` 里调 `window.setDecorFitsSystemWindows(false)`。

**为什么不在原生侧写死一个状态栏高度**：那样与页面的
`env(safe-area-inset-*)` 会叠加成双倍留白，而且横屏时状态栏高度不同。
交给系统报告真实安全区，页面自己的 CSS 就能生效。全屏时
`enterImmersive()` 隐藏系统栏，安全区自动变 0，不需要额外分支。

**验证**（1080x2400 / 420dpi）：修复前 `env(safe-area-inset-top)` 为 `0`、
`header` 高 57px、`top` 为 0；修复后安全区 **52px**、`header` 高 109px、
`top` 为 0（padding 在 header 内部，标题已下移到状态栏下方）。

### 20. 同一集并发请求会互相破坏文件

**现象**：播放页会预取下一集（`player-route.tsx` 的 `prefetchMedia`），
同时点下载按钮、或切档后快速切回时，`shouldInterceptRequest`
会在后台线程池里并发处理同一个 URL。

**根因**：`handleVideo` 先查缓存，未命中就下载到
`cacheDir/video-<sha256>.mp4`。两路同时进来时：

1. `FileOutputStream` 会把文件截断重写，两路交叠写入可能交错损坏；
2. 先完成那一路把 `FileInputStream` 交给 WebView，后一路把文件截断，
   WebView 读到一半就断。

引用计数解决不了这个：它只保证「已经在读的文件不被淘汰」，
不管「正在写的文件被另一路同时写」。

**修复**：

1. `downloadLocks`：`ConcurrentHashMap<String, Any>` + `computeIfAbsent`，
   同一个 URL 拿到同一把锁，下载串行化。
2. 锁内重新查一次缓存：第二个请求进来时第一路已经写完，直接命中，
   不重复下载。
3. `releaseLock()` 在缓存已写好时删锁（后来者走快路径命中，不需要锁）；
   下载失败时保留锁，重试接着用同一把。用 `try/finally` 而不是
   `synchronized { }.also { }`——块里有两个提前 `return`，`.also` 不执行，锁会漏。
4. `evictUnused(keep)` 新增 `keep` 参数：刚写入那一份还没被 `videoResponse`
   加计数，但绝对不能删，否则紧接着的 `FileInputStream` 会抛
   `FileNotFoundException`。

**验证**：用 XHR 绕过 JS 层缓存，8 路并发打原生 `/api/video`（同一集 720p）：

```
XHR 8 路并发: {"rs":["200:12870860","200:12870860",...×8],"ms":2622}
logcat:
  D HgVideo : downloaded 12870860B in 2364ms        ← 只有 1 次真实下载
  D HgVideo : cache hit after lock 12870860B        ← 另外 7 次
  ...（共 7 条 cache hit，7 个不同线程 ID 25149/25150/25151/25152/25155/25423/25424）
```

7 个不同线程 ID 证明这确实是 8 个并发线程，其中 7 个在等锁，等到了直接命中。

### 21. 首帧还没到就弹「播放停滞，正在自动重新加载」

**现象**：点进播放页，画面中央出现「播放停滞，正在自动重新加载」，
背景是已经解码的一帧。网络正常时不出现，网络慢时必现。

**采样**（每 1 秒读一次 `readyState` / `paused` / `currentTime`）：

```
t=18ms    rs=0 paused=true  ct=0 buf=0
t=1022ms  rs=0 paused=false ct=0 buf=0     ← play() 已调，字节未到
t=20124ms rs=0 paused=false ct=0 buf=0     ← 浮层弹出
```

**根因**：两层叠加，都不是 web 的错。

1. **`paused` 的语义**。页面的 `isStalled()`
   （`web/src/features/player/playback-error.ts:129`）只看
   `!video.paused` 与 `currentTime` 是否 20 秒未变。但
   `HTMLMediaElement.play()` 一被调用，`paused` **立刻**变 false，
   哪怕一个字节都没到。于是「等待首帧」被算成「播着播着卡住」。

   壳内这条路径比浏览器慢得多：要先经 OkHttp 把整集下载到本地、
   再用 WebCrypto 解密，首帧前本来就要等很久。实测 1080p 一集
   24 MB，网络差时下载 91 秒。

2. **预取抢带宽**。播放页会预取下一集
   （`web/src/features/player/prefetch-next.ts`），发一个
   `range: bytes=0-1` 的请求。适配层收到后仍要完整下载 + 解密整集，
   所以它和当前正在播的那一集争同一份带宽。实测
   `lock released, locks=2 cache=1`——进播放页时同时有两个下载。

**修复**（都在 `hg-adapter.js`，未改 `web/src`）：

1. `installPausedSemantics()`：接管 `HTMLMediaElement.prototype.paused`。
   - `play()` 时若 `readyState < 2`，把元素记进 `awaitingFirstFrame`。
   - getter 在「已请求播放 + `readyState < 2`」时返回 `true`，
     其余情况返回原生值。
   - `pause()` 时立刻移出集合，用户主动暂停必须如实返回 `true`。
   - `play()` 的 Promise 被拒时也移出，否则按钮会永远显示「播放」。

   页面读 `video.paused` 只有两处：停滞判定（要修的）和
   播放/暂停切换。后者语义上也是对的——首帧未到时按钮该显示「播放」
   而不是「暂停」。`playing` 这个 React 状态走 `play`/`pause` 事件，不受影响。

2. `waitForFirstFrame()`：预取请求（带 `range: bytes=0-1`）先等
   「有 `<video>` 且 `readyState >= 2`」再开始，上限 30 秒。
   超时后照常发请求——用户停在列表页时不能让预取永久挂起。

**为什么不改 `web/src`**：`isStalled` 缺的是 `readyState` 判据，
但本轮的约束是不动 web 源码。壳内修 `paused` 语义能达到同样效果，
且对浏览器与壳都成立——「还没拿到第一帧」本来就不该算「正在播放」。

**验证**（`pm clear` 清空全部数据后冷启动）：

| 项                        | 修复前    | 修复后                   |
| ------------------------- | --------- | ------------------------ |
| 浮层首次出现              | 20,124 ms | **未出现**               |
| `paused` 在 `rs=0` 时     | `false`   | **`true`**               |
| 并发下载数（`locks=`）    | 2         | **0**                    |
| 播放中 `paused`（`rs=4`） | `false`   | `false`（不回归）        |
| 暂停 → 恢复               | —         | `true` → `false`（正确） |
| `currentTime` 推进        | —         | 6.21 → 11.21（5 秒）     |

3 次连续冷启动进 `/watch/<id>`：浮层均未出现。

**仍未解决的**：首帧等待本身没有变短。网络 89 KB/s 时 24 MB 要 94 秒，
这是物理限制，不是代码问题。修复只保证「等待期间不误报停滞」，
以及「预取不跟当前集抢带宽」。真要缩短首帧，需要服务端支持 Range
分段响应（端上是「下载整集再解密」，无法边下边播）。

## 五、未解决项

本轮无。

## 六、上游数据依赖说明

同一集的 sprite 在 server 与壳内行为一致：有 `big_thumbs` 时两边都返回 200，
无时两边都 404。实测对比：

| episodeId             | server `/api/sprite`   | 壳内 `/api/sprite`     |
| --------------------- | ---------------------- | ---------------------- |
| `7600696808167181374` | 200（1181 帧 / 12 张） | 200（1181 帧 / 12 张） |
| `7703837727787060248` | 404                    | 404                    |

这是上游数据缺失，不是适配层缺陷。

## 七、测试方法注意事项

以下三条是实测踩过的坑，会把人误导成「功能坏了」：

1. **`Input.dispatchMouseEvent` 不算用户手势**。用它点全屏按钮，
   `requestFullscreen()` 抛 `Permissions check failed`；换
   `Input.dispatchTouchEvent` 才成功。判断手势类功能必须用触摸事件。

2. **双击间隔要 ≥ 200 ms**。CDP 连发两次 `touchStart/touchEnd`，间隔
   120 ms 与 180 ms 都会失败，220 ms 成功。页面的双击判定窗口是 240 ms，
   间隔太短会被浏览器合并。

3. **`Input.insertText` 不触发 React 合成事件**。用它填搜索框，
   页面 state 不变；必须用 `Input.dispatchKeyEvent` 逐字符
   `keyDown` / `char` / `keyUp`。另外 `char` 与 `keyDown` 同时带 `text`
   会重复插入（实测得到「大大明明」），只保留一个。

4. **`fetch('/api/video?url=...')` 在页面上下文里返回 404 是预期行为**。
   适配层的 fetch 拦截器先命中，`/api/video` 不在它的 12 个路由里，所以回
   `not_adapter`。真实路径是 `shouldInterceptRequest` 原生拦截，适配层内部用
   保存的 `realFetch` 发请求。手工验证 `/api/video` 必须走适配层的
   `downloadBytes`，不能直接用页面 `fetch`。

5. **按钮文案要以实际 DOM 为准**。详情页的播放按钮是「继续看第 N 集」不是
   「开始观看」；倍速菜单是「1.5×」不是「1.5 倍」。用假设的文案找元素会得到
   空结果，误判成「功能坏了」。先 `JSON.stringify([...document.querySelectorAll('button')]
.map(b => b.innerText))` 列一遍。

6. **播放器控件会自动隐藏**。单击画面是**切换**控件显隐，不是「唤出」。
   要稳地点到全屏按钮，得循环「检查按钮 `width>0` 且 `pointer-events==='auto'`，
   不满足就点一次画面」，最多 8 轮。一次盲点会点到隐藏方向。

## 八、真机反馈的 4 项移动端体验修复

用户在真机上跑 release APK 后报出四项问题。以下按报出的顺序记录根因与实测数据。

### 22. 播放页底部露出一条浅色空白

**现象**：黑色视频区下方露出一条 `#f7f5f4`，再往下是系统导航栏。

**根因**：两处叠加。

1. `web/src/routes/player-route.tsx` 的外层容器用 `h-safe-screen`，
   即 `calc(100dvh - env(top) - env(bottom))`。容器比屏幕矮一个底部安全区，
   那段直接露出 `body` 背景。
2. 底部控件自己还有 `pb-safe`。安全区被扣了两次。

**修法**：外层改成 `h-dvh` 并压黑（`bg-scrim`），安全区只由底部控件负责。

**实测**：容器 `bottom` 915px，`innerHeight` 915px，`gap` **0**（修复前 52px）。
两种导航模式都验过：三键与手势模式 `gap` 都是 0。

### 23. 状态栏图标不跟随主题

**现象**：浅色主题下时间、信号、电量是白色，在白底上几乎看不见。

**根因**：状态栏底色其实是透明的（页面 `pt-safe` 把内容铺到状态栏后面），
真正的问题是从未设置 `APPEARANCE_LIGHT_STATUS_BARS`，系统一直画白色图标。

**修法**：适配层用 `MutationObserver` 监听 `<html data-theme>`，通过 `theme`
命令转告原生；原生设 `APPEARANCE_LIGHT_STATUS_BARS`。

**实测**：浅色主题下图标由白变深灰（截图 `/tmp/walk/44-light-statusbar.png`）。

**后续修正**：这一条只改了图标明暗，没改系统栏底色，因此深色主题下底部
导航栏仍然白着。见 #26。

### 24. 底部操作区被导航栏遮挡

**现象**：首页与其余列表页底部内容被三键导航栏 / 手势条压住。

**根因**：WebView 的 `env(safe-area-inset-bottom)` **恒为 0**。

| 导航模式 | 导航栏物理高度 | `env(bottom)` | `env(top)` |
| -------- | -------------- | ------------- | ---------- |
| 三键     | 126px          | **0**         | 52px       |
| 手势     | 63px           | **0**         | 52px       |

顶部能拿到、底部拿不到。`setDecorFitsSystemWindows(false)` 只解决顶部。

**修法**：

1. 原生 `ViewCompat.setOnApplyWindowInsetsListener` 监听
   `systemBars() or displayCutout()`，除以 `density` 转 CSS px，派发 `hg:insets`。
2. 适配层写 `--hg-inset-*` CSS 变量；另加 `insets` 桥接命令供首帧主动查询
   （页面首帧可能早于首次 inset 回调）。
3. `styles/index.css` 的工具类读变量，用 `max(var(...), env(...))` 回退。
4. 六个列表页的 `pb-24` 魔法数字换成 `pb-safe-page`
   （`5rem + 安全区`）。

**实测**：三键模式变量 48.00px（126 / 2.625），页面底部留白 128px；
手势模式变量 24.00px，留白 104px。切换导航模式后变量自动跟随。

### 25. 设置二级菜单 + 横向拖动调进度

**需求**：把音量、清晰度、倍速、画幅模式收进一个二级菜单（齿轮图标），
进度条保持常驻；另加横向拖动调进度，拖动时才显示 2px 细进度条。
不做纵向亮度/音量，不做双击左右快进。

**做法**：

1. 底部三层：**进度条常驻**（不随设置收起）、主行（齿轮 / 选集 / 全屏）、
   设置面板（画幅 + 音量 + 清晰度 + 倍速）。
   用 `hidden` 而不是卸载——卸载会丢掉 `DefinitionMenu` / `SpeedMenu` 的
   `anchor` 引用，弹层会失去定位基准。

   进度条为什么不收起：它是播放页最核心的信息，收起后用户只能靠手势盲拖。
   设置面板为什么收起：这四项都是低频开关，常驻会挤窄进度条并遮住画面。

2. **音量滑块常显**（`VolumeControl` 新增 `inline`）。原来的滑块要展开，
   展开依赖两条路径：鼠标悬停，或点击滑块本身。触屏没有悬停；滑块收起时
   宽度是 0（`w-0`），点击也点不到。两条路径同时失效，用户只看到喇叭按钮，
   反馈「只能开和关，调不了音量」。实测：`inline` 前滑块父容器宽 0，
   `inline` 后宽 145px，从 15% 拖到 72% 音量由 1 变为 0.74。
   `allowSlider` 仍由设备能力决定，iOS 的 `video.volume` 只读，不渲染滑块。

3. 新增 `seek-drag.ts`（纯逻辑）与 `use-seek-drag.ts`（hook）。
   与 `useGestures` 共用同一个 `pointerdown`，靠**方向锁定**分工：
   横向位移超过 24px 且明显偏横（`absX > absY * 1.2`）时接管，
   否则一声不响，让给上/下滑切集与单击。
4. 灵敏度固定 `90 / 360` 秒每像素（约 90 秒/屏宽），不用片长百分比——
   短剧一集只有 1–3 分钟，百分比模式会让一屏拖过半个片子。
5. `duration <= 0` 时手势不接管：没有总长无法夹取。
6. 拖动期间暂停播放，松手 seek 后恢复；`pointer-events-none` 加在浮层上，
   否则浮层会抢走后续 `pointermove` 让拖动中断。
7. 浮层加 `pt-safe`。视频铺满整屏（edge-to-edge），`top-0` 会让 2px 细进度条
   压在状态栏下面——实测被 51.81px 的状态栏完全遮住，截图里看不到。
   加 `pt-safe` 后实测 `top=51.8`，正好落在状态栏下沿。

**实测**：

| 项                 | 数据                                                  |
| ------------------ | ----------------------------------------------------- |
| 收起后可见控件     | 3 个（齿轮 / 选集 / 全屏）                            |
| 收起后进度条       | **可见**，宽 310px                                    |
| 展开后可见控件     | 9 个（新增适应 / 裁剪 / 拉伸 / 静音 / 清晰度 / 倍速） |
| 展开后面板内容     | 画幅（适应·裁剪·拉伸）、音量、清晰度 1080p、倍速正常  |
| 拖动中浮层         | `3:32 / 6:09` + `+38 秒`，2px 细进度条出现            |
| `currentTime` 变化 | 79.56 → 140.46（+60.9 秒）；0.15 → 49.02              |
| 松手后浮层         | 消失（`span` 里无「秒」字样）                         |

### 26. 系统导航栏底色不跟随页面主题

**现象**：深色主题下，底部系统导航栏是一条白带，看起来像「底部导航栏还占着
空间」。用户以为是页面留白没算对。

**判断纠正**：不是留白。实测深色主题下 `pb-safe-page` 计算值 128px（`5rem` +
48px inset），末行底边 755px，导航栏上沿 866px——留白绰绰有余。白带是**导航栏
自己白着**。

**根因**：主题是 `Theme.AppCompat.NoActionBar`（浅色），`android:navigationBarColor`
默认取系统浅色。代码里只有 `enterImmersive()` 设过 `Color.BLACK`，而且只在全屏
时设；日常状态从未设过。`exitImmersive()` 也不还原，所以退出全屏后导航栏会永久
停在黑色——浅色主题下变成一条黑带，是同一个 bug 的另一面。

**修法**：

1. `applyStatusBarAppearance(lightSurface)` 同时涂 `statusBarColor` 与
   `navigationBarColor`（浅色 `#f5f5f7` / 深色 `#08080a`），并同时设
   `APPEARANCE_LIGHT_STATUS_BARS | APPEARANCE_LIGHT_NAVIGATION_BARS`。
2. 新增字段 `lastLightSurface`，`theme` 命令里记录；`exitImmersive()` 末尾调
   `applyStatusBarAppearance(lastLightSurface)` 还原。不重新问页面——那是异步
   往返，会闪一帧错色。
3. `onCreate` 先按深色涂一次，消掉页面加载前的浅色闪烁（页面默认主题是深色）。

**实测**：

| 场景               | 结果                                    | 截图                             |
| ------------------ | --------------------------------------- | -------------------------------- |
| 全新安装，深色主题 | 导航栏 `#08080a`，与页面同色，无白带    | `/tmp/walk/86-navbar-fixed.png`  |
| 浅色主题           | 导航栏 `#f5f5f7`，图标深色              | `/tmp/walk/87-navbar-light.png`  |
| 浅色主题进全屏     | 915x412 `landscape-primary`，系统栏隐藏 | `/tmp/walk/89-fs-light.png`      |
| 浅色主题退全屏     | 导航栏还原成浅灰，**不是黑**            | `/tmp/walk/90-exit-fs-light.png` |
| 深色主题退全屏     | 导航栏还原成深色                        | `/tmp/walk/91-exit-fs-dark.png`  |
| 深色主题滚到底     | 导航栏与页面同色，无白带                | `/tmp/walk/92-dark-bottom.png`   |

滚到底的数值：`pb-safe-page` 128px、inset 48.00px、末行底边 755px、视口 915px、
导航栏上沿 866px。

**后续修正（见 #27、#28）**：这一条涂色的做法在 `targetSdk = 36` 上无效——
`statusBarColor` 从 Android 15 起已废弃。现在改成透明 + 窗口背景着色。

### 27. 首页标题上方多出一段空白（红框）

**现象**：深色主题首页，标题上方有一段约 52px 的空白。用户圈出红框问「是留给
状态栏的还是」。

**判断纠正**：不是页面多留白，是**状态栏本身加上 `header` 为避开它写的
`pt-safe`**。状态栏高 51.81px，`header` 的 `padding-top` 也是 51.81px，两者不
重复预留；看起来「多出来」是因为状态栏图标居中后下方还剩约 20px。

**根因**：之前用 `setDecorFitsSystemWindows(false)` 让页面拿真实安全区，再让
页面用 `padding` 避开系统栏。页面容器仍然铺满整屏，滚动内容会从导航栏下面穿过，
状态栏区域也成了页面的一部分。

**修法**：改由原生管空间。`applyWindowInsetsToWebView()` 把
`systemBars() or displayCutout()` 的四个边设成 WebView 的 **margin**，CSS
viewport 跟着缩小。页面侧加 `hg-native-insets` 类，把 `.pt-safe` / `.pb-safe`
归零、`.pb-safe-page` 改成 `5rem`、`.h-safe-screen` 改成 `100dvh`。

**两个必须避开的坑**：

1. **不能用 `setPadding()`**。WebView 内部是独立渲染 surface，padding 只裁绘制
   区域，CSS viewport 不变。实测加 padding 后标题直接压到状态栏上。
2. **全屏期间不能改 WebView 布局参数**。全屏时 WebView 已 `GONE`，改 margin 会
   触发 `root` 重排，WebView 认为自身尺寸变化，立刻取消 DOM 全屏——实测进入全屏
   256ms 后自动 `onHideCustomView()`。

**实测**：视口 815px = 915 − 51.81 − 48.00；`header` 的 `padding-top` 0px；
`.pb-safe-page` 80px；首页标题紧贴状态栏下方；滚到底末行底边 703px、视口 815px。
截图 `/tmp/walk/99-margin.png`、`/tmp/walk/113-dark-top.png`。

### 28. 浅色主题下状态栏是黑的

**现象**：浅色主题首页，页面浅灰但状态栏仍是纯黑，深色图标看不见。

**根因**：`targetSdk = 36`。Android 15（API 35）起 `window.statusBarColor` /
`window.navigationBarColor` 已废弃，赋值不再生效。`applyStatusBarAppearance()`
里涂 `#f5f5f7` 的那两行被系统忽略。

**修法**：改成透明 + 窗口背景着色。

1. `window.statusBarColor = Color.TRANSPARENT`（`navigationBarColor` 同）。
2. `window.setBackgroundDrawable(ColorDrawable(页面底色))`——浅色 `#f5f5f7`、
   深色 `#08080a`。系统栏在 WebView 的 margin 之外，不会被页面覆盖，靠窗口背景
   着色即可。
3. 图标明暗仍单独管：`APPEARANCE_LIGHT_STATUS_BARS |
APPEARANCE_LIGHT_NAVIGATION_BARS`。

**实测**：浅色主题状态栏与导航栏均为浅灰、图标深色（截图
`/tmp/walk/115-light-transparent.png`）；深色主题均为深色（`/tmp/walk/116-dark-transparent.png`）。

### 29. 应用名与图标

**改动**：`android:label` 从「红果壳」改为「红果」；新增自适应图标
`res/mipmap-anydpi-v26/ic_launcher.xml` + 前景/背景 drawable。

**图标形状**：白色苹果剪影（圆身 + 短柄 + 单片叶）+ 与背景同色的镂空播放三角。
第一版是红底白三角，装上桌面后与 YouTube 无法区分——红底白三角是 YouTube 的
既有视觉资产。第二版叶子画得太大（横向 43dp），圆形裁剪下像兔耳朵、整体像杯子。
最终版叶子宽度压到果身一半以内。

**配色**：背景红渐变 `#fb3b5c → #e11d48 → #9f1239`，取自 `styles/index.css` 的
`--color-accent`（`#e11d48`）与 `--color-accent-soft`（`#fb7185`）。产品配色参考
`ui-ux-pro-max` 的 Video Streaming/OTT 档案：「Cinema dark + play red」。

**实测**：桌面与应用抽屉均显示「红果」，图标为红底白色苹果（截图
`/tmp/walk/112-icon-v3-zoom.png`、`/tmp/walk/109-icon-v2.png`）。

### 30. 全屏下切集/换清晰度会退出全屏，倍速与画幅丢失

**现象**：全屏状态下点「下一集」，画面退回竖屏窗口态；倍速回到 1×，画幅回到「适应」。

**实测数据（修复前）**：

| 时刻       | `fullscreenElement` | 方向                | 视口    | `playbackRate` | `objectFit` |
| ---------- | ------------------- | ------------------- | ------- | -------------- | ----------- |
| 全屏中     | `DIV.player-shell`  | `landscape-primary` | 915×412 | 1.5            | `cover`     |
| 切集 +0.3s | `null`              | `landscape-primary` | 915×412 | 1              | —           |
| 切集 +2.0s | `null`              | `portrait-primary`  | 412×863 | 1              | `contain`   |
| 切集 +5.0s | `null`              | `portrait-primary`  | 412×815 | 1              | `contain`   |

**根因一：全屏元素在会被卸载的子树里。** 两个卸载源都实测过：

1. `player-route.tsx` 的 `<Player key={playback.episodeId}>`——换集时 `key` 变，
   `Player` 整体卸载重挂，`containerRef` 指向的 `.player-shell` 被移出文档，
   浏览器自行退出全屏。
2. `awaitingDefinition` 为真时整块换成「正在切换到记住的清晰度…」占位——
   切清晰度同样让 `Player` 卸载。实测从 1080p 切 480p，`fullscreenElement` 变
   `null`，`video` 标记从 `V1` 变 `NEW`。

**为什么不能「退出后自动重新进全屏」**：WebView 在无用户手势时不允许
`requestFullscreen()`。实测等待 7 秒（超过 5 秒临时激活窗口）后再请求，
报 `TypeError: Permissions check failed`。所以只能让全屏元素**不被卸载**。

**修法**：全屏目标上提到路由层的 `.player-host`。新增可选 prop
`PlayerProps.fullscreenTarget`，`useFullscreen` 用它替代自己的 `containerRef`。
这个 `div` 包住播放器与全部占位文案，在整个播放页生命周期内不卸载。
`use-fullscreen.ts` 的 `active` / `enteredByUs` 初值改为读一次当前全屏状态，
否则重挂后的新实例会以为没在全屏，按钮显示「全屏」而不是「退出全屏」。

**根因二：倍速只写了 `playbackRate`。** 新的媒体资源加载完成时，浏览器把
`playbackRate` 恢复成 `defaultPlaybackRate`（新元素是 1）。实测对照：

| 写法                                | 加载完成后 `playbackRate` | `defaultPlaybackRate` |
| ----------------------------------- | ------------------------- | --------------------- |
| 只写 `playbackRate = 1.5`（修复前） | **1**                     | 1                     |
| 同时写 `defaultPlaybackRate = 1.5`  | **1.5**                   | 1.5                   |

**修法**：`setSpeedTo` 与同步 effect 都同时写 `defaultPlaybackRate` 与
`playbackRate`。长按 2× 仍只改 `playbackRate`，不改基准值，所以松手能回到用户
选的档位而不是回到 2×。

**根因三：画幅模式只存在组件 state。** 重挂后回到 `contain`。
**修法**：加进 `PlayerPreferences`（`frameMode`），与倍速、音量一样落盘。
`sanitizeFrameMode` 只接受三个合法值，存档被改坏时回 `undefined`（= 默认），
而不是替用户默默选一个他没点过的画幅。

**实测数据（修复后，release APK）**：

| 时刻                         | `fullscreenElement` | 方向                | 视口    | `playbackRate` | `objectFit` |
| ---------------------------- | ------------------- | ------------------- | ------- | -------------- | ----------- |
| 全屏中                       | `DIV.player-host`   | `landscape-primary` | 915×412 | 1.5            | `cover`     |
| 切集 +0.5s                   | `DIV.player-host`   | `landscape-primary` | 915×412 | 1.5            | `cover`     |
| 切集 +7.5s                   | `DIV.player-host`   | `landscape-primary` | 915×412 | 1.5            | `cover`     |
| 全屏下切 480p 后             | `DIV.player-host`   | `landscape-primary` | 915×412 | 1.5            | `cover`     |
| 连续再切 3 集（第 3/4/5 集） | `DIV.player-host`   | `landscape-primary` | 915×412 | 1.5            | `cover`     |
| 退出全屏                     | `null`              | `portrait-primary`  | 412×815 | 1.5            | `cover`     |

连切 3 集时每集均 `readyState 4`、`paused false`、`video.error null`。

**顺带确认未受影响的项**：音量（0.35 跨集保持）、封面（`naturalWidth 400`）、
`/api/sprite` 200、退出全屏后系统栏恢复（原生截图
`/tmp/walk/131-exit-fs-native.png` 可见状态栏与三键导航栏都回来）。

### 31. 竖屏看不到「下一集」；顶栏与底栏要 6 秒一起隐藏

**现象一**：手机竖屏下完全看不到切集按钮，用户只能靠上滑手势或选集抽屉，
两者都不是可发现的入口。

**根因**：切集按钮的 className 是 `absolute ... hidden h-11 ... lg:flex`。
`hidden` + `lg:flex` 意味着只有视口宽 ≥1024px 才渲染。实测 `getBoundingClientRect()`：

| 场景                      | 视口     | `上一集` / `下一集` 尺寸 |
| ------------------------- | -------- | ------------------------ |
| 手机竖屏                  | 412×815  | 0×0                      |
| 全屏横屏                  | 915×412  | 0×0                      |
| 桌面宽屏（对照，≥1024px） | 1280×800 | 有尺寸                   |

**修法一**：删掉画面两侧的宽屏胶囊，在底部主行插入一对图标按钮（`PrevIcon` /
`NextIcon`，各 44×44）。主行本来就常驻，按钮跟着它一起显隐；贴边浮在画面上的
胶囊会在控件隐藏后仍压在内容上。保留两个入口没有意义——同一动作两个入口，
且其中一个在手机上根本拿不到。

**竖屏实测坐标（412×815）**：

| 控件     | x   | y   | w   | h   |
| -------- | --- | --- | --- | --- |
| 返回     | 8   | 0   | 44  | 44  |
| 播放设置 | 16  | 763 | 44  | 44  |
| 上一集   | 130 | 763 | 44  | 44  |
| 下一集   | 178 | 763 | 44  | 44  |
| 选集     | 292 | 763 | 56  | 44  |
| 全屏     | 352 | 763 | 44  | 44  |

`overlaps: []`——遍历全部可见按钮两两求矩形相交，无重叠。主行左侧齿轮 44px、
右侧「选集 + 全屏」100px，412px 视口中间还有 232px 空隙，两个按钮共 88px。

**全屏横屏实测坐标（915×412）**：上一集 (382,360,44,44)、下一集 (430,360,44,44)，
同样 `overlaps: []`。

**切集实测**：

| 操作                       | `location.pathname`          | `readyState` | `paused` | `rate` |
| -------------------------- | ---------------------------- | ------------ | -------- | ------ |
| 竖屏点「下一集」（第 2→3） | `/watch/7697465495296953369` | 4            | false    | 1.5    |
| 竖屏点「上一集」（第 3→2） | `/watch/7697465811157404697` | 2→4          | false    | 1.5    |
| 全屏点「下一集」（第 2→3） | `/watch/7697465495296953369` | 4            | false    | 1.5    |

全屏下切集后 `fullscreenElement` 仍是 `DIV.player-host`、方向仍
`landscape-primary`、视口仍 915×412——上一轮的修复未回归。

**现象二**：播放页顶栏（返回 / 剧名 / 集号）与底部操作栏都该在无操作 6 秒后
一起隐藏。原延迟是 3200ms。

**修法二**：`HIDE_DELAY_MS` 改 `6000`。顶栏原本就与底栏共用同一个 `showControls`
状态，不需要另接一条控制链——实测两者每个采样点的 `opacity` 完全相等。

**自动隐藏实测（页内 16ms 采样 `getComputedStyle().opacity`）**：

| 场景         | `6000` 定时器调度 | 完全不透明 | 完全消失 | 可见窗口 |
| ------------ | ----------------- | ---------- | -------- | -------- |
| 竖屏 412×815 | +323ms            | +719ms     | +7029ms  | 6310ms   |
| 全屏 915×412 | +305ms            | +722ms     | +7180ms  | 6458ms   |

两个场景的采样序列里，`top` 与 `bottom` 的 `opacity` 在每一个变化点上都相等，
例如全屏场景 `{"ms":722,"top":1,"bottom":1}` → `{"ms":7180,"top":0,"bottom":0}`。
多出的约 200ms 是 `transition-opacity duration-200` 的淡出时间。

**唤出**：点画面一次，两者同时回到 `opacity: 1`；再点一次同时隐藏
（`onTap` 是切换语义，不是“只显示”）。

**锁源不隐藏实测**（每项采样 10–12 秒，`marks: []` 表示全程无变化）：

| 展开的内容                       | 采样时长 | `opacity` 变化 |
| -------------------------------- | -------- | -------------- |
| 设置面板（204px 高，7 个控件）   | 11s      | 无（保持 1）   |
| 倍速菜单（7 项 `menuitemradio`） | 10s      | 无             |
| 清晰度菜单（12 项）              | 10s      | 无             |
| 选集抽屉（785 集，分组头）       | 12s      | 无             |
| 进度条按住不放（`pointerdown`）  | 10s      | 无             |

`locks` 是 `Set<LockSource>`，不是布尔值：多个来源同时锁住时，任一来源释放
都不会把整把锁打开。这段逻辑是纯函数，已有单测覆盖（`controls-lock` 相关用例）。

**回归确认**：首页 12 张封面 `naturalWidth 400`；
`/api/sprite/7697465811157404697` 200（返回 `gridX/gridY/cellWidth/frameCount/sheetUrls`）；
下载落盘 `HgDownload: saved 7697469881821711385-360p.mp4 (2591021 B) -> .../downloads/32`；
倍速 1.5 与画幅 `cover` 跨集保持。

### 32. 换集后控件永久不隐藏（手动切集、自动连播、手动进全屏都会）

**现象**：进全屏后点「下一集」，顶栏与底栏就一直亮着，无操作多久都不消失。
手动切集、自动连播到下一集都一样。

**实测（修复前，全屏 915×412，切集后不操作）**：

| 时刻   | `top` `opacity` | `bottom` `opacity` | `location.pathname`          |
| ------ | --------------- | ------------------ | ---------------------------- |
| 切集前 | 1               | 1                  | `/watch/7697465811157404697` |
| +1.5s  | 1               | 1                  | `/watch/7697465495296953369` |
| +8.5s  | 1               | 1                  | `/watch/7697465495296953369` |
| +12.5s | 1               | 1                  | `/watch/7697465495296953369` |

**根因：重挂后没有任何人启动隐藏计时。** `player-route.tsx` 用
`<Player key={playback.episodeId}>`，换集时 `key` 变、`Player` 整体卸载重挂。
`showControls` 的初值是 `true`，而原代码只有这些地方调 `scheduleHide()`：
`revealControls()`、`onTap` 隐藏分支、`onScrubEnd`、`onLongPressEnd`、
`onDragEnd`、菜单关闭、`onFocusOut`。它们全是**用户交互**。重挂后没有任何
交互发生，就没人起计时。

注意这不是上一轮 #30 的回归：#30 把全屏元素上提到 `.player-host` 后不再退出
全屏，但 `Player` 本身仍然重挂，所以这条缺陷一直在。

**为什么不能改成「不换路由、只换 `src`」**：`Player` 确实已有 `src` 变化分支
（`useEffect([src, initialTime])` 重置状态、`useEffect([speed, src])` 重写倍速、
`useEffect([src])` 自动播放），但去掉 `key` 会丢掉 URL 与当前集同步、
`episodeLabel`、选集抽屉高亮、观看历史、`canPrev`/`canNext` 的推导。
缺陷只有一处，补一条 effect 即可。

**修法**：在 `player.tsx` 加一条挂载 effect：

```ts
useEffect(() => {
  scheduleHide();
}, [scheduleHide]);
```

依赖只写 `scheduleHide`：它的 `useCallback` 依赖只有 `clearHideTimer`，所以不会
因 `src` 变化而重建，这条 effect 一个挂载周期只跑一次。

**实测（修复后，release APK，页内 20ms 采样 `getComputedStyle().opacity`）**：

| 场景                                | `6000` 定时器调度 | 开始淡出 | 完全消失 | 可见窗口 |
| ----------------------------------- | ----------------- | -------- | -------- | -------- |
| 竖屏手动进全屏（412×815 → 915×412） | +76ms             | +6114ms  | +6290ms  | 6176ms   |
| 全屏点「下一集」（第 2→3）          | +94ms             | +6161ms  | +6321ms  | 6227ms   |
| 全屏自动连播到下一集（`ended`）     | +1060ms           | +7146ms  | +7332ms  | 6272ms   |
| 竖屏点「下一集」（第 4→5）          | +1143ms           | +7481ms  | +7647ms  | 6338ms   |

每个场景里 `top` 与 `bottom` 的 `opacity` 在每个采样点上都相等。四个场景的可见
窗口都在 6.1–6.3 秒，差异来自定时器调度时刻相对切集时刻的偏移与 200ms 过渡。

**切集后仍保持的项**（全屏场景实测）：`fullscreenElement` 仍是
`DIV.player-host`、方向 `landscape-primary`、视口 915×412、`playbackRate 1.5`、
`objectFit cover`、`readyState 4`、`paused false`。

**回归（修复后重测）**：

| 项                                    | 结果                     |
| ------------------------------------- | ------------------------ |
| 点画面切显隐（隐藏→显示→隐藏→显示）   | `0→1→0→1`，与底栏同步    |
| 设置面板展开（204px 高）              | 10s 无变化，`finalTop 1` |
| 倍速菜单展开（12 项 `menuitemradio`） | 10s 无变化，`finalTop 1` |
| 清晰度菜单展开（5 项）                | 10s 无变化，`finalTop 1` |
| 选集抽屉展开                          | 12s 无变化，`finalTop 1` |
| 进度条按住不放 10s                    | 10s 无变化，`finalTop 1` |

**测量陷阱（自己踩过）**：切集后顶栏元素会被 React 替换，采样器若在切集前就把
`getComputedStyle(el)` 的结果缓存到局部变量，切集后读到的就是已脱离文档的旧节点，
`opacity` 返回 `null`。采样回调里必须**每帧重新 `querySelector`**。

### 回归结果（release APK，干净安装）

| 项            | 结果                                                                             |
| ------------- | -------------------------------------------------------------------------------- |
| 首页封面      | 12/12 `naturalWidth > 0`                                                         |
| 适配层端点    | 14                                                                               |
| `/api/health` | 200 `mode: self-contained`                                                       |
| `/api/sprite` | 200，1181 帧 / 12 张                                                             |
| 播放          | `readyState 4`，1920x1080                                                        |
| 停滞浮层      | 未出现                                                                           |
| 全屏          | 915x412 `landscape-primary`，返回键退出回 412x915                                |
| 下载落盘      | `HgDownload: saved 7697465535398677529-360p.mp4 (3065286 B) -> .../downloads/29` |
| 系统栏空间    | 视口 815px = 915 − 51.81 − 48.00；`header` padding 0；`.pb-safe-page` 80px       |
| 应用名        | 红果                                                                             |

## 九、复现命令

```bash
export PATH=$HOME/Library/Android/sdk/platform-tools:$PATH
cd apps/hongguo/android

# 1. 构建并安装
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 2. 以自包含模式启动（走 assets，不走 Vite dev server）
adb logcat -c
adb shell am force-stop com.mlzwl.hongguo.shell
adb shell am start -n com.mlzwl.hongguo.shell/.MainActivity --es target index

# 3. 挂 CDP（PID 每次重装都会变）
sleep 30
PID=$(adb shell pidof com.mlzwl.hongguo.shell | tr -d '\r')
adb forward tcp:9333 localabstract:webview_devtools_remote_$PID

# 4. 截图
adb exec-out screencap -p > /tmp/shot.png
```

页面内调试入口：`globalThis.__hgAdapter`（`sdkCall` 直调 WASM SDK，`routes` 看已挂端点）。

### 33. 浅色主题下状态栏 / 导航栏图标仍是白色（真机症状）

**现象**：浅色主题下系统栏底色已经变浅灰，但时间、信号、电量、返回键仍是白色，
几乎看不见。用户报「手机上始终是白色」。

**根因**：**`theme` 命令每次都在后台线程抛异常，`applyStatusBarAppearance()`
从未执行到设置图标明暗的那一步。**

`installBridge()` 把每条桥接消息都丢进 `io.execute { handleBridgeMessage(...) }`。
`handleBridgeMessage` 的 `theme` 分支直接调 `applyStatusBarAppearance()`，里面
`window.setBackgroundDrawable()` / `window.statusBarColor` /
`window.insetsController?.setSystemBarsAppearance()` 全部是主线程 API。

`setBackgroundDrawable()` 不检查线程，侥幸生效——所以**底色看起来是对的**。
下一行 `setSystemBarsAppearance()` 抛 `CalledFromWrongThreadException`，
被 `handleBridgeMessage` 的 `catch (e: Throwable)` 吞掉并只打一行日志，于是
函数在「底色已改、图标未改」的半生效状态中断。

logcat 里每次主题切换都有：

```
E HgShell : bridge error: Only the original thread that created a view hierarchy
             can touch its views. Expected: main Calling: pool-3-thread-4
```

同一个缺陷也让 `insets` 命令失效（`currentInsets()` 读 `getRootWindowInsets()`）。

**修法**：

1. `installBridge` 先判断命令类型：`theme` / `insets` 在主线程直接处理，
   其余（网络请求、下载）继续走 `io` 线程池。这两条命令都不做 IO。
2. 新增 `isMainThreadCommand(data)`，只扫消息开头 64 个字符找 `"op":"<名字>"`，
   不解析整条 JSON——网络请求体里可能带几十 KB 的 base64，为了分派再解析一遍
   是白白多一次拷贝。
3. `applyStatusBarAppearance()` 里加防御：检测到不在主线程就 `post` 回主线程再涂，
   并打一条 warning。这样即使将来分派逻辑被改坏，也不会再出现「底色变了图标没变」。

**实测（release APK + debug 签名，API 36 模拟器 1080x2400 / 420dpi）**：

| 场景                         | 状态栏图标               | 导航栏图标 | 状态栏底色 | 导航栏底色 |
| ---------------------------- | ------------------------ | ---------- | ---------- | ---------- |
| 深色（修复后）               | 白                       | 白         | `#08080a`  | `#08080a`  |
| 浅色（修复后）               | 深灰                     | 深灰       | `#f5f5f7`  | `#f5f5f7`  |
| 浅色，冷启动（localStorage） | 深灰                     | 深灰       | `#f5f5f7`  | `#f5f5f7`  |
| 浅色，详情页                 | 深灰                     | 深灰       | `#f5f5f7`  | `#f5f5f7`  |
| 浅色，手势导航               | 深灰                     | 深灰手势条 | `#f5f5f7`  | `#f5f5f7`  |
| 浅色 → 深色 回切             | 白                       | 白         | `#08080a`  | `#08080a`  |
| 系统 `uimode night yes`      | 跟随页面主题，不跟随系统 | —          | —          | —          |

修复后 logcat 里 `bridge error` 计数为 **0**（修复前每次切换至少 2 条）。

**为什么手机上「始终」是白色**：这条缺陷与设备无关，与模拟器也无关。修复前
在任何设备上图标都不会跟随，只有底色会。用户看到的现象与代码缺陷完全一致。

### 34. 浏览器访问时 `theme-color` 不跟随主题

**现象**：用浏览器打开 `:9133` 时，浅色主题下移动端地址栏/状态栏仍是深色。

**根因**：`web/index.html` 写死 `<meta name="theme-color" content="#0a0a0a">`，
且这个值既不是深色主题的 `#08080a`，也不随主题变化。

**修法**：

1. `theme-store.ts` 导出 `THEME_SURFACE`（`dark: '#08080a'` / `light: '#f5f5f7'`），
   与 `styles/index.css` 的 `--color-surface` 保持一致。
2. `index.html` 写两条带 `media` 的 meta：浅色 `#f5f5f7`、深色 `#08080a`。
   主题确定前浏览器按系统配色自己挑一条，不会先涂错色。
3. `applyTheme()` 把**所有** `theme-color` 的 `content` 改成解析后的值。
   只改一条不够：用户手动选的主题优先级高于系统，另一条带 `media` 的仍会命中。

**实测（Chromium，`pnpm hongguo:start` 单端口）**：

| 场景                              | `data-theme` | 两条 meta 的 `content` | `body` 背景          |
| --------------------------------- | ------------ | ---------------------- | -------------------- |
| 系统浅色，无偏好                  | `light`      | 都是 `#f5f5f7`         | `rgb(245, 245, 247)` |
| 系统深色，无偏好                  | `dark`       | 都是 `#08080a`         | `rgb(8, 8, 10)`      |
| 系统浅色，手动切到深色            | `dark`       | 都是 `#08080a`         | `rgb(8, 8, 10)`      |
| 系统深色，手动切到浅色            | `light`      | 都是 `#f5f5f7`         | `rgb(245, 245, 247)` |
| 刷新（localStorage 记住 `light`） | `light`      | 都是 `#f5f5f7`         | `rgb(245, 245, 247)` |

App 内不受这条影响：WebView 不读 `theme-color`，系统栏由第 33 条的
`applyStatusBarAppearance()` 管。
