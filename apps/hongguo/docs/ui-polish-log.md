# UI/UX 改造记录

本文记录第三轮改造：三个用户报告的问题 + 基于 `ui-ux-pro-max` 的系统性 UI 优化。

- 后端 `9133`，前端 `5173`
- 验证方式：Playwright 真实鼠标 / 触摸事件（不用 `page.evaluate` 直接调 `.click()`）
- 技能位置：`.agents/skills/ui-ux-pro-max`（从 `nextlevelbuilder/ui-ux-pro-max-skill` 克隆）

---

## 1. 技能安装

```bash
git clone --depth 1 https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git
cp -R .claude/skills/ui-ux-pro-max <project>/.agents/skills/
```

只取了 `ui-ux-pro-max` 本体（3.6MB），没有拉 `ui-styling`（5.8MB）等其他
skill，避免仓库膨胀。目录内容：`SKILL.md`、`data/`（CSV 知识库）、
`references/`、`scripts/search.py`、`LICENSE`。

搜索入口：

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain <domain>
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system
```

---

## 2. 问题一：播放页按钮全部失效

### 2.1 复现

用真实鼠标点击，并记录事件落点：

```
clicks:      [["DIV", "返回\n\n这系统赋"], ["DIV", "返回\n\n这系统赋"]]
pointerdowns:[["VIDEO", ""], ["BUTTON", "选集"]]
```

`pointerdown` 落在 `BUTTON` 上，但 `click` 落在最外层 `DIV` 上。

实测失效清单：返回、上一集、下一集、静音、倍速、选集。

### 2.2 根因

上一轮为修「长按倍速卡住」在 `pointerdown` 里立刻调了
`setPointerCapture`。指针捕获会把**后续所有指针事件**重定向到捕获元素，
浏览器因此判定 `pointerup` 不在按钮上，`click` 就不会派发到按钮。

这是上一轮修复引入的回归：修好了长按，弄坏了所有按钮。

### 2.3 修复

`web/src/features/player/use-gestures.ts` 两处改动：

1. **按在交互控件上直接让路**。新增 `isInteractive()`：从 `target` 逐层
   上溯到手势容器，命中 `button, a, input, select, textarea,
   [role="slider"], [data-no-gesture]` 任一即返回 true。命中时整段手势
   跳过——不捕获、不启长按定时器、不记录起点。
2. **指针捕获延迟到长按成立时**。原来 `pointerdown` 就捕获；现在等
   350ms 长按真正触发后才捕获。此时用户已按住 350ms，不可能是想点按钮。

长按结束的兜底保留四重：`onPointerUp`、`onLostPointerCapture`、
窗口级 `pointerup` / `pointercancel` / `blur`，全部指向幂等的
`endLongPress()`。

### 2.4 实测

| 按钮 | 点击前 | 点击后 |
| --- | --- | --- |
| 返回 | `/watch/7700877569842760728` | `/series/7700877562779536446` |
| 上一集（第 2 集） | 第 2 集 | 第 1 集 |
| 下一集（第 1 集） | 第 1 集 | 第 2 集 |
| 静音 | `muted=false` | `muted=true` |
| 倍速 | `1×` / rate 1 | `1.25×` / rate 1.25 |
| 选集 | 抽屉关闭 | 抽屉打开，78 集（另一个系列 104 集） |

手势回归（确认没被改坏）：

| 场景 | 结果 |
| --- | --- |
| 长按 1s 松手 | rate 1 → **2** → 1，提示同步 |
| 长按后拖出窗口松手 | rate 2 → **1**，提示消失 |
| 单击两次 | `paused` 始终 false |
| 双击 | `paused` true → false |

---

## 3. 问题二：头部未始终固定

### 3.1 复现

改前逐页量 `header.getBoundingClientRect().top`：

| 页面 | 滚动前 | 滚动 552px 后 |
| --- | --- | --- |
| 首页 `/` | 0（`sticky`） | 0 |
| 搜索 `/search` | 0（`sticky`） | 0 |
| 历史 `/history` | 0（**普通流**） | 跟着滚走 |
| 详情 `/series/:id` | 0（**无 header**） | 返回按钮 `top=-539` |

两个真实缺陷：
1. 历史页顶栏没有 `sticky`，一滚就消失。
2. 详情页根本没有顶栏，只有一个随内容滚走的「返回」按钮。

另外两个已 `sticky` 的页面也有隐患：`pt-safe` 加在**页面容器**上而不是
顶栏内部，刘海屏下安全区 padding 会随滚动一起移出视口。

### 3.2 修复

新建 `web/src/components/page-header.tsx`，四个路由统一使用。
设计依据是 `ui-ux-pro-max` 的 Sticky Navigation 条目：

> **Do:** Add padding-top to body equal to nav height
> **Don't:** Let nav overlap first section content

这里用 `sticky` 而不是 `fixed`：`sticky` 元素本身占据流内空间，天然不需要
额外 padding 补偿，也不会在横屏或动态字号下算错高度。`fixed` + 手工 padding
一旦高度变化就会错位。

三个必须满足的条件写进了组件注释：
1. `sticky top-0` 始终固定；
2. `pt-safe` 放在 sticky 元素**内部**，安全区跟随；
3. `bg-surface/80 + backdrop-blur-xl`，滚动内容不会和标题叠字。

`#root` 显式 `overflow: visible`：祖先链上任何 `overflow: hidden/auto` 都会让
`sticky` 退化成普通定位。

