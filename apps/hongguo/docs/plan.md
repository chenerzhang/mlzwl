# 红果客户端改进计划

本文是**计划**，不是实现记录。已实现的验证事实写在 `docs/implementation-notes.md`。

内容来源：对 5 个红果相关开源仓库的源码阅读。仓库固定在以下提交，本地副本在
`.tmp/hongguo-repo-review/`（不提交）。

| 仓库             | 提交                                       | 许可证                                         | 可用性                                 |
| ---------------- | ------------------------------------------ | ---------------------------------------------- | -------------------------------------- |
| `hongguoTV`      | `eea73e6a45569a2cbbb9440f7cd5290c459b0b70` | GPL-3.0-only                                   | 只借鉴设计，不复制代码                 |
| `danmu_api`      | `f47b786876f2ab51ef69518e5e0b1c0574664589` | `package.json` 写 ISC，`LICENSE` 实为 AGPL-3.0 | 只借鉴协议，不复制代码                 |
| `hongguo-drama`  | `84b6e88e65374942c123a53c7d6ad9e78bcd101b` | GPL-3.0                                        | 只借鉴设计，不复制代码                 |
| `guoapp`         | `0e60928514c31a96ade9b31866948f15da5ca2a6` | 无许可证文件                                   | 只作接口线索，不复制代码               |
| `hongguo-player` | `f71f66b2ce9a8997bf62cadefaf3abfc4db0fcbd` | 无许可证文件                                   | 该提交只有 README 与截图，无可审计源码 |

下文每个条目都给出**来源文件**。路径相对 `.tmp/hongguo-repo-review/`。

---

## 0. 分级标准与写作约定

| 级别   | 判定条件                                                                         |
| ------ | -------------------------------------------------------------------------------- |
| **P0** | 当前实现存在**用户可见的错误**或**数据契约缺陷**。不修就会出错，或错误难以察觉。 |
| **P1** | 当前功能可用，但缺少**稳定性、可诊断性或体验细节**。改动局部，收益明确。         |
| **P2** | 新增能力或长期演进。需要新的数据源、新的界面或跨模块改造。                       |

两个标记贯穿全文：

- **【源码】**：该仓库里有可直接对照的实现，行为已被其测试覆盖。
- **【推导】**：由源码行为推出的扩展建议。本仓库未实现，参考仓库也未验证。

**许可证边界**：`hongguoTV`、`hongguo-drama` 是 GPL-3.0，`danmu_api` 是 AGPL-3.0，
`guoapp` 无许可证。本仓库是 MIT。**不得复制这些仓库的源码、常量表或注释文本**。
允许的做法是读懂行为后，用本仓库的技术栈重新实现，并在提交信息里写明设计来源。
任何"照搬 + 加 NOTICE"的做法都不成立。

---

## 1. P0：播放正确性与数据契约

### P0-1 清晰度按短边判定，不按 `height`

- **来源**：`hongguo-drama/src/native/download-quality.js` 的 `meetsDownloadQuality()`。
  它取 `Math.min(width, height)` 与目标档位比较。**【源码】**
- **现状**：`server/src/media/playback.service.ts` 的 `resolutionOf()` 优先返回 `stream.height`。
- **差距**：竖屏短剧是 `540×960`。按 `height` 排序会得到 960，被误判为高于 720p，
  默认选档和"可用清晰度从低到高"的排序都错。
- **做法**：
  1. `resolutionOf()` 改为有 `width` 和 `height` 时返回 `Math.min(width, height)`。
  2. 只有一个维度时用它，但记录一条 warn 日志，便于发现上游字段缺失。
  3. 两者都缺时回退解析 `definition` 的数字。
- **验证**：`media/` 目录已有 `cenc.test.ts`、`range.test.ts` 的 vitest 惯例，可新增
  `playback.service.test.ts` 覆盖 3 种输入（横屏、竖屏、只有 definition）。
  另需手工请求一部竖屏剧的 `GET /api/episodes/:id/playback`，确认 `definition` 与 `width/height` 自洽。

### P0-2 `streamUrl` 必须绑定所选清晰度

- **来源**：`guoapp/native/core/app_playback_routes.go` 的 `nativePlaybackChoices()`。
  它把 `quality` 作为选择结果的一部分，播放地址与清晰度是同一个决策对象。**【源码】**
- **现状**：`server/src/media/media.controller.ts` 返回固定的
  `streamUrl: /api/media/:id`，不带 `definition`；`GET /api/media/:episodeId` 调用
  `this.playback.resolve(episodeId)` **不带** `preferredDefinition`。
- **差距**：请求 `?definition=540p` 时，播放信息说 540p，实际媒体流走默认选档。
  用户看到的档位与实际文件不一致。缓存文件名带清晰度，但入口参数丢失，缓存永远只命中默认档。
- **做法**：
  1. `streamUrl` 改成 `/api/media/:id?definition=<选定的 definition>`。
  2. `GET /api/media/:episodeId` 用 `PlaybackQuerySchema` 解析 `definition` 并传给 `resolve()`。
  3. `HEAD` 同样处理，保持与 `GET` 一致。
- **验证**：对同一集分别请求 `?definition=360p` 与 `?definition=1080p`，确认返回的
  `content-length` 不同，且 `data/media/` 下出现两个文件名。这是唯一能证明"参数真的生效"的证据。

### P0-3 使用 `backup_url` 作为备用源

- **来源**：`apps/hongguo/server/node_modules/openhongguo/types.d.ts` 的 `Stream.backup_url`
  （注释写明"同一文件的第二个 CDN 地址"）；`guoapp/native/core/app_playback_routes.go`
  把多个候选地址去重后组成线路列表。**【源码】**
- **现状**：`media-cache.service.ts` 的 `produce()` 只 `fetch(resolved.stream.url)`，
  `backup_url` 从未被读取（全仓搜索无命中）。
- **差距**：主 CDN 单点失败时整集无法播放，只能等用户手动重试。
- **做法**：
  1. `ResolvedPlayback` 增加 `urls: string[]`，按 `[url, backup_url]` 去重后填充。
  2. `produce()` 按顺序尝试，每个地址独立超时；全部失败时抛出带每个地址失败原因的聚合错误。
  3. **不得**在已经向浏览器返回 206 字节之后切换地址（见 P0-6）。
- **验证**：单元测试用本地 `127.0.0.1` mock 两个端点，第一个返回 500、第二个返回真实字节，
  断言最终文件正确、日志记录了两条尝试。**不得**用真实上游做失败注入。

### P0-4 下载超时、响应大小上限、有限重试

- **来源**：
  - `guoapp/native/core/network_media.go`（15 秒提前刷新预览 token、single-flight）
  - `guoapp/native/core/network_limiter.go`（按 host 的 `requestGate` 串行化与 backoff）
  - `hongguo-drama/src/native/hongguo.js` 的 `apiCall(path, body, retries = 3, timeout = 25000)`
  - `guoapp/native/core/app_preload.go` 的 `nativePreloadLimit = 4 << 20` 与
    `io.LimitReader(body, remaining+1)`（超限即放弃，不静默截断）**【源码】**
- **现状**：`produce()` 的 `fetch(url)` 没有 `AbortSignal`，没有 `content-length` 校验，
  `await response.arrayBuffer()` 会把任意大小的响应读进内存。
- **差距**：上游卡住时该集的 `inflight` Promise 永不结束，后续请求全部挂在同一个 Promise 上。
  上游返回错误页（HTML）时会被当成视频交给 `decryptCenc`，报出难以理解的解析错误。
- **做法**：
  1. `fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })`。
  2. 读取前校验 `content-type` 不是 `text/html`，`content-length` 不超过上限。
  3. 上限取"上游声明的 `stream.size` 的 1.1 倍"与一个硬上限（建议 200 MB）中的较大者；
     上游未声明时用硬上限。
  4. 重试 2 次，退避 1000 ms / 2500 ms（与 P0-5 的节奏一致）。4xx 不重试。
- **验证**：mock 三种响应——正常、`text/html`、超长 `content-length`。断言前两种的错误信息
  能区分"不是视频"与"体积超限"。

### P0-5 播放错误分类，而不是统一提示 HEVC 不兼容

- **来源**：
  - `guoapp/lib/playback_recovery.dart` 的 `PlaybackRecovery`（`alternative` → `refresh` → `stop`，
    `maxAttempts = 3`）与 `PlaybackHealth`（`stallTimeout = 20s`，仅在
    `playing && foreground && position 未变化` 时计时）**【源码】**
  - `hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/Watching.kt` 的
    `RecoveryBudget`（3 次，退避 `1000/2500/5000` ms，只有用户显式重试才 `reset()`）**【源码】**
- **现状**：`web/src/features/player/player.tsx` 的 `onError` 固定写
  "当前浏览器无法播放该视频（HEVC 编码需要 Safari / Edge / Chrome）"。
- **差距**：网络失败、上游 500、解密失败、编码不支持，四种原因给同一个提示。
  用户按提示换浏览器也不会好。
- **做法**：
  1. 服务端在错误响应里返回稳定的 `code`（`media_timeout` / `media_not_video` /
     `media_too_large` / `media_upstream_5xx` / `decrypt_failed` / `no_stream`），
     由 `ApiError` 透传到前端。
  2. 前端按 `code` 给文案与动作：可重试的给"重试"按钮；`decrypt_failed` 给"换一档清晰度"；
     编码问题才提浏览器。
  3. 增加停滞检测：`playing && !document.hidden && currentTime 20 秒未变` 时提示，
     并允许一次自动重载。**不要**自动无限重试。
- **验证**：mock 服务端返回各 `code`，断言前端文案与按钮出现。停滞检测用手工方式验证
  （DevTools 断网 20 秒）。

### P0-6 已经开始返回字节后不得切换媒体源

- **来源**：`hongguoTV/server/http.mjs`。它在 `writeHead` **之前**取第一块数据校验，
  校验失败时还能返回错误状态码；之后才写成功头并流式发送。同时用
  `activeStreams >= 4` 限制并发，超限返回 503。**【源码】**
