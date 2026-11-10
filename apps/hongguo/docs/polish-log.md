# 交互打磨记录

本文记录第二轮体验打磨的实测数据、修复项与残留问题。所有数字均来自
Playwright 在 `http://127.0.0.1:5173` 上的真实测量，不是估算。

- 后端：NestJS + Fastify，端口 `9133`
- 前端：Vite 8 + React 19，端口 `5173`（`/api` 代理到 `9133`）
- 浏览器：Playwright Chromium，视口 `1280×900`（桌面）与 `390×844`（移动）
- 测试剧集：`7700877562779536446`（共 104 集），第 1 集 `7700877568869665816`

---

## 1. 用户报告的三个问题

### 1.1 单击暂停，想调进度条却被暂停

**原因**：`<video onClick={togglePlay}>` 把单击绑成了播放/暂停。

**修复**：重新分配手势语义，与主流短视频一致。

| 手势 | 行为 |
| --- | --- |
| 单击 | 显示 / 隐藏控件（不改播放状态） |
| 双击 | 播放 / 暂停 |
| 长按 | 临时 2 倍速，松手恢复 |
| 上滑 / 下滑 | 下一集 / 上一集 |
| 左滑 / 右滑 | 快退 10 秒 / 快进 10 秒 |

单击与双击天然冲突。这里选择**把单击延迟 240ms**，等双击窗口结束再执行。
理由是误判成双击会让人莫名其妙暂停，代价大于 240ms 的延迟感。

**实测**：

| 操作 | `paused` | 控件可见 |
| --- | --- | --- |
| 初始 | false | true |
| 单击第 1 次 | **false** | false |
| 单击第 2 次 | **false** | true |
| 双击第 1 次 | **true** | - |
| 双击第 2 次 | **false** | - |

单击全程 `paused` 不变，问题解决。

### 1.2 拖动进度条时控件自动消失

**原因**：自动隐藏定时器固定 2600ms 触发，不识别「正在拖动」。

**修复**：改用 `ProgressBar` 组件自己实现，不再用 `<input type="range">`。

1. 拖动期间设置 `controlsLocked`，定时器回调检查该标记，锁定则跳过隐藏。
2. 用 `setPointerCapture`：手指拖出进度条范围后仍继续跟随。
3. 鼠标悬停在控件上（桌面端）同样锁定，不自动隐藏。
4. 拖动时主动 `pause()`，让画面停在拖动位置，避免画面与预览脱节。

**实测**（连续拖动 4 秒，每 500ms 采样）：

```
["down", 控件可见=true, 中央按钮=false]
[1, true, {now:125, 预览=1, playBtn=false}]
[2, true, {now:169, 预览=1, playBtn=false}]
[3, true, {now:212, 预览=1, playBtn=false}]
[4, true, {now:256, 预览=1, playBtn=false}]
[5, true, {now:300, 预览=1, playBtn=false}]
[6, true, {now:343, 预览=1, playBtn=false}]
[7, true, {now:387, 预览=1, playBtn=false}]
[8, true, {now:430, 预览=1, playBtn=false}]
```

9 个采样点控件全部可见，预览图全程存在，`aria-valuenow` 线性递增。
拖动 4 秒远超原 2.6 秒隐藏阈值，说明锁定生效。

**顺带修掉的问题**：拖动时会主动 pause，导致中央播放按钮出现在画面正中
挡住预览。现在该按钮的渲染条件加了 `scrubPreview === null`。

**边界实测**（移动端 390 宽，进度条 `x=54.2, width=281.5`）：

| 拖动位置 | seek 值 | 说明 |
| --- | --- | --- |
| 中点 | 272s | 约 545/2 |
| 右端内 2px | 541s | 未超过总时长 545 |
| 左端内 2px | 4s | 未低于 0 |
| 视口外 +200px | 129s（旧值） | 指针捕获后不再跳变 |

### 1.3 需要手动点「加载更多」

**修复**：新增 `apps/web/src/lib/use-infinite-scroll.ts`，用
`IntersectionObserver` 实现滚动到底自动加载，feed 与 search 两处接入。

**实测**（首页，每次滚到底后等 2 秒，卡片数按真实卡片统计）：

```
[15, 27, 33, 45, 57, 63]   ← 卡片数逐次增加
scrollHeight: 1482 → 4090
重复 key 报错: 0
```

持续滚动 12 秒只发了 3 次上游请求，卡片数稳定在 93，之后不再请求——
说明「到底即停」与防抖都生效。

---

## 2. 打磨中发现的真实缺陷

这些不在用户报告里，是自查发现的。

### 2.1 `IntersectionObserver` 首屏不触发

**症状**：首屏数据回来后，即使哨兵在视口内也永远不再请求。