顺带把顶栏按钮的命中区域统一为 `h-11`（44px），满足触摸目标要求。

### 3.3 实测

| 页面 | 滚动前 top | 滚动 500px | 滚动 1332px | position | z-index | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- |
| 首页 | 0 | 0 | 0 | sticky | 30 | 无 |
| 搜索 | 0 | 0 | 0 | sticky | 30 | 无 |
| 历史 | 0 | 0 | 0 | sticky | 30 | 无 |
| 详情 | 0 | 0 | 0 | sticky | 30 | 无 |

详情页顶栏现在显示剧名（`这系统赋我长生，我熬死了所有人`）；首页滚动后顶栏仍在顶部。

---

## 4. 问题三：进度条只有拖拽才有预览

### 4.1 复现

`progress-bar.tsx` 原第 107 行：

```tsx
{drag !== null && renderPreview !== undefined && (...)}
```

预览只在 `drag !== null` 时渲染，悬停只改滑块与轨道粗细的 class，没有任何
预览。

### 4.2 修复

新增 `hover` 状态，预览条件改为 `(drag ?? hover) !== null`：

- `onPointerMove` 里判断 `event.pointerType === 'mouse'` 才记录悬停位置。
  不用 `@media (hover: hover)`：该媒体查询在「带触摸屏的笔记本」这类混合
  输入设备上不可靠，而 `pointerType` 精确描述「这次真的是鼠标」。
- `onPointerLeave` 收起预览，但拖动中不收起（交给 `finish`）。
- 移动端零成本：触摸的 `pointerType` 是 `touch`，永远不进悬停分支。

### 4.3 顺带修掉一个真实缺陷

复测触摸拖动时发现**拖动全程没有预览**。原因：

```ts
event.currentTarget.setPointerCapture(event.pointerId)  // 这里抛错
setDrag(seconds)                                        // 就永远不执行
```

用合成 `PointerEvent` 时 `pointerId` 没有对应的活动指针，`setPointerCapture`
抛 `NotFoundError`，异常往上冒，后面的 `setDrag` 被跳过。真机上 pointerId
有效，所以之前手测没暴露。已加 `try/catch`。

### 4.4 实测

桌面悬停（真实 `mouse.move`，无按下）：

| 悬停位置 | 预览可见 | 预览文字 | 有雪碧图 |
| --- | --- | --- | --- |
| 未悬停 | 否 | – | – |
| 20% | 是 | `1:48` | 是 |
| 50% | 是 | `4:32` | 是 |
| 80% | 是 | `7:15` | 是 |
| 移出轨道 | 否 | – | – |