- **现状**：`media.controller.ts` 在 `cache.get()` 完成后才写头，这一点是对的。
  但 `cache.get()` 内部一旦加入多地址重试（P0-3），必须保证"重试只发生在写头之前"。
- **差距**：若把重试放在 `createStream` 之后，浏览器收到的字节流会中途中止。
  Range 请求尤其危险：新源的字节偏移与旧源不同，续传会得到损坏的 MP4。
- **做法**：把"解析 + 下载 + 解密 + 落盘"整体视为**一个原子步骤**，在 `reply.send()` 之前完成。
  在 `media-cache.service.ts` 的注释里写明这条约束，避免后续改动破坏它。
- **验证**：代码审查 + 一条单测，断言 `produce()` 抛错时 controller 返回 5xx，而不是 200。

### P0-7 补强 CENC 测试向量

- **来源**：`hongguoTV/kotlin-tv/core/src/test/kotlin/com/hongguotv/core/MediaCryptoTest.kt`。
  它包含四类用例：**【源码】**
  1. NIST AES-CTR 向量在**每一个**非对齐起始偏移和长度上逐一比对（双层循环）。
  2. subsample 场景：clear 字节保持原样，加密部分继续沿用 CTR 偏移。
  3. `frma` 恢复原始 codec（`avc1` 保留，不硬编码 HEVC）。
  4. 截断的辅助数据、超大 `moov` 必须 **fail closed**（抛错），不能返回半个文件。
- **现状**：`server/src/media/cenc.test.ts` 只有 2 个用例（track plan、错误密钥长度）。
- **差距**：当前 `cenc.ts` 的 subsample 与偏移处理没有被任何测试覆盖。这是全项目风险最高的
  纯计算代码，出错表现是"视频能播但花屏"或"ffmpeg 报 Invalid NAL unit size"，很难定位。
- **做法**：在现有 `cenc.test.ts` 里补充上述 4 类用例。测试向量取自公开标准（NIST SP 800-38A
  的 AES-CTR 向量），**不从 GPL 仓库复制测试代码**。
- **验证**：`pnpm --filter @mlzwl/hongguo-server test`。这是本项目唯一值得"为改代码而先写测试"的地方。

### P0-8 `moov` 前置校验与大小上限

- **来源**：`hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/MediaCrypto.kt` 的
  `headerEnd()`：要求 `ftyp` 在偏移 0、`moov` 紧跟其后、`moov` 不超过 8 MB。**【源码】**
- **现状**：`shared/src/mp4.ts` 的 `planTracks()` 直接 `requireBox(top, 'moov')`，
  不校验位置，也不限制大小。
- **差距**：`moov` 在文件尾部时，当前实现会读到越界或解析出错误偏移。上游若返回异常文件，
  失败信息是 `Mp4ParseError` 而不是明确的"容器不支持"。
- **做法**：在 `planTracks()` 入口加三项检查：`ftyp` 在 0、`moov` 紧跟 `ftyp`、
  `moov` 大小 ≤ 8 MB。失败抛带原因的错误码。**不改变**现有"原地解密、长度不变"的契约。
- **验证**：用构造的 `Uint8Array` 覆盖三种非法布局。

### P0-9 用 `frma` 恢复原始编码，不硬编码 `hvc1`

- **来源**：`MediaCrypto.kt`：从 `sinf/frma` 读出原始 4 字节 codec，写回 sample entry。**【源码】**
- **现状**：`shared/src/mp4.ts` 用固定映射 `{ encv: 'hvc1', enca: 'mp4a' }`。
- **差距**：上游若出现 AVC（`avc1`）或 `ac-3` 等，当前实现会把 codec tag 写错。
  浏览器据此选择解码器，写错会导致"能下载但无法播放"。
- **做法**：优先读 `sinf/frma` 的 4 字节；读不到时回退现有映射，并记一条 warn。
  `implementation-notes.md` 已记录实测样本是 `hvc1`，所以回退路径仍然可用。
- **验证**：构造带 `frma=avc1` 的最小 fixture，断言输出包含 `avc1` 且不含 `encv`/`sinf`。

---

## 2. P1：稳定性、缓存与体验细节

### P1-1 真正的下一集媒体预热

- **来源**：
  - `hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/PrefetchPolicy.kt`：
    `nearEnd()` 用**墙钟时间**判断——`(duration - position) / speed <= 30_000`。
    倍速会改变剩余时间，所以必须除以 `speed`。**【源码】**
  - `guoapp/lib/playback_preloader.dart`：600 ms 延迟启动、generation 计数防竞态、
    过期时释放旧 session。**【源码】**
  - `guoapp/native/core/app_preload.go`：预取预算 4 MB、最多 8 个请求、递归深度 ≤ 2、
    超预算立即停止。**【源码】**
- **现状**：`web/src/routes/player-route.tsx` 用 `useQuery` 预取**下一集的播放信息**
  （`api.playback()`），只拿到 JSON，没有触发媒体下载。
- **做法**：
  1. 前端在剩余时间 ≤ 30 秒（按当前倍速折算）时，发一次
     `GET /api/media/:nextId?definition=<当前档>` 的 `HEAD` 或 1 字节 Range 请求。
  2. 服务端照常走 `cache.get()`，于是下载 + 解密 + 落盘在后台完成。
  3. 切集时 `AbortController.abort()`；用集数作为 generation，旧结果直接丢弃。
  4. 一次只预取一集，不递归。
- **验证**：打开一集播放到接近片尾，观察服务端日志出现下一集的 `media ready`，
  且 `data/media/` 多出一个文件。切集后首帧时间应明显缩短。

### P1-2 串行持久化队列，每个键只保留最新值

- **来源**：`hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/LatestWriteQueue.kt`。
  单线程串行写、同一 key 后写覆盖前写、失败重试 2 次、1000 ms 退避、`close()` 不阻塞。**【源码】**
- **现状**：`web/src/features/history/history-store.ts` 用 zustand `persist`，
  每次 `record()` 都整体序列化写 localStorage。`player.tsx` 的 `timeupdate` 触发频率高。
- **差距**：长时间播放会持续写盘；多标签页同时写会互相覆盖。
- **做法**：在 store 外层加一个"脏标记 + 定时 flush"（建议 2 秒）的写入器。
  flush 时只写一次最新快照。`pagehide` 时同步 flush 一次。
- **验证**：播放 30 秒，DevTools Performance 里 localStorage 写入次数应从数百降到约 15 次。
- **遗留**：多标签页同时写仍会互相覆盖。`write-queue.ts` 不监听 `storage` 事件，
  也没有跨标签合并。单用户单机场景下优先级低，未在本批处理。

### P1-3 观看进度写入串行化

- **来源**：`guoapp/lib/local_store_sync.dart` 的 `saveLibrary()`：
  `pending = pending.catch(() => {}).then(...)`，用 Promise 链保证"晚到的写不会覆盖新值"。**【源码】**
- **现状**：`history-store.ts` 的 `record()` 是同步 `set`，本身没有竞态；
  但一旦引入异步持久化（P1-2），就必须同时引入串行链。
- **做法**：P1-2 的实现里必须包含这条串行链，不能只做定时器。
- **验证**：P1-2 的验证步骤中增加"快速切换 3 集，最后一条记录是第 3 集"。

### P1-4 搜索输入防抖、建议缓存与请求取消

- **来源**：`guoapp/lib/search_input.dart`。300 ms 防抖、建议结果缓存、
  用 `Completer` 取消旧请求、输入法 `composing` 期间不发请求。**【源码】**
- **现状**：`web/src/routes/search-route.tsx` 是"提交才搜索"（`keyword` 与 `input` 分离），
  没有联想。这个选择本身没错，缺的是联想能力。
- **做法**：
  1. 输入停顿 300 ms 后调 `GET /api/suggest?prefix=`。
  2. 用 `AbortController` 取消上一次未完成的请求。
  3. `compositionstart` 到 `compositionend` 之间不发请求（中文输入法必需）。
  4. 建议列表最多 8 条，键盘上下选择，Esc 关闭。
- **验证**：中文输入法连续输入"长生"，网络面板应只有 1 个 `suggest` 请求。

### P1-5 搜索历史：去重、长度限制、条数上限

- **来源**：`hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/ViewingTools.kt`
  的 `SearchHistory`：`trim` 后为空或超过 80 字符则不记录，去重后 `take(20)`。**【源码】**
- **现状**：无搜索历史。
- **做法**：新增 `web/src/features/search/search-history-store.ts`，键
  `dsh-hongguo.search-history.v1`，规则同上（80 字符、20 条、最新在前）。
  搜索页空态展示，支持单条删除与全部清空。
- **验证**：连续搜索 25 个不同关键词，只保留最近 20 条；重复搜索同一词不产生重复项。

### P1-6 搜索文本归一化

- **来源**：`guoapp/lib/catalog_sort.dart` 的 `normalizedSearchText()`：
  全角转半角、去除标点、大小写折叠；`matchesDramaQuery()` 基于归一化结果匹配。**【源码】**
- **现状**：`CatalogService.search()` 直接把 `keyword` 传给上游。
- **差距**：用户输入"长生，）"这类带全角标点的词，上游可能返回空结果。
- **做法**：服务端在调用上游前做归一化（全角→半角、去首尾标点、折叠连续空白），
  归一化后为空则直接返回空页。缓存键用归一化后的词。
- **验证**：搜索"长生，"与"长生"返回同一批结果。

### P1-7 目录缓存：TTL、条数上限、字段校验、版本迁移

- **来源**：
  - `hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/CatalogSnapshot.kt`：
    7 天过期、最多 30 条、序列化后 ≤ 200 KB、`description` 截断到 1500 字符、
    解码时校验 `id` 匹配 `[0-9]{1,30}` 且 `title` 非空、明确不落盘签名播放地址。**【源码】**
  - `guoapp/native/core/app_catalog_cache.go`：TTL 15 分钟 + 版本号迁移。**【源码】**