**原因**：`IntersectionObserver` 只在「进入 / 离开」状态**变化**时回调一次。
挂载时 `hasNextPage` 还是 `false`，observer 已报告「进入」，之后数据到达把
`hasNextPage` 变成 `true`，但 observer 不会重新回调。

**修复**：拆成两段。observer 只记录「哨兵是否在视口内」并自增 `tick`；
单独的 effect 依赖 `[enabled, hasNextPage, isFetchingNextPage, tick]` 决定
是否发请求。任何条件从「不满足」变「满足」都会重新判定。

### 2.2 链式无限请求（最严重）

**症状**：滚到底后上游被连续打几十次，`cell/change/v` 请求持续不断。

**原因**两个叠加：

1. `fetchNextPage` 写成内联箭头函数，每次渲染都是新引用。它出现在 effect
   依赖数组里，于是每次渲染 effect 都重跑；只要哨兵还在视口内就再发一次。
2. `rootMargin: 800`。实测每页只增加约 340px 高度，800px 的预取范围意味着
   加载完一页后哨兵**仍在范围内**，条件永远成立。

**修复**：

- 回调改走 `fetchRef`，依赖数组只留布尔值和 `tick`。
- `rootMargin` 降到 `200px`，内容撑满后哨兵自然离开范围。
- `COOLDOWN_MS = 700` 限制最小间隔。
- 页数上限 40 页兜底。

**实测**：修复后卡片数按 `15 → 27 → 33 → 45 → 57 → 63` 平稳增长；
持续滚动 12 秒只发 3 次上游请求，随后停止，不再失控。

### 2.3 上游推荐流跨页重复

**症状**：控制台 28 条 `Encountered two children with the same key`。

**原因**：上游按 offset 分页，但同一部剧会跨页重复出现（第 3 页起就有）。
重复 key 会让 React 复用时行为不可预期，且「本页全是旧数据」时仍会无限请求。

**修复**：`getNextPageParam` 里检查本页是否有新 id，没有则返回 `undefined`
停止；同时用 `useMemo` 跨页去重，保留首次出现顺序。

**实测**：重复 key 报错 0 条，卡片无重复。

### 2.4 首页每次请求 2.5 秒

**症状**：每次进入首页都要看 2.5 秒骨架屏。

**原因**：服务端无缓存，每次都打上游 `discover`。

**修复**：新增 `apps/server/src/common/ttl-cache.ts`，带 TTL 与请求去重。

- feed 60s / series 5min / search 60s
- 并发未命中只发一次上游请求，其余等同一个 Promise
- **错误不缓存**：一次网络抖动不会让该 key 在 TTL 内一直返回错误

**实测**：

| 接口 | 冷 | 热 | 提速 |
| --- | --- | --- | --- |
| `/api/feed` | 2.607s | 0.0013s | ~2000× |
| `/api/series/:id` | 0.260s | 0.0016s | ~160× |

并发去重实测：5 个并发请求同一新 cursor，上游 `cell/change` 只增加 **1** 次。

前端同时把 `staleTime` 提到 5 分钟并关掉 `refetchOnMount`，切页回来不再重取。

### 2.5 长按倍速可能卡住

**症状**：长按后把指针拖出窗口再松手，`playbackRate` 停在 2，「2× 倍速中」
提示不消失。

**原因**：指针移出窗口后浏览器不再在元素上派发 `pointerup`，长按结束逻辑
永不执行。

**修复**：

1. `pointerdown` 时 `setPointerCapture`，后续事件一定回到本元素。
2. 补 `onLostPointerCapture`、窗口级 `pointerup` / `pointercancel` / `blur`
   三重兜底，全部指向同一个幂等的 `endLongPress()`。

**实测**（三个场景）：

| 场景 | 长按中 | 松手后 |
| --- | --- | --- |
| 正常松手 | 2 | **1** |
| 拖出窗口再松手 | 2 | **1** |
| 长按中触发 blur | 2 | **1** |

三个场景都恢复为 1，提示同步消失。

> 排查过程中的一个教训：早期几次测量显示「长按不生效」，是因为读取
> `playbackRate` 的时机早于 350ms 长按阈值。加上足够的等待后才是真实结果。

### 2.6 播放页没有选集入口

**症状**：只能靠桌面端左右按钮或移动端滑动切集，104 集想直接跳到第 50 集
做不到。

**修复**：新增 `apps/web/src/features/player/episode-drawer.tsx`，底部抽屉。

- 打开时自动 `scrollIntoView` 到当前集
- `overscroll-contain` 防止抽屉内滚动带动背景页面
- Esc 或点遮罩关闭

**实测**：104 集全部渲染，当前集（第 1 集）高亮并自动定位；点第 7 集后
URL 变为 `.../watch/7700877572459990040`，抽屉关闭，`readyState 4` 正常播放。