截图 `ui-hover-preview.png`：预览浮层在滑块上方，显示雪碧图帧 + `4:32`。

移动端触摸（`pointerType=touch`）：

| 场景 | 预览 | 结果 |
| --- | --- | --- |
| 未触摸 | 无 | 正确，无悬停残留 |
| 仅触摸移动（未按下） | 无 | 正确，移动端不引入 hover 依赖 |
| 按下拖动 | `4:32` → `5:26` → `6:21` | 正确，实时跟随 |
| 松手 | 无 | 正确收起，seek 到 382s |

---

## 5. UI/UX 系统改造

### 5.1 技能查询记录

按 goal 要求，每条查询原文与采用/否决理由：

| # | 查询 | 域 | 结果 | 采用/否决 |
| --- | --- | --- | --- | --- |
| 1 | `short drama video streaming app dark theme` | design-system | 推荐 Dark Mode (OLED) + Hero-Centric | **部分采用**：暗色配色与「影院暗 + 播放红」采用；Hero-Centric 否决（短剧首页是网格流，没有单一 hero） |
| 2 | `sticky header navigation scroll` | ux | Sticky Navigation：需 padding-top 补偿 | **采用**，但用 `sticky` 而非 `fixed`（无需补偿） |
| 3 | `video scrub preview hover seek` | ux | Hover vs Tap：不能只靠 hover | **采用**：hover 只是增强，移动端拖动完整可用 |
| 4 | `video player controls interaction` | ux | Focus States / Auto-Play Video | **采用**：焦点环；自动播放否决（短剧就是自动播，但加了暂停与控件） |
| 5 | `streaming entertainment video app` | product | Video Streaming/OTT → Dark Mode (OLED) + Motion-Driven | **采用**暗色；Motion-Driven 否决（Excessive Motion 要求每屏 1–2 处动效） |
| 6 | `dark cinematic red accent` | color | Accent `#E11D48`，Muted FG `#94A3B8` | **采用** accent（对比度原因见 5.2）；muted fg 否决（当前 `#a1a1aa` 对比度 7.72:1 已优于 8.19:1 候选的可读性平衡） |
| 7 | `cinematic immersive dark` | style | Parallax Storytelling | **否决**：Performance cost:high，Accessibility risk:high，不符合短剧列表的性能要求 |
| 8 | `dark cinematic streaming` | typography | Inter / Inter，700 带 -1.5 tracking | **部分采用**：标题加 `tracking-tight`；不引入 Google Fonts 外链（国内网络不稳定，且有 FOIT 风险），继续用系统字体栈 |
| 9 | `touch target size mobile` | ux | 44pt iOS / 48dp Android，间距≥8px | **采用**：所有顶栏与播放控件 `h-11`（44px） |
| 10 | `color contrast accessibility` | ux | 正文至少 4.5:1 | **采用**，并因此发现真实缺陷（5.2） |
| 11 | `reduced motion animation` | ux | 检查 `prefers-reduced-motion` | **采用**，全局生效（5.4） |
| 12 | `dark mode elevation layering` | ux | 用玻璃材质与 z-offset | **采用**：黑底上不用阴影，改用 `ring-1 ring-white/8` + 背景渐变分层 |
| 13 | `focus visible keyboard` | ux | 每个可交互控件都要可见焦点环 | **采用**，但输入框例外（5.5） |
| 14 | `card grid layout mobile` | ux | 用 dvh 不用 100vh | **已满足**：项目一开始就用 `100dvh` |

### 5.2 发现并修复的真实无障碍缺陷

**主按钮上的白字对比度不足。** 原 `--color-accent: #ff2d55`，白字对比度：

| 组合 | 对比度 | AA 4.5:1 |
| --- | --- | --- |
| 白字 on `#ff2d55`（原） | **3.65:1** | 不合格 |
| 白字 on `#e11d48`（新） | **4.70:1** | 合格 |
| `#e11d48` on `#0a0a0a` | 4.21:1 | 图形元素 3:1 合格 |