- **现状**：`server/src/common/ttl-cache.ts` 是纯内存缓存，进程重启即失效；
  前端没有离线目录。
- **做法**：
  1. 前端把首页第一页写入 `localStorage`（键带 `v1`），TTL 7 天，最多 30 条，
     序列化后超过 200 KB 则丢弃。
  2. 读取时逐字段校验，任何一条不合法就整体丢弃（不要部分信任）。
  3. 明确**不缓存** `streamUrl` 与任何 `spade_a` 相关内容。
- **验证**：断网后刷新首页，仍能显示上次的 9 部剧；篡改 localStorage 里的 `id`
  为 `abc` 后刷新，缓存被丢弃且不报错。

### P1-8 追更状态机

- **来源**：`guoapp/lib/follow_state.dart`。三态 `planned/watching/watched`、
  手动标记已看、`newEpisodes` 与 `newSeasons` 分别计算。**【源码】**
- **现状**：无收藏功能（全仓无 favorite 相关代码）。
- **差距**：这是最大的功能缺口。用户无法标记"想看""在看""看完"。
- **做法**：
  1. `shared` 增加 `FollowStateSchema`：`state`、`knownEpisodes`（上游已知集数）、
     `confirmedEpisodes`（用户已确认看到的集数）、`updatedAt`。
  2. 前端 store 持久化，键 `dsh-hongguo.follow.v1`。
  3. `newEpisodes = knownEpisodes - confirmedEpisodes`，下限 0。
  4. 剧集详情页与首页卡片显示"更新 N 集"角标。
- **验证**：收藏一部 104 集的剧，把 `confirmedEpisodes` 设为 100，重新拉取详情后角标显示 4。

### P1-9 收藏更新数用高水位，不用差值

- **来源**：`hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/Watching.kt`
  的 `FavoriteUpdate`：`seen` 是**高水位**，`added = (total - seen).coerceAtLeast(0)`，
  且 `now < checkedAt` 时直接返回旧值（防止时钟回拨造成误判）。**【源码】**
- **差距**：如果直接用"上次总数 - 这次总数"，上游偶发返回较少集数时会算出负数或误报"更新"。
- **做法**：P1-8 的 `confirmedEpisodes` 只增不减（除非用户显式重置），
  计算时取 `Math.max(0, known - confirmed)`。
- **验证**：手动把 `knownEpisodes` 调小再调回，角标不应出现负数或重复提示。

### P1-10 续播目标计算（已看完 → 下一集）

- **来源**：`Watching.kt` 的 `ResumePlayback.target()`：找不到当前集时回第 0 集；
  `completed` 为真时回到下一集且不超过最后一集；否则回原位置。**【源码】**
- **现状**：`player-route.tsx` 用 `entry.position > 3` 决定是否续播，没有"已看完"概念。
- **做法**：历史记录增加 `completed` 标记（进度 ≥ 95% 或触发 `ended`）。
  进入剧集详情页时，若当前集已完成，默认高亮下一集。
- **验证**：看完一集后返回详情页，默认选中集变成下一集。

### P1-11 播放与下载偏好的严格校验

- **来源**：
  - `guoapp/lib/playback_preferences.dart`：`fromJson` 对每个字段做类型与取值校验，
    非法即抛 `FormatException`，不做"猜一个默认值"。**【源码】**
  - `guoapp/lib/download_preferences.dart`：`qualities = [0, 1080, 720, 480]` 白名单。**【源码】**
- **现状**：`web/src/features/player/player-store.ts` 用 zustand `persist`，
  没有 `version` 与 `migrate`，也没有取值校验。localStorage 被改坏后会把
  `speed: "abc"` 直接喂给 `video.playbackRate`。
- **做法**：给 `player-store` 加 `version: 1`、`migrate`，以及读取后的取值白名单
  （`speed ∈ [0.5, 0.75, 1, 1.25, 1.5, 2]`、`volume ∈ [0,1]`）。非法值回默认并清掉坏数据。
- **验证**：手动把 localStorage 的 `speed` 改成 `"abc"`，刷新后播放器倍速为 1 且不报错。

### P1-12 对话框焦点陷阱

- **来源**：`hongguo-drama/src/components/useDialogKeyboard.js`：Tab 在对话框内循环、
  Esc 关闭、关闭后焦点归还触发元素。**【源码】**
- **现状**：`web/src/features/player/episode-drawer.tsx` 处理了 Esc 与滚动，
  没有 Tab 循环与焦点归还。
- **做法**：抽出通用 `useFocusTrap(ref, { onClose })`，应用到选集抽屉、
  倍速菜单、音量面板。
- **验证**：键盘打开选集抽屉，连续按 Tab 焦点不逃出抽屉；Esc 关闭后焦点回到触发按钮。

### P1-13 可配置快捷键与按键规范化

- **来源**：`hongguo-drama/src/shortcuts.js`：按键规范化（区分 `code` 与 `key`）、
  冲突校验、可配置。**【源码】**
  `hongguo-drama/src/components/PlayerControls.jsx` 还处理了
  "Shift 先松开导致 keyup 配不上"的场景（用 `event.code` 记录已按下的物理键）。**【源码】**
- **现状**：`player.tsx` 硬编码 Space / ← / →，没有冲突检测，也没有按键释放配对处理。
- **做法**：抽 `shortcuts` 模块，默认表与 `hongguo-drama` 的语义对齐
  （空格播放暂停、←/→ 快退快进、↑/↓ 音量、F 全屏、M 静音）。
  长按加速用 `event.code` 记录，`blur` 时清空。
- **验证**：按住 Shift 再按 →，然后先松 Shift 再松 →，播放器不应停留在加速状态。

### P1-14 选集面板分组与跳转

- **来源**：`hongguoTV/kotlin-tv/app/src/main/kotlin/com/hongguotv/nativeapp/EpisodePanel.kt`：
  每 20 集一组、显示"第 X—Y 集 / 共 N 集"、支持输入集数直接跳转、
  非法输入不静默 clamp。**【源码】**
- **现状**：`episode-drawer.tsx` 一次性渲染全部集数（实测 104 集），有滚动到当前集。
- **做法**：超过 40 集时按 20 集分组，默认展开当前集所在组；提供"跳转到第 N 集"输入框，
  输入非法时提示而不是自动纠正。
- **验证**：104 集的剧，抽屉默认只渲染 20 个按钮；输入 105 时提示范围而不是跳到 104。

### P1-15 睡眠定时器与画幅模式

- **来源**：`hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/PlaybackComfort.kt`：
  `VideoFrameMode`（FIT/ZOOM/FILL）、`SleepTimer`（按分钟 1–180 或按集数 1–10，
  用单调时钟）。**【源码】**
- **现状**：`player.tsx` 用 `object-contain` 固定，无定时器。
- **差距**：`docs/polish-log.md` 已记录"竖屏视频未适配"，画幅模式正是这个问题的解。
- **做法**：
  1. 画幅模式三档，映射到 `object-fit: contain / cover / fill`。默认 `contain`。
     竖屏视频在横屏容器里默认用 `contain`，两侧留黑而不是裁切。
  2. 睡眠定时器：按分钟用 `performance.now()` 计算 deadline（不受系统时钟调整影响）；
     按集数在 `ended` 时递减。
- **验证**：设置 1 分钟睡眠，播放中等待，到点暂停；切到后台再回来，剩余时间仍正确。

### P1-16 buffered / seekable 区间合并

- **来源**：`guoapp/lib/playback_buffer.dart`：解析 `seekable-ranges`、合并相邻区间、
  计算 `continuousPlaybackBuffer`（从当前位置起连续可播的长度）。**【源码】**
- **现状**：`player.tsx` 只取 `video.buffered.end(length - 1)`，进度条把整段画成已缓冲。
- **差距**：用户拖到未缓冲的区间后，进度条仍显示"已缓冲"，造成误判。
- **做法**：遍历 `video.buffered` 生成区间数组，合并相邻/重叠区间，进度条按区间分别绘制。
- **验证**：拖动进度条到未缓冲处，进度条应显示两段而不是一整条。

### P1-17 封面缓存必须有上限和过期

- **来源**：`hongguoTV/kotlin-tv/app/src/main/kotlin/com/hongguotv/nativeapp/ArtworkCache.kt`：
  单文件 ≤ 4 MB、总量 ≤ 24 MB 且 ≤ 100 个文件、7 天过期、读取时双重校验。**【源码】**
- **现状**：`server/src/cover/cover-proxy.service.ts` 按 SHA-256 写盘，
  `COVER_KEEP_DAYS` 配置存在但**没有被任何代码读取**（全仓无 `COVER_KEEP_DAYS` 使用点）。
- **差距**：封面目录会无限增长。上游签名 URL 变化时还会产生同一张图的多份副本。
- **做法**：`fetchJpeg` 命中缓存后触碰 mtime；新增 `evict()`：删除 mtime 超过
  `COVER_KEEP_DAYS` 的文件，再按 mtime 保留最新 100 个 / 24 MB。在写入后调用。
- **验证**：连续请求 120 个不同封面，`data/covers/` 文件数不超过 100。

### P1-18 雪碧图缓存的清理触发点

- **来源**：`hongguoTV` 的 `ArtworkCache.kt` 采用"写入后立即修剪"的策略。**【源码】**
- **现状**：`server/src/cover/sprite-cache.service.ts` 有 `evict(keepVideoIds)`，
  但全仓**没有调用者**（只有定义）。
- **差距**：雪碧图单张约 500 KB、每部剧 6 张，磁盘会持续增长。
- **做法**：在 `SpriteService` 完成一次生成后调用 `evict()`，`keepVideoIds` 传
  "最近 N 天被访问过的 video id"（可用 mtime 近似）。
- **验证**：连续播放 10 部不同的剧，`data/sprites/` 文件数受控。