### 2.7 缺少 favicon

控制台 404。补 `apps/web/public/favicon.svg`（播放三角 + 品牌红），
并在 `index.html` 加 `link rel="icon"` 与 `meta description`。

### 2.8 控件隐藏后切集按钮还挂着

**症状**：单击隐藏控件后，桌面端「下一集」按钮仍显示在画面上。

**原因**：这两个按钮写在 `player-route.tsx` 的独立层里，不在 `Player` 内部，
所以不受 `showControls` 控制。

**修复**：把按钮移进 `Player`，用 `canPrev` / `canNext` 两个布尔入参控制显隐，
并统一受 `showControls` 约束。路由层只负责传 `currentIndex > 0` 等判断。

**实测**：

| 状态 | 控件可见 | 切集按钮 |
| --- | --- | --- |
| 显示 | true | `["下一集"]` |
| 隐藏 | false | `[]` |
| 再显示 | true | `["下一集"]` |

第 2 集实测同时显示 `["上一集", "下一集"]`，点「上一集」回到第 1 集。

### 2.9 选集格子的评论数溢出

**症状**：详情页选集网格里，四位数的评论数（如 `4335`）溢出按钮边界、
压住圆角，观感很脏。

**原因**：格子宽约 60px，评论数用 `absolute right-1 top-0.5` 绝对定位，
但没有限制宽度也没有裁剪，四位数就顶出去了。

**修复**：按钮加 `overflow-hidden`，评论数 `max-w-[calc(100%-4px)]` +
`overflow-hidden`，保证无论多长都裁在格子内。

**实测**：104 集全部显示评论数，`getBoundingClientRect` 逐项比对无一处
超出按钮边界（`overflowing: []`）。

> 中途走过一个错方向：先把「小于一万不显示」作为修复，结果 104 集全部
> 消失（该剧计数都在一万以下），信息丢了。裁剪容器才是对的。

---

## 3. 完整交互回归

在 9133 / 5173 双服务、桌面视口下逐项实测。

| # | 项 | 操作 | 实测结果 |
| --- | --- | --- | --- |
| 1 | 视频加载 | 进入播放页 | `readyState 4`，`1280×720`，时长 544.8s |
| 2 | 单击切控件 | 连点 2 次 | `paused` 始终 false，控件 false→true |
| 3 | 双击暂停 | 双击 2 次 | true → false |
| 4 | 拖动进度条 | 连拖 4s | 控件全程可见，预览 9/9 存在，中央按钮始终不出现 |
| 5 | 拖动边界 | 拖到左右端外 | 541s / 4s，不越界 |
| 6 | 长按倍速 | 按 1s 松手 | 1 → **2** → 1，提示同步 |
| 7 | 上滑切集 | 模拟 pointer 序列 | 第 1 集 → 第 2 集，URL 同步 |
| 8 | 左右滑 | 右滑后左滑 | +10.6s / -9.4s |
| 9 | 键盘 → | ArrowRight | +10.4s |
| 10 | 键盘 空格 | 按两次 | 暂停 → 恢复 |
| 11 | 倍速循环 | 点 3 次 | 1.25 → 1.5 → 2 |
| 12 | 观看历史 | 跳到 120s | 写入 `pos 121.5 / dur 544.8` |
| 13 | 续播 | 重新进入 | 恢复到 `122.9s`，`readyState 4` |
| 14 | 选集抽屉 | 点「选集」 | 104 集，当前集高亮 |
| 15 | 切集 | 点第 7 集 | 抽屉关闭，第 7 集播放（69s） |
| 16 | 搜索 | 搜「长生」 | 10 条结果，封面 10/10，0 张破图 |
| 17 | 搜索自动加载 | 搜「总裁」滚到底 4 次 | 稳定 14 条并显示「没有更多了」 |
| 18 | 历史页 | 进入 | 1 条记录，显示「第 1 集」 |
| 19 | 首页自动加载 | 滚到底 6 次 | 15 → 27 → 33 → 45 → 57 → 63，0 重复 key |
| 20 | 移动端 feed | 390×844 | 2 列（177px×2），无横向溢出 |
| 21 | 移动端播放 | 390×844 | 控件底边 844 = 视口高，无纵向滚动 |
| 22 | 切集按钮随控件 | 单击隐藏/显示 | 隐藏时按钮消失，显示时恢复 |
| 23 | 上一集按钮 | 第 2 集点上一集 | 回到第 1 集，URL 同步 |
| 24 | 详情页选集 | 进入详情页 | 104 集，评论数无溢出（逐项 rect 比对） |

**截图**（项目根目录）：