影响面：「开始观看」「搜索」等所有主按钮。改为 `#e11d48`，仍是红果的红。

同时拆出一个专门用于**文字**的红色变量：

| 变量 | 值 | 用途 | 对比度 |
| --- | --- | --- | --- |
| `--color-accent` | `#e11d48` | 色块 / 按钮底 | 白字 4.70:1 |
| `--color-accent-soft` | `#fb7185` | 红色文字 / 焦点环 | on surface **7.36:1**，on raised **6.70:1** |

### 5.3 头部统一

新建 `web/src/components/page-header.tsx`，四个路由共用。组件注释里写清了三条
约束（sticky 占位、`pt-safe` 放内部、半透明背景）。

| 页面 | 改前 | 改后 |
| --- | --- | --- |
| 首页 | 自实现 sticky | 统一组件 |
| 搜索 | 自实现 sticky，**两行 103px** | 统一组件，**单行 49px** |
| 历史 | 普通流，一滚就没 | sticky 49px |
| 详情 | **没有顶栏** | sticky 49px，居中显示剧名 |

搜索页原本把输入框放在 `children`，导致顶栏占两行。改为返回按钮与输入框
同行，顶栏回到 49px。

### 5.4 动效与 reduced-motion

全局 `@media (prefers-reduced-motion: reduce)` 把 animation / transition /
scroll-behavior 全部降到 0.01ms。卡片封面放大额外加了 `motion-reduce:`
变体。

实测：

| 媒体查询 | 封面 transition-duration | 骨架屏 animate-pulse |
| --- | --- | --- |
| `no-preference` | `0.3s` | 运行 |
| `reduce` | `1e-05s` | 不运行（`motion-reduce:animate-none`） |

### 5.5 焦点可见

全局 `:focus-visible` 给 2px `accent-soft` 描边。实测 Tab 到「搜索」按钮：

```
outline: solid 2px rgb(251, 113, 133)
```

**输入框例外**：`:focus-visible` 对文本框总是命中，`autoFocus` 的搜索框一
进页就带着一圈红环（截图确认）。已加 `input:focus-visible { outline: none }`，
焦点状态由 `ring` 表达。实测输入框 `outline: none`，按钮仍有环。

### 5.6 暗色层级

黑底上阴影不可见，改用三样东西分层（`ui-ux-pro-max` 的 Depth Layering）：

| 层级 | 背景 | 建立方式 |
| --- | --- | --- |
| 页面 | `#0a0a0a` | — |
| 卡片 | `#16161a` | `ring-1 ring-white/8` 描边 |
| 浮层 | `#1f1f24` | hover 时 `bg-surface-overlay` |
| 顶栏 | `surface/80` | `backdrop-blur-xl` + 下边框 |

实测卡片 `box-shadow` 含 `oklab(0.999994 ... / 0.08) 0px 0px 0px 1px`，即
1px 白色 8% 描边，确实生效。

### 5.7 触摸目标

播放页所有按钮实测：

| 控件 | 宽 | 高 | 44px 达标 |
| --- | --- | --- | --- |
| 返回 | 44 | 44 | 是 |
| 上一集 | 84 | 44 | 是 |
| 下一集 | 84 | 44 | 是 |
| 静音 | 52 | 44 | 是 |
| 倍速 | 43 | 44 | 是（宽 43 但高 44，且两侧有 8px 间距） |
| 选集 | 52 | 44 | 是 |

详情页 104 个选集格子：最小高度 **44px**，溢出 **0** 个。

### 5.8 详情页重设计

改前：纯黑底 + 左封面右文字 + 5 列网格，评论数绝对定位在右上角。

改后：

1. **模糊封面背景**：用封面自身的放大模糊版填充首屏，`opacity-25` +
   渐变蒙层。纯装饰，`pointer-events-none`，不随滚动变化。
2. **信息卡**：集数、可播放状态做成 `bg-white/8` 胶囊标签。
3. **主按钮**：加播放图标，`h-11` 满足触摸目标。
4. **选集格子**：评论数从右上角绝对定位改为**集号下方纵向排列**。
   原因：5 列时格子宽约 60px，绝对定位的 4 位数（如 `4325`）会压到边框上。
   纵向排列宽度天然够，配合 `truncate` 永不溢出。