### P1-19 诊断日志：轮转、脱敏、可复制

- **来源**：
  - `guoapp/native/core/diagnostics.go`：5 MB × 2 轮转 JSONL、写入前对
    `Message`（4096）与 `DramaTitle`（256）截断、按配置的密钥做替换脱敏。**【源码】**
  - `guoapp/lib/diary_service.dart`：内存 500 条、时间戳到 10 ms、可一键复制。**【源码】**
- **现状**：服务端只有 Nest `Logger` 输出到 stdout，没有落盘，也没有脱敏层。
- **做法**：
  1. 服务端增加可选的文件日志（`DATA_DIR/logs/app.jsonl`），5 MB × 2 轮转。
  2. 写入前统一过一遍 `redact()`：抹掉 URL 的 `userinfo`、`query`、`fragment`，
     以及 `spade_a`、`contentKey`、`Authorization`、`Cookie` 字段。
  3. 前端提供"导出诊断"按钮，收集最近 200 条前端事件 + 服务端最后 200 行日志。
- **验证**：故意触发一次上游错误，检查日志文件中不含完整签名 URL。
- **本批范围**：服务端（`redact` + `file-logger` 5 MB × 2 轮转 + `/api/diagnostics`）
  与前端「导出诊断」按钮**均已实现**。
- **实现说明**：
  1. **入口在历史页顶栏**，不在首页：首页顶栏已有随机 / 历史 / 搜索三个入口，再塞一个
     会拥挤；历史页是排障时用户最容易到达、且顶栏最空的页面。
  2. **服务端信息取不到不算导出失败**。这个按钮是排障工具，最需要它的时刻恰好是服务端
     已挂的时候——此时前端事件、环境信息仍然有诊断价值。失败原因写进 `bundle.failure`
     一起导出，比直接报错让用户什么也拿不到有用。
  3. **剪贴板写入失败不抛错**，返回 `{ ok: false, error }`，UI 就地显示「复制失败：…」。
     浏览器拒绝写剪贴板（无用户手势、权限被拒、非安全上下文）是常态，`throw` 出去只会
     变成未捕获的 Promise rejection，调用方拿不到任何可展示文案。
  4. **形状校验手写 `typeof`，不用 zod**：引入 zod 会让 web 包从 282 kB 涨到 430 kB 量级。
     校验失败返回 `null` 而不抛错——响应体多一个字段不该让排障工具整体失效。
  5. **纯逻辑不碰 `window`/`document`/`navigator`**：环境信息、时间、剪贴板写入全部参数
     注入，测试跑 vitest 的 node 环境，不需要 jsdom。
  6. **`api.diagnostics()` / `api.health()` 返回 `unknown`**：契约只在 `diagnostics-report.ts`
     定义一次，`api-client` 不重复定义一遍形状。
  7. **诊断数据不含 query 与凭据**：`route` 取 `window.location.pathname`（不含 query，
     所以搜索词不泄漏）；`events` 的 `detail` 由 `apiErrorDetail()` 保证已过 `stripQuery`；
     `server` 在服务端写盘时已过 `redact`；`health` 只含版本、三态、布尔、运行时长。
  8. **先校验再判失败**（review 发现并修正）：`describeFailure` 原本只看「有没有拿到值」，
     服务端回 200 但响应体是 `null` 或形状对不上时会认为「成功」，结果 `failure: null`
     而 `server: null`——用户看到「已复制」但内容是空的。现传入已校验的结果（`null` =
     失败）。
- **验证**：`diagnostics-report.test.ts` 17 条（形状校验、截断、**500 行中第 400 行非法
  时整份判无效**、复制事件对象、序列化可解析）；`export-diagnostics.test.ts` 11 条
  （两个 fetch 四种成功/失败组合、**200 + `null` 响应体判失败**、**缺字段的 health 判失败**、
  剪贴板 rejected 与**同步 `throw`** 两种失败、事件顺序、250 条截到 200 条、`generatedAt`
  来自注入的 `now`）。
  变异检验：把 `describeFailure` 退回「只看有没有拿到值」后 2 条测试立即失败。
  手工验证：`LOG_TO_FILE=1` 重启后点「导出诊断」，剪贴板里的 JSON 不应包含完整签名 URL。

### P1-20 源健康检查与分步状态

- **来源**：`guoapp/native/core/app_source_health.go`：
  分 `catalogOnly` / `ok` / `failed` 三态，明确区分"目录能读但播放不行"。**【源码】**
- **现状**：`server/src` 无 `health` 相关代码。
- **做法**：新增 `GET /api/health`，返回 `{ ok, upstream: 'ok'|'catalog_only'|'failed',
apiVersion, deviceRegistered }`。**不**探测真实上游内容（避免额外请求），
  只反映"设备档案存在 + 最近一次上游调用是否成功"。
- **验证**：`curl 127.0.0.1:9133/api/health` 返回 200 与 `apiVersion`。

### P1-21 错误信息脱敏

- **来源**：`guoapp/native/core/helpers.go` 的 `redactErrorString()`：
  解析 URL 后把 `User`、`RawQuery`、`Fragment` 替换为 `redacted`。**【源码】**
  以及 `hongguoTV/server/http.mjs` 的注释："上游消息可能包含签名 URL，
  绝不回显到客户端响应或日志"。**【源码】**
- **现状**：`playback.service.ts` 的 `PlaybackUnavailableError` 消息里带
  `failure.message`；`media-cache.service.ts` 的错误直接抛给 Nest。
- **风险**：上游错误消息可能包含带签名的完整 URL，会被写进日志或返回给浏览器。
- **做法**：所有跨边界错误（返回给前端、写日志）先过 `redactError()`。
- **验证**：构造一个 message 含 `https://x/y?sign=abc` 的错误，断言输出为 `sign=[redacted]`。

### P1-22 外链与 URL 安全校验

- **来源**：
  - `hongguo-drama/scripts/check-share-security.cjs`：拒绝 `data:` / `file:` / `ftp:` /
    `javascript:` / 超长 / 带凭据的 URL，禁止重定向，2 MB 上限，`AbortSignal` 超时。**【源码】**
  - `hongguo-drama/src/native/web-media-guard.js`：用 `BlockList` 拒绝私网、
    回环、链路本地、保留地址，防 SSRF。**【源码】**
- **现状**：`cover-proxy.service.ts` 有域名后缀白名单（已经做对了），
  但没有拒绝带凭据的 URL，也没有解析后复查 IP。
  另外 `produce()` 用的是 `fetch(url, { redirect: 'follow' })`：**跟随重定向**、
  无超时、无响应大小上限。白名单只校验了第一次请求的 URL，重定向可以绕过它。
- **做法**：封面代理增加四条：拒绝 `url.username || url.password`；
  解析 DNS 后拒绝私网地址；改 `redirect: 'error'`；加 `AbortSignal.timeout` 与
  响应大小上限（建议 8 MB）。**不要**引入完整 SSRF 防护框架，
  四条足够覆盖当前攻击面。
- **验证**：单测已覆盖六条：带凭据的 URL、私网/回环/链路本地/保留地址（含反向用例）、
  `redirect: 'error'`、`content-length` 预判超限、流式累计超限、超时。
  `isPrivateHost` 直接单测而不是经 `isAllowed`：变异检验证明经 `isAllowed` 测时，
  把私网检查整段删掉测试也照样通过（后缀白名单先挡住了），测不到要测的东西。
- **实现说明**：四条都已落地，但有两处与计划的字面表述不同，原因写在这里：
  1. **不做 DNS 解析**。`isPrivateHost` 只判字面主机名。白名单已经把主机限定到字节的
     图片 CDN 后缀，解析结果必然落在这些域名下；而在请求路径上做 DNS 查询既多一次往返，
     又挡不住真正的 DNS rebinding（解析结果与 `fetch` 实际用的地址之间仍有 TOCTOU 窗口）。
     这一层的实际作用是把「字面写成 IP 的探测请求」挡在外面。
  2. **用 `redirect: 'error'` 而不是在重定向后复查**。封面 CDN 实测不重定向；
     真遇到就失败，比默默代理一个未知地址安全。
     另外加了两条：`content-length` 预判 + 逐块累计上限（8 MB，`COVER_MAX_SOURCE_BYTES`），
     以及 `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`。不能先 `arrayBuffer()` 再量长度——
     那一步已经把整个响应读进内存了。

### P1-23 请求作用域取消

- **来源**：`hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/RequestScope.kt`：
  按导航或播放意图取消进行中的请求，**包括 body 读取阶段**。**【源码】**
- **现状**：前端 `useQuery` 在组件卸载时会取消 fetch，但服务端不感知；
  服务端到上游的请求会继续跑完（`discover` 约 2.5 秒）。
- **做法**：`CatalogService` 的 `load()` 接受 `AbortSignal`（从 Fastify request 透传），
  传给 SDK 的 transport。上游请求在浏览器断开后中止。
- **验证**：首页加载中立即切走，服务端日志显示请求被 abort 而不是跑完。

### P1-24 并发播放上限

- **来源**：`hongguoTV/server/http.mjs`：`activeStreams >= 4` 时返回 503
  并给中文提示。**【源码】**
- **现状**：`media.controller.ts` 无并发限制。多标签页同时播放会同时触发多次
  下载 + 解密（每次 15 MB 级）。
- **做法**：`MediaCacheService` 增加信号量（上限 4），超限返回 503 +
  `Retry-After`。注意"同一集的并发请求共享 Promise"已有，信号量只约束不同集。
- **验证**：同时打开 5 个不同集的播放页，第 5 个返回 503 且提示可读。

### P1-25 本地访问口令（可选）

- **来源**：`hongguoTV/server/http.mjs`：可选 `Bearer` token，用
  `timingSafeEqual` 比较，长度不同直接拒绝。**【源码】**