| 文件 | 内容 |
| --- | --- |
| `final-feed.png` | 桌面首页，6 列 |
| `final-scrub.png` | 拖动中，预览图跟随、无中央按钮 |
| `final-drawer.png` | 选集抽屉，当前集高亮 |
| `final-search.png` | 搜索结果带封面 |
| `final-history.png` | 观看历史 |
| `final-m-feed.png` | 移动端首页 2 列 |
| `final-m-player.png` | 移动端播放页 |
| `final-controls-shown.png` | 桌面控件显示态（含切集按钮） |
| `final-controls-hidden.png` | 桌面控件隐藏态（画面干净、无切集按钮） |
| `final-longpress.png` | 长按 2 倍速，顶部提示 |
| `final-series.png` | 详情页，104 集选集与评论数 |

---

## 4. 代码检查

```
pnpm -r typecheck   → 3 个包全部 Done
pnpm -r lint        → 3 个包全部 Done
pnpm -r test        → shared 10 passed / server 13 passed / web 无测试文件
pnpm -r build       → shared / server / web 全部 Done
                       web 产物 323.04 kB JS（gzip 100.45 kB）
```

`apps/web` 没有测试文件。本轮所有验证通过 Playwright 真实浏览器完成，覆盖
手势、拖动、滚动、缓存等纯交互行为——这类行为用单元测试反而验证不到。
未新增测试文件，遵循项目现状。

---

## 5. 本轮改动文件

新增：

| 文件 | 作用 |
| --- | --- |
| `apps/web/src/lib/use-infinite-scroll.ts` | 滚动自动加载（两段式 + 三层防抖） |
| `apps/web/src/features/player/progress-bar.tsx` | 自实现进度条（指针捕获、预览跟随） |
| `apps/web/src/features/player/episode-drawer.tsx` | 选集抽屉 |
| `apps/server/src/common/ttl-cache.ts` | TTL 缓存 + 请求去重 |
| `apps/web/public/favicon.svg` | 站点图标 |

修改：

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/features/player/player.tsx` | 重写手势语义、控件锁定、键盘、选集入口、拖动隐藏中央按钮 |
| `apps/web/src/features/player/use-gestures.ts` | 指针捕获 + 三重长按兜底 |
| `apps/web/src/routes/player-route.tsx` | 接入手势切集、选集抽屉、下一集预取 |
| `apps/web/src/routes/feed-route.tsx` | 自动加载、跨页去重、到底停止 |
| `apps/web/src/routes/search-route.tsx` | 自动加载、跨页去重 |
| `apps/web/src/routes/series-route.tsx` | 评论数裁剪 |
| `apps/web/src/lib/format.ts` | `shouldShowCount` 判断 |
| `apps/web/src/app.tsx` | Query 默认参数调整 |
| `apps/web/index.html` | favicon + description |
| `apps/server/src/catalog/catalog.service.ts` | feed / series / search 接入 TTL 缓存 |

未改动：`packages/shared/src/{cenc,spade,mp4,bytes}.ts`、`apps/server/src/media/*`、
`apps/server/src/cover/*`。CENC 解密、spade 密钥派生、雪碧图切分逻辑保持原样。

---

## 6. 残留问题

以下项未在本轮处理，按影响排序。

1. **首次播放仍需等待**。第 1 集 7.9MB 下载 + 解密约 1 秒，换集再等一次。
   已预取下一集的 `playback` 元数据，但没有预取媒体流。可选方案：播放时
   并行预取下一集媒体，或做边下边解。
2. **竖屏视频未适配**。实测 6 集全部 `1280×720` 横屏，用 `object-contain`
   正常。若遇到竖屏短剧，`object-contain` 会在两侧留黑边，应改 `object-cover`。
   目前没有竖屏样本，无法验证。
3. **Firefox 不支持 HEVC**。上游是 HEVC，Firefox 无法解码。当前只做播放失败
   提示，没有提前探测能力。
4. **`playback` 表未落库**。数据库 schema 里有 `playback` 表，但目前只写
   localStorage 历史，服务端播放记录未持久化。
5. **雪碧图与封面无淘汰策略**。磁盘缓存会持续增长，需要 cron 清理。
6. **双击点赞、长按收藏未接 UI**。手势层已支持，但红果没有点赞接口，
   属产品决策项。
7. **真机移动端未测**。移动端验证基于 390×844 视口模拟，未在真实 iOS /
   Android 设备上验证触摸手感与 HEVC 硬解表现。
8. **`ROUTE` 层无错误边界**。接口异常时显示错误文案，但组件渲染异常没有
   `ErrorBoundary` 兜底。

---

## 7. 复现命令

```bash
# 依赖
pnpm i

# 后端（端口 9133）
cd apps/server && npx tsc -p tsconfig.build.json && node dist/main.js

# 前端（端口 5173，/api 代理到 9133）
cd apps/web && npx vite --host 127.0.0.1

# 全部检查
pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build
```

打开 <http://127.0.0.1:5173/>。