5. **正序/倒序切换**：104 集时正序要滑很久才能看到最新集，这是真实需求。

实测：

| 项 | 结果 |
| --- | --- |
| 选集格子数 | 104 |
| 最小高度 | 44px |
| 横向溢出格子 | **0** |
| 评论数可见 | 104/104（数据 10–4325，全部显示） |
| 正序 → 倒序 | `[1,2,3]` → `[104,103,102]`，按钮文案同步变 |
| 顶栏 sticky | `top: 0` |

### 5.9 播放页控件

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 返回 | 文本胶囊「返回」 | 44×44 图标按钮（chevron） |
| 切集按钮 | 纯文本 | 图标 + 文本，`h-11` |
| 底部控件 | `py-1.5`（高 36px） | `h-11`（44px） |
| 渐变遮罩 | `from-black/70` | `from-black/75 via-black/35` 两层 |
| 辅助文字 | `text-white/40` | `text-white/35`（降噪） |

### 5.10 历史页重设计

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 进度 | 只有一根细条 | 细条 + **百分比数字** |
| 删除 | 文本「删除」 | 44px 宽的 X 图标按钮，hover 有底色 |
| 卡片 | 无描边 | `ring-1 ring-white/8` |
| 顶栏 | 普通流 | sticky 49px |

### 5.11 卡片视觉

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 层级 | 无描边 | `ring-1 ring-white/8`，hover 变 `/16` |
| 集数角标 | `bg-black/70` | `bg-black/65` + `backdrop-blur-sm` + 底部渐变打底 |
| hover | 封面放大 1.05（无时长限制） | 1.04 + `duration-300` + `motion-reduce` 关闭 |
| 骨架屏 | 无描边 | 与真实卡片同尺寸描边，避免加载后跳动 |

### 5.12 回归验证

完整链路实测（1280×900，真实鼠标）：

| 步骤 | 结果 |
| --- | --- |
| 首页加载 | `/`，9 张卡片 |
| 点第一张卡 | `/series/7678638019280112702`，标题正确 |
| 点「开始观看」 | `/watch/7678678025646394430`，`readyState=4` |
| 点「返回」 | `/series/7678638019280112702` |

移动端（390×844）：

| 页面 | 横向溢出 | 关键指标 |
| --- | --- | --- |
| 首页 | 无 | 9 张卡片 |
| 搜索 | 无 | 6 张卡片，顶栏 49px，滚动后 top=0 |
| 历史 | 无 | 2 条记录，百分比进度条 |
| 播放 | 无 | 无纵向滚动；控件底边 = 844 = 视口高；4 个按钮均 44px |

---

## 6. 截图清单

仓库根目录 8 张截图：

| 文件 | 内容 |
| --- | --- |
| `ui-hover-preview.png` | 桌面悬停进度条 50% 处，雪碧图 + `4:32` |
| `ui-touch-scrub.png` | 移动端触摸拖动中，预览 `6:21` |
| `ui-series-new.png` | 详情页重设计（模糊背景 + 纵向评论数 + 倒序） |
| `ui-player-new.png` | 播放页控件（44px 图标按钮） |
| `ui-m-feed.png` | 移动端首页（卡片描边层级） |
| `ui-m-search.png` | 移动端搜索（单行顶栏 49px） |
| `ui-m-history.png` | 移动端历史（百分比进度） |
| `ui-m-player.png` | 移动端播放页（无溢出，控件贴底） |

---

## 7. 代码检查

```
pnpm -r typecheck   3 个包全部通过
pnpm -r lint        3 个包全部通过（0 warning）
pnpm -r test        shared 10 通过，server 13 通过，web 无测试文件
pnpm -r build       web 329.94 kB JS / 101.98 kB gzip
```

---

## 8. 变更文件

新增：

- `web/src/components/page-header.tsx`
- `docs/ui-polish-log.md`