- **现状**：默认监听 `0.0.0.0`（所有 IPv4 网卡），无鉴权。
- **判断**：**当前仍不做**，但理由已变。不再是因为「只监听回环所以没有威胁模型」，
  而是**明确选择依赖主机防火墙与可信网络**：启动时会打 warn 提示
  `/api/*` 无鉴权、`server/data/` 含设备指纹，需要仅限本机时设 `HOST=127.0.0.1`。
  这个选择的代价是：只要有人能路由到该端口，就能无鉴权调用全部接口并读取设备指纹。
  如果将来要在不可信网络（办公网、共享 Wi-Fi、带公网 IP 的云主机）上使用，
  必须重新评估并加访问口令，用 `timingSafeEqual` 而不是 `===`。
- **结论**：仍为"已知但暂不做"；但触发条件已从"将来绑 `0.0.0.0`"变为"在不可信网络部署"。

---

## 3. P2：新增能力

### P2-1 弹幕数据协议

- **来源**：`danmu_api/danmu_api/sources/hongguo.js`：
  `COMMENT_WINDOW_MS = 30_000`、`next_query_danmaku_list_time` 游标、
  `dedupeDanmus()`、频控冷却指令（服务端返回 `min_ban_time` / `max_ban_time` / `ban_rate`）。**【源码】**
- **已知缺陷**：该实现对失败请求回退到实例上的 `lastDanmu`，**没有按分集隔离**，
  会串入上一集的弹幕。**不要照搬这个回退逻辑**。
- **做法**：
  1. 服务端新增 `GET /api/episodes/:id/danmaku?from=<ms>`，按 30 秒窗口返回。
  2. 缓存键必须含 `episodeId`，回退缓存同样按集隔离。
  3. 去重键用 `(timeMs, content)` 的哈希。
  4. 上游限流时返回 `Retry-After`，前端退避而不是立刻重试。
- **验证**：连续切换两集，第二集不应出现第一集的弹幕文本。

### P2-2 弹幕渲染与轨道分配

- **来源**：
  - `guoapp/lib/danmaku_overlay.dart`：轨道分配算法——对每条新弹幕找第一条
    "不会追尾"的轨道（比较 `width`、`gap`、`danmakuLifetimeMs` 三者关系）；
    最多 4 行；`_motion` 用 `elapsed / lifetime` 驱动，倍速时按 `rate` 缩短。**【源码】**
  - `hongguo-drama/src/components/danmakuModel.mjs` + `CommentDanmaku.jsx`：
    `requestAnimationFrame` 驱动、`canAdvance()` 门控（`!paused && !ended && !seeking
&& readyState >= 2 && !document.hidden`）、`prefers-reduced-motion` 时改静态轮换、
    `ResizeObserver` 变化时重置轨道。**【源码】**
- **判断**：`hongguo-drama` 的"弹幕"实际是**公开评论滚动展示**，与视频时间无对应
  （它自己在设置面板里写明了）。本项目要做的是**按时间戳同步的真弹幕**，
  渲染逻辑参考 `guoapp`，生命周期参考 `hongguo-drama`。
- **做法**：Canvas 或绝对定位 DOM + rAF，轨道数按容器高度计算，`prefers-reduced-motion`
  降级为静态列表。
- **验证**：1 倍速与 2 倍速下弹幕位移速度一致（相对视频时间）；切到后台标签页时停止 rAF。

### P2-3 弹幕设置持久化

- **来源**：`hongguo-drama/src/components/CommentDanmaku.jsx` 的 `DanmakuSettings`：
  不透明度 20–100%、字号 16–32、速度 0.5–2、显示区域（1/4、1/2、全屏）、
  密度三档、内置敏感词过滤开关、自定义屏蔽词（≤ 10000 字符，每行一个）。**【源码】**
- **做法**：设置存 localStorage，屏蔽词只存本机、不上传。命中后整条隐藏。
- **验证**：设置不透明度 20% 后刷新页面仍生效。

### P2-4 上新日历

- **来源**：`hongguo-drama/src/components/ReleaseCalendar.jsx`：按月份分组、
  可按收藏过滤。**【源码】**
- **依赖**：需要上游提供发布日期。`hongguo-drama` 从 `_ROUTER_DATA` 里取
  `published_at`；本项目的 SDK 是否暴露该字段**未确认**，需要先用
  `client.newReleases()` 实测返回结构。
- **判断**：**【推导】**。在确认字段存在前不要排期。

### P2-5 随机/发现入口

- **来源**：`hongguo-drama/src/components/randomDramaModel.mjs`：
  `waitForRequest()` 用 25 秒超时与 `AbortSignal` 竞态；`loadRandomPool()` 多源并行、
  来源 ID 正则校验、去重、`unavailable` 上报。**【源码】**
- **判断**：本项目的 SDK 已有 `shortRank()` / `newReleases()` / `shortFilter()`，
  随机入口可以直接基于这些做，不需要"多源"概念。**【推导】**
- **做法**：`GET /api/random` 从排行榜缓存里随机取一条。**不要**每次打上游。
- **实现说明**：
  1. **缓存的是整个候选池，不是选中的那一条**。`CatalogService.randomCache`
     （`TtlCache<SeriesSummary[]>`，TTL 60 秒，`maxEntries = 1`）存池子，每次请求
     再用 `pickRandom` 现取。缓存结果本身会让 60 秒内一直返回同一部剧，那就不是
     「随机」了。
  2. **用 `shortRank()` 而不是 `discover()`**：`discover` 单次约 2.5 秒且是个性化
     推荐流（同一部剧跨页重复），排行榜是稳定榜单，更适合「随便看一部」。
  3. **候选过滤在 `random-pick.ts` 的 `toRandomCandidates`**：榜单里混着演员行
     （只有 `user_id`，没有 `series_id`）和推广重复行。丢弃缺 `series_id`、缺或空白
     `title`、`episode_count` 非非负整数的行，按 `series_id` 去重。**先校验后去重**——
     否则「同 id 第一行非法、第二行合法」时合法那条会被挡掉。
     **字段类型也要校验**（review 发现并修正）：上游是松散 JSON，类型声明写
     `series_id?: string` 不代表线上真的给字符串。给数字时直接 `.trim()` 会抛
     `TypeError`，整个 `/api/random` 变成 500——而这只是一个候选行不合格。
     非字符串的 `cover_url` 也整个键丢掉，不转成字符串（否则会静默变成
     `/api/cover?u=123`，得到一个必定 404 的封面）。
  4. **封面必须走 `CatalogMapper.toSeriesSummary`**，让上游 CDN 直链被改写成
     `/api/cover?u=` 白名单代理地址。这是本项目的核心安全契约，不能手工拼 DTO。
  5. **空池返回 404 + `{ code: 'no_random' }`，不是 200 + `null`**：前端 `request()`
     把 2xx 响应体直接当成功值，`null` 会一路传到 `navigate('/series/null')`，
     得到一个能渲染但永远播不了的详情页，且没有任何错误提示。
  6. **前端按钮用图标而不是文字**：390px 宽度下顶栏已有「历史」「搜索」两个文字
     按钮加主题切换，再加一个文字按钮会把标题挤没。
- **验证**：`random-pick.test.ts` 16 条（索引 clamp、`NaN`/`±Infinity`、五类非法行、
  非字符串 `series_id`/`title`/`cover_url`、去重、`coverUrl` 键存在性）；
  `catalog.service.test.ts` 5 条（**服务级**：封面经 mapper 改写且响应不含
  上游域名、空池返回 `undefined`、空榜单、缓存窗口内只打一次上游、字符串集数被丢弃）；
  `catalog.controller.test.ts` 3 条（**HTTP 层**：有候选时原样返回、空池抛
  `HttpException` 且 `getStatus()` 为 404 / `getResponse()` 为 `{ code: 'no_random', message }`、
  空池不得返回 200 + `null`）；
  `random-entry.test.ts` 3 条（错误文案）。
  变异检验：删掉 controller 里的 404 抛错后 2 条测试立即失败；把 `loadRandomPool`
  改成手工拼 DTO（封面用上游直链）后 mapper 契约测试立即失败。
  手工验证：连点「随机看一部」不应发出多个请求（按钮 `disabled` + handler 提前返回）。

### P2-6 局域网传输与手机输入

- **来源**：`hongguoTV/kotlin-tv/core/src/main/kotlin/com/hongguotv/core/LibraryTransferServer.kt`
  与 `PhoneSearchServer.kt`：16 字节随机 token、5 分钟 TTL、只接受回环/站点本地地址、
  **单次消费**（用过即失效）。**【源码】**
- **判断**：本项目是 Web 客户端，用户已经在浏览器里，这个能力的价值低。
  只有当要支持"手机扫码把收藏同步到另一台设备"时才需要。
- **结论**：记为"当前不做"。若将来做，必须保留"单次消费 + 短 TTL"两条。

### P2-7 局域网同步的幂等与冲突解决

- **来源**：`guoapp/lib/lan_sync_models.dart` 与 `lib/local_store_sync.dart`：
  每条记录有内容哈希；同步用 `receipt` 保证同一 `operation` 只应用一次；
  应用前校验 `base` 哈希未变（乐观锁）；冲突字段由用户逐项选择。**【源码】**
- **判断**：**【推导】**。当前是单机单用户，没有同步需求。
  但 `receipt` 幂等与 `base` 哈希校验这两条设计，将来做导入/导出时可以直接借鉴。

### P2-8 媒体源管理

- **来源**：`hongguo-drama/src/components/mediaSourcesModel.mjs`：
  `normalizeMediaSources()` 校验 id 格式（自定义源必须是 UUID）、去重、
  过滤禁用项、`label` 去空白后非空。**【源码】**
- **判断**：本项目只有红果一个源，**不需要**多源管理。借鉴点只有"配置读取时严格校验"，
  已并入 P1-11。

### P2-9 封面解码串行队列

- **来源**：`guoapp/lib/cover_decoder.dart`：HEIC→JPEG 串行队列、pending 上限 96、
  解码后校验 JPEG 头再使用。**【源码】**
- **现状**：本项目在服务端用 `heic-convert` + `sharp` 转码，前端只拿 JPEG，
  不存在浏览器解码 HEIC 的问题。
- **判断**：**不适用**。记录在此是为了说明"为什么不抄"。

### P2-10 媒体自定义协议与 CORS 白名单

- **来源**：`hongguo-drama/src/native/media-access.js`：Electron 自定义协议，
  同时校验 `origin` 与 `initiatorOrigin`。**【源码】**
- **判断**：**不适用**。本项目用 HTTP Range，不注册自定义协议。
  但 `main.ts` 的 CORS 已限定 `CORS_ORIGINS`，语义上等价，无需改动。

### P2-11 解密放到 Worker

- **来源**：`hongguo-drama/src/native/decrypt-worker.cjs`：`worker_threads` 解密，
  取消时 `terminate()` 并等待写入停止。**【源码】**
- **现状**：解密在 Nest 主线程同步执行。实测 1080p 14.8 MB 解密 18–20 ms，
  主线程阻塞可接受。
- **判断**：**当前不需要**。只有当单文件超过 100 MB 或并发解密数上升时才考虑。
  届时用 `node:worker_threads`，并保留"取消时等写入停止"这条。

### P2-12 播放器交互细节

- **来源**：
  - `guoapp/lib/player_interactions.dart`：长按加速、双击、`pointercancel` 兜底、音量手势。**【源码】**
  - `hongguo-drama/src/components/PlayerControls.jsx`：控件自动隐藏的完整策略——
    2 秒后隐藏、但 `:focus-visible` 时不隐藏；拖 `input[type=range]` 期间不隐藏；
    `pointermove` 用 `screenX/screenY` 比较（全屏切换会派发无位移的 move 事件）；
    `pause` 与 `ended` 的先后顺序处理。**【源码】**
- **现状**：`player.tsx` 已有控件隐藏定时器与长按加速。
- **可吸收点**（三个具体细节，三条均已落地）：
  1. 隐藏前检查 `:focus-visible`，键盘用户不会被抢走焦点。
  2. 拖动进度条期间暂停隐藏计时。
  3. `pointermove` 用屏幕坐标去重，避免全屏切换时误判为用户活动。
- **实现说明**：
  1. **焦点检查在 `scheduleHide()` 的 `armHide(delay)` 里**，用 `hasVisibleFocus()`
     查 `container.querySelector(':focus-visible')`。命中时以 `FOCUS_HOLD_RECHECK_MS`
     （1000 ms）重排复查。这个循环不会失控：每次重排前都重新查一次，焦点一旦离开
     控件就返回 `false`，下一次到点走正常隐藏分支。频率是 1 秒一次，不是忙等。
  2. **`querySelector` 必须包 `try/catch`**：`:focus-visible` 在部分旧浏览器的选择器
     引擎里不合法，会抛 `SyntaxError` 而不是返回 `null`。降级为「没有焦点」，走正常
     隐藏——控件永远不隐藏比少隐藏一次糟糕得多。
  3. **`controlsLocked` 不能是单一布尔值**（review 发现并修正）：锁有五个互相独立的
     来源（悬停底栏、拖进度条、长按加速、倍速菜单、音量滑块）。单布尔值时任一来源
     释放就把整把锁打开：鼠标停在底栏不动、开再关倍速菜单，关闭分支会把锁设成
     `false`，3.2 秒后控件就在鼠标还悬停其上时消失。现用 `controls-lock.ts` 的
     `Set<LockSource>`，只有最后一个来源释放才算解锁。
  4. **`focusin` / `focusout` 不能省**：控件隐藏只是加 `opacity-0 pointer-events-none`，
     DOM 节点仍在 Tab 序列里。键盘用户 Tab 到一个「隐藏」的按钮时，焦点会落到一个
     看不见的元素上，而控件不会自己出现——用户完全不知道自己现在在哪。参考实现
     同时挂 `focusin` / `focusout`，正是为此。用冒泡的 `focusin`/`focusout` 而不是
     `focus`/`blur`（后者不冒泡）。
  5. **`pointermove` 挂原生监听而不是复用 `useGestures`**：`useGestures.onPointerDown`
     在按到交互控件时会把 `origin.current` 置 `null` 并 return，其 `onPointerMove`
     开头就 `if (start === null) return`。而鼠标最常停留的位置正是底部控件区——这条
     路径根本收不到事件。原生监听与手势逻辑解耦，也不受 `{...gestures}` 覆盖影响。
  6. **用 `screenX/screenY` 而不是 `clientX/clientY`**：后者是相对视口的坐标，全屏切换
     引起的布局重排会让它变化，看上去就像「指针动了」。`screenX/screenY` 是物理屏幕
     坐标，布局变化不影响它。
  7. **首次事件用 `movementX/movementY` 兜底**：没有基准坐标可比。进入/退出全屏时浏览器
     补发的无位移 `pointermove` 的 `movement` 全为 0，只能靠它识别。反之若浏览器没实现
     `movement`（读出来 `undefined`），照常唤出——宁可多显示一次，也不能吞掉用户的
     第一次真实移动。
  8. **`screenX`/`screenY` 相同时不能无条件忽略**（review 发现并修正）：隐私模式、
     嵌入式 WebView 里屏幕坐标可能恒为 `0,0`。若只看坐标，首次唤出之后的每一次
     真实移动都会被吞掉，控件再也出不来。现在坐标相同时再看 `movementX`/`movementY`
     是否明确非零，非零则照常唤出。代价只是「指针抖出去又抖回来」时多显示一次。
  9. 判定逻辑全部在纯函数 `judgePointerMotion` 里（`pointer-motion.ts`），`player.tsx`
     只负责挂监听。坐标重复且 `movement` 也为零时返回传入的 `previous` 引用本身，
     调用方可用 `===` 判断基准未变。
- **验证**：`pointer-motion.test.ts` 13 条（首次带位移/无位移/字段缺失/单字段缺失、
  坐标重复的引用相等、坐标重复但 `movement` 非零仍唤出、屏幕坐标恒为 `0,0` 时靠
  `movement` 唤出、`screenX` 变、`screenY` 变、两轴同变、`0,0` 是合法基准）；
  `controls-lock.test.ts` 8 条（重叠锁不被提前解开、幂等、不修改入参、五个来源独立）。
  变异检验：把 `isLocked` 改回「单一布尔」语义（`size > 1`）后 3 条测试立即失败；
  把坐标相同时的 `movement` 判据删掉后 2 条测试立即失败。
- **只能手工验证的**（`player.tsx` 无自动化测试覆盖，本包约定 web 只测纯逻辑）：
  1. 全屏切换时控件不闪一下又消失；
  2. Tab 到进度条后控件不在 3.2 秒后消失；
  3. 焦点留在控件内时控件保持显示，且不出现高频重排；
  4. 控件已隐藏时按 Tab，焦点落到控件上时控件立刻出现（不是停在隐形按钮上）。

### P2-13 目录页数据提取

- **来源**：`hongguo-drama/src/native/catalog.js`：从 HTML 里提取
  `window._ROUTER_DATA`，用**手写括号匹配**而不是 `eval`/正则，且不执行脚本。**【源码】**
- **判断**：本项目走 SDK，不解析 HTML。**不适用**。
  但"解析不可信 JSON 时不执行脚本"这条原则适用于任何未来的页面抓取。

### P2-14 批量下载

- **来源**：`guoapp/lib/batch_downloads.dart`：`maxDramas = 50`、`_submitted` 集合去重、
  分步统计 `added` / `existing` / `pending`。**【源码】**
- **判断**：**【推导】**。本项目没有"下载到本地"的概念（服务端已缓存）。
  若将来做离线播放（PWA + Cache Storage），需要 `maxDramas` 与去重两条。

### P2-15 视频旋转元数据

- **来源**：`guoapp/lib/video_output_size.dart`：`rotate % 180 == 90` 时交换宽高。**【源码】**
- **判断**：**【推导】**。当前 `playback.service.ts` 直接用上游 `width`/`height`。
  若上游对旋转视频返回未旋转的宽高，竖屏判定（P0-1）会再次出错。
  **验证方式**：实测一部竖屏剧，比对 `playback` 返回的 `width/height`
  与 `video.videoWidth/videoHeight`。不一致才需要处理。

---

## 4. 纯前端化方案分析

用户提出的问题是：能不能不要服务端，浏览器直接跑 SDK 与解密？

### 4.1 两种形态必须分开讨论

| 形态                    | 内容                                                                     | 结论                         |
| ----------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| **纯静态**              | 只有静态文件托管（GitHub Pages / OSS / Vercel 静态），浏览器直连上游 API | **不可行**，有硬阻塞         |
| **薄代理 + 浏览器解密** | 一个只转发 HTTP 的服务端 + 浏览器跑 WASM 与 CENC 解密                    | **技术上可行**，但有明确代价 |

"纯前端化"通常指第一种。下面先给不可行的证据，再给第二种的取舍。

### 4.2 纯静态为什么不可行（已有实测证据）

证据来自 `docs/reverse-engineering.md` §5，是浏览器里实际观测到的：

1. **设备注册预检失败**：注册接口对 `OPTIONS` 返回 404，且不带 CORS 头。
2. **API 预检被拒**：业务接口的 `OPTIONS` 返回 403。
3. **带 `Origin` 直接被判无效**：请求头里出现 `Origin` 时上游返回
   `AUTHENTICATION_REQUIRED`。这是主动反盗链，不是配置问题。
4. **注册 Cookie 读不到**：注册响应靠 `Set-Cookie` 建立会话，而浏览器 `fetch`
   读不到这个响应头。即使绕过前三条，会话也建立不起来。
5. **媒体 CDN 是开放的**：视频地址返回 206 且 `Access-Control-Allow-Origin: *`。
   所以"播放"这一步本身不需要代理，**只有 API 层需要**。