修改：

- `web/src/features/player/use-gestures.ts`（按钮失效根因修复）
- `web/src/features/player/progress-bar.tsx`（hover 预览 + 触摸预览修复）
- `web/src/features/player/player.tsx`（控件尺寸与图标）
- `web/src/routes/{feed,search,series,history}-route.tsx`（统一顶栏与重设计）
- `web/src/components/series-card.tsx`（层级与动效）
- `web/src/styles/index.css`（配色对比度、焦点环、reduced-motion）

未动：`shared/src/{spade,mp4,cenc,bytes}.ts`、`server/src/media/*`。

---

## 9. 遗留问题

1. **详情页无分类标签**。`/api/series` 响应不含 `category`，所以只展示了
   「N 集」和「可播放」。要加分类需要上游接口改动。
2. **顶部安全区在桌面端无效**。`env(safe-area-inset-top)` 在桌面浏览器为 0，
   只在真机/模拟器上才看得出差异。
3. **没有水平滚动条样式**。当前所有页面均无横向溢出，不需要。
4. **暗色主题只有一套**。不做浅色主题是产品决定，不是遗漏。
5. **搜索页无历史关键词**。需要额外的本地存储与 UI，本轮未做。
6. **未在真机 iOS/Android 上验证**。`pointerType`、安全区、`dvh` 三个特性
   都只在 Chromium 里验证过。

---

## 10. 移动端 video 属性防御（2026-11）

小米 / Redmi 浏览器会在播放 `<video>` 时弹出自家的「视频助手」浮层，接管
手势与全屏。这是浏览器应用层功能，Web 侧没有可靠的关闭开关。本轮只加标准
属性与内核私有属性做尽力而为的防御，**不保证能解决**，需要真机验证。

### 已加的属性

| 属性 | 值 | 作用 |
| --- | --- | --- |
| `disablePictureInPicture` | （布尔） | 关闭画中画，避免 PiP 窗口被系统接管 |
| `controlsList` | `nodownload nofullscreen noremoteplayback` | 约束 UA 原生控件的下载/全屏/远程播放入口 |
| `x5-video-player-type` | `h5` | 腾讯 X5 内核改用 H5 播放器，不用原生播放器 |
| `x5-playsinline` | `true` | X5 内联播放开关 |
| `webkit-playsinline` | `true` | 旧 WebKit 内联播放开关 |

值都要按字符串比较，空字符串不被识别：`x5-video-player-type` 必须是 `"h5"`，
`x5-playsinline` 与 `webkit-playsinline` 必须是 `"true"`。

`controlsList` 在当前实现里基本冗余：`<video>` 没有 `controls` 属性，全屏是对
容器调 `requestFullscreen`。保留它是因为某些浏览器会强制显示原生控件，那时
这些 token 仍然生效。它不构成安全边界。

以上属性不改变 CENC 原地解密与 Range 契约。桌面端会忽略未知属性。

### 真机验证步骤

1. 手机与电脑连同一个 Wi-Fi。电脑上启动服务：`pnpm hongguo:build && node apps/hongguo/server/dist/main.js`。
2. 查电脑局域网 IP：`ipconfig getifaddr en0`（macOS）。
3. 手机浏览器打开 `http://<IP>:9133/`，进入任意剧集，点「开始观看」。
4. 观察三件事：
   - 播放开始后，屏幕是否弹出小米/Redmi 的「视频助手」浮层。
   - 在视频上左右滑动，是否被系统手势劫持（比如变成系统音量/亮度）。
   - 点自研全屏按钮，是否进入容器全屏而不是系统播放器。
5. 如果仍被接管，说明该浏览器的接管逻辑不看这些属性。此时可尝试的下一步是
   在浏览器设置里关闭「视频助手」，或换用 Chrome / Edge。Web 侧没有更多手段。
6. 桌面 Chrome 打开同一地址，确认播放、全屏、切集、下载都正常，属性不影响
   桌面行为。

### 结果记录

待真机验证后补充。**当前状态：未在真机验证，不声称已修复。**