结论：纯静态托管无法完成设备注册，也就拿不到任何数据。这不是"多写点代码"能解决的，
是上游的服务端策略。

### 4.3 薄代理形态的可行性（已在离线环境验证）

在不访问真实上游的前提下，用本地静态服务 + Playwright 加载
`wasm_exec.js` 与 `openhongguo.wasm`，得到：

| 探测项                                    | 结果                         |
| ----------------------------------------- | ---------------------------- |
| `secureContext`                           | `true`                       |
| WASM 启动                                 | `true`，启动耗时 54 ms       |
| `client` 可调用                           | `true`                       |
| 初始化错误                                | `false`                      |
| 期间发出的网络请求数                      | 0（未接触上游）              |
| `Worker` 可用                             | `true`                       |
| `crypto.subtle` 可用                      | `true`                       |
| `indexedDB` 可用                          | `true`                       |
| `ServiceWorker` 可用                      | `true`                       |
| AES-CTR NIST 向量解密                     | 通过                         |
| `canPlayType('video/mp4; codecs="hvc1"')` | `probably`（仅单桌面浏览器） |

WASM 体积：6,855,007 字节；gzip 1.86 MB；brotli(q11) 1.34 MB。

所以第二种形态在**运行时能力**上是成立的：浏览器能跑 SDK、能算密钥、能解密。

### 4.4 薄代理形态的真实代价

1. **6.85 MB WASM 是首屏成本**。brotli 1.34 MB，4G 下 1–2 秒下载 + 编译。
   当前 B 形态没有这个成本。
2. **代理不能是"无脑 pipe"**。它必须：剥掉 `content-encoding` / `content-length` /
   `transfer-encoding`，把 `Set-Cookie` 解析成 JSON 字段回传，补 CORS 头。
   `docs/reverse-engineering.md` §5 已用 9 条 discover 结果验证过这个转发器可行。
3. **设备档案落在浏览器**。换浏览器、清缓存就换设备身份。当前 B 形态存在 SQLite 里，
   删了也能自动重注册。
4. **封面与雪碧图转码要在浏览器做**。HEIC 封面和 HEIF 雪碧图需要 Web Worker +
   WASM 解码器（`heic-convert` 是 Node 包，浏览器不可用）。这是**新增**的工作量，
   不是"省掉服务端"。当前服务端已经做完并带缓存。
5. **HEVC 兼容性没有改善**。A 形态下浏览器必须自己解码 HEVC。当前 B 形态至少保留了
   "将来加服务端转码"的可能（虽然明确不做）。
6. **CENC 解密要在浏览器做**。`docs/reference/cenc-decrypt-browser.mjs` 已存在，
   说明这条路验证过。但整文件解密意味着浏览器要持有完整 15 MB `ArrayBuffer`，
   移动端内存压力明显。当前服务端解密后可以用 Range 只发需要的部分。

### 4.5 结论与建议

**不建议迁移到纯前端形态。** 理由按重要性排序：

1. 纯静态不可行，必须保留代理，所以"零服务端"的收益本身不存在。
2. 保留代理后，省掉的只是"服务端持有密钥"这一点，代价是首屏多 1.34 MB、
   浏览器要做 HEIC/HEIF 转码、移动端内存压力上升。
3. 当前 B 形态的核心优势（服务端缓存转码结果、Range 只发需要的字节、
   密钥不出服务端）都是实打实的。

**唯一值得考虑的混合方案**：保持 B 形态不变，只在**播放链路**上做可选优化——
如果将来上游提供未加密的 H.264 源，可以让浏览器直连 CDN（`ACAO: *` 已确认开放），
服务端只出播放信息。这能省掉服务端的下载与解密，但**不改变架构形态**，
也不引入 WASM。**这是一个独立的小改动，不需要现在就做。**

如果将来确实要做 A 形态，`docs/tech-stack.md` §1 的对比表需要先更新，
并且必须同时解决 4.4 的第 4 条（浏览器 HEIC/HEIF 转码），否则封面与雪碧图会退化。

---

## 5. 推进顺序

按"风险 × 收益"排序。每一批都可独立交付、独立回滚。

**第一批（P0，修错）**

1. P0-1 清晰度短边判定
2. P0-2 `streamUrl` 绑定清晰度
3. P0-9 `frma` 恢复原始编码
4. P0-8 `moov` 前置校验
5. P0-7 CENC 测试向量补强

理由：1、2 是用户可见错误，改动小；3、4、7 是同一个文件（`shared/src/mp4.ts`
与 `cenc.ts`）的正确性加固，一起做能共用测试夹具。

**第二批（P0，容错）**

6. P0-4 超时与大小上限
7. P0-3 备用地址
8. P0-6 写头前完成重试（约束性改动，配合 7）
9. P0-5 错误分类

理由：4 是 3 的前置（没有超时，多地址重试会拖长失败时间）。6 是 5 的数据来源。

**第三批（P1，稳定性）**

10. P1-2 + P1-3 串行持久化
11. P1-17 + P1-18 缓存上限
12. P1-21 + P1-19 + P1-22 脱敏、诊断与外链校验
13. P1-11 偏好校验
14. P1-20 健康检查

**第四批（P1，体验）**

15. P1-1 下一集预热
16. P1-4 + P1-5 + P1-6 搜索能力
17. P1-12 + P1-13 + P1-14 键盘与选集
18. P1-15 + P1-16 画幅、定时器、缓冲区间

**第五批（P1/P2，功能）**

19. P1-8 + P1-9 + P1-10 收藏与追更
20. P1-7 离线目录

**第六批（P2，补齐遗留）**

21. P2-5 随机/发现入口
22. P2-12 播放器交互细节（`:focus-visible` + `pointermove` 屏幕坐标去重）
23. P1-19 前端部分（「导出诊断」按钮）

理由：这三项在第一批到第五批里被跳过（前两项原本未排期，第三项只做了服务端），
都是无外部依赖的小改动。P2-12 的三个细节里，拖动期间不隐藏原本已实现，本批补上
剩下两个。

**第七批（产品功能，已完成）**

24. 「我的收藏」页 `/favorites`
25. 热度榜页 `/ranking`

理由：这两项是用户可感知的功能缺口。收藏状态从 P1-8/P1-9/P1-10 起就能写入
`dsh-hongguo.follow.v1`，但一直没有列表页，用户收了剧看不到；排行榜数据从
`shortRank()` 一直拿得到，却只被 `/api/random` 当候选池用完就扔。两者都不需要
新增上游逆向，只需把已有数据接到页面上。

实现要点：

- 两个页面都是路由级懒加载（`React.lazy`），不进首屏 chunk。首屏 `288.07 kB /
gzip 89.92 kB`，红线 355 kB。
- 服务端新增 `GET /api/ranking/catalog` 与 `GET /api/ranking`。目录缓存 5 分钟，
  条目缓存按 `cacheKeyOf(content, board, cursor)` 分键，TTL 同样 5 分钟。
- 缓存键**不能用固定分隔符拼接**，也不能用 `?? 'first'` 之类的默认值。
  两个理由：`z.string()` 不拒绝 NUL，URL 的 `%00` 能还原成真实 NUL 字节，
  所以 `{content:'a\0b', board:'c'}` 与 `{content:'a', board:'b\0c'}` 会拼出同一个键；
  `cursor ?? 'first'` 又会让字面量游标 `"first"` 撞上「没有游标」。
  `server/src/catalog/cache-key.ts` 的 `cacheKeyOf` 用 `JSON.stringify` 对字段数组
  做可逆序列化，并用 `null` 表示缺失，因此缺失、空串、含任意字符的值都能区分。
  `feed`、`search`、`ranking` 三处共用该函数；`cache-key.test.ts` 覆盖 NUL、
  缺失 vs 空串、缺失 vs 字面量 `"first"`，service 层另有真实调用路径的隔离用例。
- 名次用上游 `position`，**不用 `rank`**。实测 `rank` 为 `1,2,3,4,5,5,6,7,8,10,9,10`
  （重复且跳号，推广行照抄下一行），而 `position` 连续（`1..12`，第二页 `13..22`）。
- `votes` 在短剧榜恒为 `undefined`，因此不暴露。`score` 是显示文本
  （`"8835万热度"` / `"平台推荐"`），原样透传不解析——解析成数字会丢失
  `"平台推荐"` 这种非数字值。
- 榜单空返回 `200 + entries: []`，与 `/api/random` 的 404 相反：随机必须给出可跳转
  结果，榜单空只是这一榜没数据。
- 非法 `board` 把上游 `CONTENT_UNAVAILABLE`/`PARAM_INVALID` 映射成
  `400 ranking_unavailable`，而不是 500。限流、签名、传输错误仍走 5xx。
- 收藏页另写专用卡片，不复用 `SeriesCard`：需要独立的「取消收藏」操作区，
  整卡是按钮的 `SeriesCard` 会造成嵌套按钮。
- 顶栏在 < 640px 时把操作收进「≡ 更多」popover，`right` 槽位保持可见。

**第八批（实测回归修复与下载功能，已完成）**

26. 首页无限滚动失效（回归）
27. 详情页操作区改单行平铺
28. 单集下载（详情页下载面板 + 播放页选集抽屉）
29. 收藏页改三 tab

理由：前三项是用户实测发现的问题，第四项是同类页面的结构统一。

实现要点：

- **首页分页失效的真正根因不是 `getNextPageParam`，而是离线快照被写成
  `initialData`。** 快照页的 `cursor` 是 `null`，进了 `allPages` 之后
  `last.cursor === null` 直接把分页判成终止。决定性证据：快照存在时
  reload，`/api/feed` 零请求，页面停在 8 条 + 「没有更多了」。
  改法是把快照从 `initialData` 换成 `placeholderData`：placeholder 不写
  Query cache，cache 为空时挂载必然 fetch；从详情页返回首页时 cache 里
  已有真实数据，`refetchOnMount: false` 仍生效，「切页回来不重取」的语义不变。
- 分页判定逻辑抽到 `web/src/features/feed/feed-paging.ts` 的
  `nextFeedCursor`，同时保留两条防环语义：整页没有新 id 就停；硬上限 40 页。
  去重时**跳过 `cursor === null` 的页**，否则真实第一页会被快照页误判成重复页。
- 配置本身必须可测。`buildFeedQueryOptions(snapshot)` 是纯函数，测试直接断言
  「有快照时没有 `initialData` 键、有 `placeholderData` 键」。只测
  `nextFeedCursor` 防不住「有人把 `placeholderData` 改回 `initialData`」这类配置回退。
- **`isPlaceholderData` 不能当离线兜底判据。** TanStack Query 只在 `pending`
  状态应用 placeholder，进入最终 `error` 后会把 `isPlaceholderData` 置回 `false`，
  数据也不再来自 placeholder。所以「失败时退回快照」抽成
  `shouldFallBackToSnapshot(isError, hasSnapshot)`，只看请求已失败与快照存在两件事。
  实测：有 7 条快照时断网 reload，修复前 0 张卡片只剩一行报错，修复后 7 张封面
  全部渲染并显示「当前显示的是离线缓存」。
- 底部「没有更多了」必须同时排除「占位数据」与「退回快照」两种情况，
  否则首次请求还没回来就会误报到底。
- 详情页操作区是同一个 `flex` 行：主按钮 `flex-1 min-w-0`、追更按钮
  `flex-none`，两者都是 `h-11`。`min-w-0` 只允许盒子缩小，不会裁掉
  `whitespace-nowrap` 的文字，所以主按钮必须加 `overflow-hidden`，文字单独包
  `<span className="min-w-0 truncate">`，否则「继续看第 1000 集」会越过按钮
  边界盖住追更按钮。
- 下载走既有的 `GET /api/media/:episodeId`，不新增接口，不暴露上游直链。
  不带 `definition` 时服务端自动选最佳档（实测 200 + `content-length` +
  `accept-ranges: bytes`）。下载用 `fetch` + `body.getReader()` 流式读，
  按 `content-length` 算百分比，结束后 `Blob` + `URL.createObjectURL` +
  临时 `<a download>`。延后一轮 `revokeObjectURL`，避免部分浏览器还没接管就失效。
- 下载状态机在 `download-state.ts`（`progressPercent` / `parseContentLength` /
  `describeDownloadFailure` / `formatBytes`）。`total` 未知时 `progressPercent`
  返回 `null` 而不是 `0`：`0` 会让界面显示「0%」，假装知道进度。
- **下载必须有并发上限。** 每集约 19 MB 且整段驻留内存，无上限时点几十集就是
  几百 MB。`download-queue.ts` 的 `DownloadQueue` 把并发压到 2，其余排队、可取消；
  排队项在 UI 上显示「排队中，取消」。实测把 `/api/media` 延迟 4 秒后连点 5 集：
  2 个「下载中」+ 3 个「排队中」，闸门确实生效。
- 详情页下载入口是选集标题行的「下载」按钮打开面板，**不在每个选集格子里塞下载按钮**：
  外层格子本身是 `<button>`，嵌套按钮是非法 HTML。播放页抽屉里集选择按钮与
  下载按钮是兄弟节点（`flex` 行），同样不嵌套。
- 收藏页三 tab 用 `role="tablist"`/`tab"`/`tabpanel` + `aria-selected` /
  `aria-controls` / `aria-labelledby`，同时只渲染当前 panel。`resolveInitialTab`
  用 `useState` 惰性初始化，只在首次挂载算一次，因此用户手动切到空 tab 后
  不会被强行拉回非空 tab。取消最后一条收藏后停留在当前 tab 并显示空状态。
- tab 顺序固定 `watching → planned → watched`，默认选第一个非空 tab；全空时选第一个。
  键盘支持 Left/Right/Up/Down/Home/End，均移动焦点并 `preventDefault`。

**第九批（下载面板修版与批量下载，已完成）**

30. 下载面板集号列换行
31. 批量下载

理由：前一项是用户截图反馈的排版缺陷，后一项是同一功能的操作效率问题。

实现要点：

- 集号列从 `w-12 text-sm` 改为 `w-16 text-xs` + `whitespace-nowrap`。48px 装不下
  「第 53 集」，浏览器把它折成「第 53 / 集」两行，整行跟着变高。单纯加
  `whitespace-nowrap` 会溢出到标题上，必须同时给足固定宽度。
- 批量下载不新增接口也不新增队列：面板里勾选后逐集 `enqueue`，仍走同一个
  `DownloadQueue`（并发 2、先来先服务）。批量只是把多次 enqueue 合并成一次状态同步。
- 可提交集由 `selectBatchTargets` 过滤，跳过已下载、正在下载与排队中的集。
  重复提交会写出同名文件的第二份，并占掉并发槽位拖慢其它集。
- 失败的集**不**跳过：批量提交本身就是它的重试入口。
- `selectionState` 返回 `none` / `partial` / `all` 三态；部分选中时再点全选变全选
  而不是清空——用户意图是「都要」。全选框的 `indeterminate` 只能通过 DOM 属性设，
  React 没有对应 prop。
- 不可下载的集（`playable === false`）不参与勾选与全选，否则提交后必然是失败。
- 提交后清空勾选，避免用户误以为还会再下一次。

**不做**

- P1-25 访问口令（无威胁模型）
- P1-23 请求作用域取消（上游 `discover` 约 2.5 秒，提前中止只省服务端开销，
  无用户可见收益；SDK 的 `Transport` 类型不接受 `AbortSignal`，要改需先扩 SDK）
- P1-24 并发播放上限（单用户单机，多标签页同时播放是低频场景；
  同一集的并发请求已共享 Promise）
- P2-1 弹幕数据协议、P2-2 弹幕渲染、P2-3 弹幕设置（`openhongguo` 没有评论或弹幕接口，
  只有 `Episode.comment_count` 一个计数字段。上游弹幕走 `/novel/commentapi/comment/list/<vid>/v1/`，
  需要独立的 `X-Argus` + `metasec`（`app_id=3019`）签名体系，与 SDK 现有签名不是同一套。
  这是新增逆向工作，不是可吸收的实现）
- P2-6 局域网传输、P2-7 局域网同步（单机单用户）
- P2-8 多源管理、P2-9 浏览器 HEIC 解码、P2-10 自定义协议、P2-13 HTML 解析
  （当前架构下不适用）
- P2-11 解密放 Worker（1080p 14.8 MB 实测 18–20 ms，主线程阻塞可接受；
  只有单文件超过 100 MB 或并发解密数上升时才需要）
- 纯前端化迁移（见第 4 节）

**依赖实测或产品决策，暂不排期**

- P2-4 上新日历：需要先实测 `client.newReleases()` 是否返回 `published_at`。
  在确认字段存在前不排期。
- P2-14 批量下载：依赖「离线播放」是否要做（PWA + Cache Storage），未决策。
- P2-15 旋转元数据：需要一部真实竖屏样本，比对 `playback` 返回的 `width/height`
  与 `video.videoWidth/videoHeight`。不一致才需要处理。

---

## 6. 验证约定

本计划的每条都要按仓库根 `AGENTS.md` 的"测试范围"执行，不要动辄跑全量。

| 改动范围                         | 验证命令                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `shared`（mp4/cenc/schema）      | `pnpm hongguo:typecheck` + `pnpm --filter @mlzwl/hongguo-server test`（server 消费 shared） |
| `server/media`                   | `pnpm --filter @mlzwl/hongguo-server test`                                                  |
| `server/catalog`、`server/cover` | 同上                                                                                        |
| `web` 单点改动                   | `pnpm --filter @mlzwl/hongguo-web typecheck` + `lint`                                       |
| `web` 无测试文件                 | 手工验证，**不为它新建测试文件**                                                            |
| 文档                             | `pnpm exec prettier --check <file>`                                                         |

三条必须手工验证的（`apps/hongguo/AGENTS.md` 已规定）：

1. `/` 返回 HTML 200。
2. 深链 `/series/:id` 返回 HTML 200。
3. `/api/<不存在>` 返回 JSON 404。

**禁止事项**：任何验证都不得触发真实上游的写操作；不得读取或输出真实凭据；
mock 一律用 `127.0.0.1`。

---

## 7. 已确认与未确认

**已确认（读过源码，行为明确）**：P0-1、P0-2、P0-3、P0-4、P0-5、P0-6、P0-7、P0-8、
P0-9、P1-1、P1-2、P1-3、P1-4、P1-5、P1-6、P1-7、P1-8、P1-9、P1-10、P1-11、P1-12、
P1-13、P1-14、P1-15、P1-16、P1-17、P1-18、P1-19、P1-20、P1-21、P1-22、P1-23、P1-24、
P2-1、P2-2、P2-3、P2-4、P2-5、P2-12。

**推导（需要实测确认后才能排期）**：

- P2-4 上新日历：依赖上游是否返回发布日期，未实测。
- P2-14 批量下载：依赖"离线播放"是否要做，未决策。
- P2-15 旋转元数据：依赖上游 `width/height` 是否已考虑旋转，未实测。

**已转为实测结论**：

- P2-5 随机入口：`shortRank()` 结构已实测，并已用于 `/api/random` 与 `/api/ranking`。
- 榜单 `rank` 字段：实测有重复与跳号，改用 `position`。
- 榜单 `votes` 字段：实测恒为 `undefined`，不展示。
- 榜单 `score` 字段：实测是展示文本，原样透传。

**已知的上游约束（不要试图绕过）**：

- API 层有主动反盗链（`Origin` → `AUTHENTICATION_REQUIRED`），预检 403。
- 媒体 CDN 开放（206 + `ACAO: *`）。
- 搜索接口不返回 `cover_url`，必须用 `getSeriesBatch` 补（当前已实现）。
- `cover_expires_at` 字段不可靠，判断过期要解析 URL 的 `x-expires`。
