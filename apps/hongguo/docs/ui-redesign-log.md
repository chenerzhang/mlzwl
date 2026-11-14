# UI 重构与双主题改造日志

本轮目标：把 hongguo 网页版从「能用」提升到「好看且手感对」，同时修掉 4 个明确缺陷。
本文按「先测、再改、再复测」的顺序记录，每一条结论都附实测数值。

测量环境：

| 项目 | 值 |
| --- | --- |
| 前端 | `http://127.0.0.1:5173`（Vite 8 dev server） |
| 后端 | `http://127.0.0.1:9133`（NestJS + Fastify） |
| 视口 | 桌面 `1440×900`，移动 `390×844`；响应式补测 `375×812` / `768×1024` / `1024×768` |
| 主题 | `dark` / `light` 两套，共 4 组组合 |
| 浏览器 | Chromium（Playwright MCP），真实 `mouse.click` / `keyboard.type` |
| Tailwind | 4.3.5 |
| 测量脚本 | 见 `scripts/ui-audit.mjs`，逐元素读 `getComputedStyle` |

测量方法上有一个必须说明的坑：Tailwind 4 会把 `bg-scrim/65` 这类带透明度的颜色
编译成 `oklab(0 0 0 / 0.65)`。手写正则只认 `rgb()/rgba()`，遇到 `oklab` 会返回
`null`，对比度就算成 `1.00` 的假失败。第一版脚本因此报了 15 个不存在的「图形对比度
失败」。最终方案是用 1×1 canvas 的 `fillStyle` + `getImageData` 解析颜色，浏览器
认识的全部颜色语法都能拿到 sRGB 分量和 alpha。

---

## 1. 设计系统（ui-ux-pro-max）

### 1.1 生成 MASTER.md

```
python3 .agents/skills/ui-ux-pro-max/scripts/search.py \
  "short drama video streaming app dark light theme" \
  --design-system --variance 6 --motion 4 --density 5 -p "Hongguo" --persist
```

返回结果（原文摘要）：

- Category：`Video Streaming/OTT`
- 配色主题：`Cinema dark + play red`
- 字体：Inter / Inter
- Motion：`Stagger List 300–450ms back.out(1.4)`
- Anti-patterns：静态布局、慢播放器

产物落在 `design-system/hongguo/MASTER.md`（233 行），`design-system/hongguo/pages/` 为空，
所以本轮所有页面都遵循 Master 文件。

### 1.2 对 MASTER.md 的采纳与否决

| MASTER.md 建议 | 处置 | 理由 |
| --- | --- | --- |
| Accent `#E11D48` | **采纳**（深色） | 白字在其上 4.70:1，过 4.5 线 |
| Accent `#E11D48` | **否决**（浅色） | 浅色下白字仍 4.70，但红字放在浅底上只有 3.6，另设 `#d61f45`（5.07）与 `#be123c`（6.29） |
| Background `#000000` | **否决** | 纯黑 + 卡片 `#0C0C0D` 只差 1.02:1，卡片边界完全消失。改用 `#0a0a0a` 打底、`#16161a` 抬升 |
| Border `#312E81`（靛蓝） | **否决** | 靛蓝在 `#0a0a0a` 上对比度 2.2:1，达不到 3:1，而且和红色 accent 撞色。改用中性灰 `#71717d`（4.11/3.75/3.41） |
| Google Fonts `@import` Inter | **否决** | 违反「不引入 Google Fonts 外链」约束。改用系统字体栈 `-apple-system, "PingFang SC", …`，中文渲染质量更好 |
| Stagger List `back.out(1.4)` | **否决** | 播放器/列表是高频操作界面，回弹缓动会让每次翻页都「弹一下」。改成 200–300ms `ease-out` |
| Density 5/10 | **采纳** | 卡片间距 12px、页面左右 12–20px，与 8dp 节奏一致 |

### 1.3 逐页/逐域查询

| 查询原文 | 域/栈 | 返回规则名 | 处置 | 理由 |
| --- | --- | --- | --- | --- |
| `search empty state no results` | `--domain ux` | `No Results`（Do: Show "No results" with suggestions，Severity Medium） | **采纳** | 空状态加图标 + 标题 + 说明 + 可点推荐词 |
| `search input focus ring` | `--domain ux` | `Input Labels`（Severity High） | **部分采纳** | 补 `aria-label="搜索短剧"`；焦点环按用户要求改成非红色 |
| `grid skeleton placeholder row` | `--domain ux` | `Content Jumping`（Do: Reserve appropriate space or keep async states in a stable content-driven container，High） | **采纳** | 骨架合并进同一 grid，按真实列数补齐 |
| `theme toggle control` | `--domain ux` | 返回 `Auto-Rotating Content` / `Cancellable State Transitions` | **否决** | 与主题切换无关，属检索噪声 |
| `button cursor pointer` | `--stack html-tailwind` | `Buttons / Icon buttons`（aria-label，High）+ Button sizing | **采纳** | 图标按钮全部有 `aria-label`；命中区 ≥44×44 |
| `dark mode theme tokens` | `--stack html-tailwind` | `Colors / Dark mode`（`dark:` 前缀，Medium）、`Colors / Semantic colors`（`@theme` 声明语义 token，禁散落 `bg-blue-500`，Medium） | **采纳语义 token，否决 `dark:` 前缀** | `dark:` 前缀要求每个元素写两套类名，漏一个就露白。改成 `[data-theme='light']` 覆盖 CSS 变量，组件只写一次 `bg-surface` |
| `skeleton loading placeholder` | `--domain ux` | `Placeholder Content`、`Loading Indicators`（`aria-busy`）、`Lazy Loading` | **采纳** | 骨架加 `aria-hidden`，容器 `aria-busy` 表达加载态（首轮只写了说明未落地，见 5.4 缺陷 B） |

### 1.4 Pre-Delivery Checklist 逐条结论

读 `.agents/skills/ui-ux-pro-max/references/pro-rules.md`（117 行）后逐条核对：

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 无 emoji 当图标 | 通过 | 全部为内联 SVG（`viewBox="0 0 24 24"`，`stroke="currentColor"`） |
| 文字对比度 ≥4.5:1 | 通过 | 见第 2 节，4 组组合 0 失败 |
| 非文本（图标/边框）≥3:1 | 通过 | 边框见第 2 节（深色 4.11/3.75/3.41，浅色 4.12/3.75/3.37）；**图标**首轮审计漏测，5.4 节缺陷 C 补测 16 个实例，0 失败 |
| 边框两主题都可见 | 通过 | 浅色改 `#7c7c88`；卡片分隔用 `border-subtle` |
| Token 驱动主题 | 通过 | 源码 0 处硬编码 `white/black`（播放器遮罩除外） |
| scrim 需实测合成结果 | 通过 | 角标 `bg-scrim/65` 实测合成后白字 4.9:1 |
| 8dp 间距节奏 | **部分通过** | 主布局间距（`gap-3` `p-4` `p-6` `px-4` `mb-3`）全为 4 的倍数；但有 12 处半档值：`px-3.5`×3、`gap-1.5`×3、`py-1.5`×2、`py-0.5`×2、`p-2.5`×2、`space-y-1.5`、`py-2.5`、`px-1.5`、`mb-2.5`、`m-1.5`。这些是图标与文字基线微调、以及胶囊内边距，视觉上必要。规则原文写的是「consistent 4/8dp system」，不是「禁止 2px 增量」——2px 是 4 的整除半档，仍属同一节奏。**无任何任意值**（`p-[13px]` 之类 0 处） |
| 安全区 | 通过 | `pt-safe`（`player.tsx:325`）、`pb-safe`（`player.tsx:427`、`episode-drawer.tsx:39`），值为 `env(safe-area-inset-*)` |
| `cursor: pointer` | 通过 | 见第 3 节，每页枚举断言 |
| hover 过渡 150–300ms | 通过 | `duration-200`×5、`duration-300`×1，无其他时长 |
| focus 可见 | 通过 | `:focus-visible` 2px `accent-soft`，输入框单独处理 |
| `prefers-reduced-motion` | 通过 | `index.css:152` 全量降级 `animation/transition-duration: 0.01ms`，`scroll-behavior: auto` |
| 输入框焦点可见 | 通过 | 输入框被排除出全局 `outline`，改用三个信号补偿，见下方实测 |
| 375/768/1024/1440 响应式 | 通过 | 四断点实测（见下表），0 横向溢出 |

四个断点的网格列数与触摸目标实测（dark）：

| 视口 | `/` 列数 | `/search` 列数 | `/series/:id` 列数 | 过小触摸目标 | 横向溢出 |
| --- | --- | --- | --- | --- | --- |
| 375×812 | 2 | 2 | 5 | 0 | 0px |
| 390×844 | 2 | 2 | 5 | 0 | 0px |
| 768×1024 | 4 | 4 | 10 | 0 | 0px |
| 1024×768 | 6 | 6 | 10 | 0 | 0px |
| 1440×900 | 6 | 6 | 10 | 0 | 0px |

列数按 `2 → 4 → 6` 递进，与 `grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6`
一致（`sm`=640 起 3 列，但 375/390 都是 2 列；768 命中 `md` 4 列；1024/1440 命中 `lg` 6 列）。

> 注：`/series/:id` 的 5 列是选集按钮网格（`grid-cols-5`），不是剧集卡片网格，
> 与上面的断点体系无关。

输入框焦点态实测（`/search`，1440，dark）——全局规则写了 `input:focus-visible { outline: none }`，
所以必须证明焦点态另有可见信号，否则就是「焦点不可见」缺陷：

| 状态 | `isActive` | 底色 | 边框 | 外发光 |
| --- | --- | --- | --- | --- |
| 失焦 | false | `rgb(22,22,26)` | `rgb(42,42,48)` 1px | 无 |
| 聚焦（点击/`autoFocus`） | true | `rgb(31,31,36)` | `rgb(113,113,125)` 1px | `oklab(…accent… / 0.12)` 0px 0px 0px 4px |

三个信号同时变化：底色亮度 +9%，边框对比度从 1.28:1 升到 4.11:1（vs `surface`），
外加一圈 4px 的 12% 透明红微光。没有红色描边——描边是中性灰，红色只做外发光。

键盘 `Tab` 到按钮时全局 `:focus-visible` 仍生效：实测 `outline: solid 2px rgb(251,113,133)`。

**图标描边宽度**：规则要求同一层级内描边一致。实测 4 种值——`2`×7、`1.8`×2
（顶栏主题按钮）、`1.6`×2（搜索空状态大图标）、`2.5`×1（选集正序/倒序箭头）。
差异都有层级理由：主题按钮 20px、空状态图标 28px、箭头 14px，视觉重量需要补偿，
统一成 2 会让 28px 图标显得过重、14px 箭头显得过轻。属**有意偏离**，非疏漏。

---

## 2. 缺陷 1：dark/light 双主题

### 2.1 改造前

`web/src/styles/index.css` 只有一套深色值，且散落硬编码：

```
text-white ×15   bg-black ×12   white/8 ×10   white/15 ×5
white/20 ×4      white/10 ×4    white/16 ×3   white/12 ×3
border-white ×3  white/35、white/25、black/80、black/75、black/60、black/35 各 ×1
```

分布在 `page-header.tsx`、`series-card.tsx`、`episode-drawer.tsx`、`player.tsx`、
`progress-bar.tsx`、`sprite-preview.tsx`、`history-route.tsx`、`search-route.tsx`、
`series-route.tsx` 共 9 个文件。

### 2.2 语义 token

`@theme` 定义深色为默认，`[data-theme='light']` 覆盖同名变量。组件只写一次
`bg-surface`，切换主题时 CSS 变量整体换值，不重渲染 React。

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--color-surface` | `#0a0a0a` | `#f4f4f6` | 页面底色 |
| `--color-surface-raised` | `#16161a` | `#ffffff` | 卡片、输入框 |
| `--color-surface-overlay` | `#1f1f24` | `#e8e8ec` | hover、下拉 |
| `--color-text-primary` | `#f5f5f7` | `#16161a` | 正文 |
| `--color-text-secondary` | `#a1a1aa` | `#5c5c66` | 次要文字 |
| `--color-text-tertiary` | `#8e8e98` | `#63636e` | 说明文字 |
| `--color-accent` | `#e11d48` | `#d61f45` | 实心按钮底 |
| `--color-accent-soft` | `#fb7185` | `#be123c` | 红色**文字**、焦点环 |
| `--color-on-accent` | `#ffffff` | `#ffffff` | 实心按钮上的字 |
| `--color-border` | `#71717d` | `#7c7c88` | 需要被看见的边界 |
| `--color-border-subtle` | `#2a2a30` | `#dcdce4` | 卡片分隔 |
| `--color-scrim` | `#000000` | `#000000` | 播放器遮罩（**不随主题变**） |
| `--color-on-scrim` | `#ffffff` | `#ffffff` | 遮罩上的字 |
| `--color-on-scrim-muted` | `#ffffffb3` | `#ffffffb3` | 遮罩上的次要字 |
| `--color-on-scrim-faint` | `#ffffff59` | `#ffffff59` | 已废弃（见 2.5） |

### 2.3 层级方向必须相反（实测踩到的坑）

深色：越往上越亮。`#0a0a0a → #16161a → #1f1f24`。
浅色第一版照抄「页面纯白、卡片浅灰」，结果截图里卡片边界几乎看不见。
量化后原因很清楚：

| 组合 | 对比度 |
| --- | --- |
| `#e2e2e8` 边框 on `#ffffff` | **1.14:1** |
| `#e2e2e8` 边框 on `#f4f4f6` | 1.19:1 |

1.14:1 在屏幕上等于没有边框。改成「页面浅灰 `#f4f4f6`、卡片纯白」之后，
卡片靠 5% 的明度差自然浮起，不依赖描边。

### 2.4 对比度实测

深色（`#0a0a0a` / `#16161a` / `#1f1f24`）：

| 颜色 | on surface | on raised | on overlay |
| --- | --- | --- | --- |
| text-primary `#f5f5f7` | 18.9 | 17.1 | 15.4 |
| text-secondary `#a1a1aa` | 7.72 | 7.04 | 6.40 |
| text-tertiary `#8e8e98` | 6.10 | 5.56 | 5.06 |
| border `#71717d` | 4.11 | 3.75 | 3.41 |
| accent `#e11d48` + 白字 | 4.70 | 4.70 | 4.70 |
| accent-soft `#fb7185` | 7.36 | 6.70 | 6.10 |

浅色（`#f4f4f6` / `#ffffff` / `#e8e8ec`）：

| 颜色 | on surface | on raised | on overlay |
| --- | --- | --- | --- |
| text-primary `#16161a` | 16.43 | 18.04 | 14.77 |
| text-secondary `#5c5c66` | 6.02 | 6.61 | 5.41 |
| text-tertiary `#63636e` | 5.40 | 5.93 | 4.85 |
| border `#7c7c88` | 3.75 | 4.12 | 3.37 |
| accent `#d61f45` + 白字 | 5.07 | 5.07 | 5.07 |
| accent-soft `#be123c` | 5.72 | 6.29 | 5.15 |

`border` 在两种主题、三种底色上的**最低值 3.37:1**，全部 ≥3:1。

### 2.5 脚本审计结果（4 组组合 × 5 个页面）

| 组合 | 文字对比度失败 | 边框对比度失败 | 图标对比度失败 | 最低文字对比度 | 过小触摸目标 | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- |
| 1440 dark | 0 | 0 | 0 | 4.70 | 0 | 0px |
| 1440 light | 0 | 0 | 0 | 5.07 | 0 | 0px |
| 390 dark | 0 | 0 | 0 | 4.70 | 0 | 0px |
| 390 light | 0 | 0 | 0 | 5.07 | 0 | 0px |

「图标对比度」一列是完成度审计时补上的（首轮脚本只测 `border-width > 0` 的元素，
SVG 图标从未被测量，见 5.4 缺陷 C）。补测后并入同一脚本，4 组组合共 16 个
图标实例全部 ≥3:1。

播放器单独核对（移动端 390）：`scrollHeight = clientHeight = 844`（无竖向滚动），
横向溢出 0px，视频 `1280×720` 正常解码播放。

逐页最低文字对比度（数值越高越安全）：

| 页面 | 1440 dark | 1440 light | 390 dark | 390 light |
| --- | --- | --- | --- | --- |
| `/` | 7.69 | 6.02 | 7.69 | 6.02 |
| `/search` | 4.70 | 5.07 | 4.70 | 5.07 |
| `/history` | 7.04 | 6.02 | 7.04 | 6.02 |
| `/series/:id` | 4.70 | 5.07 | 4.70 | 5.07 |
| `/watch/:id` | 10.02 | 10.02 | 10.02 | 10.02 |

审计覆盖 5 个页面：`/`、`/search`、`/history`、`/series/:id`、`/watch/:id`。
`/series` 页有 108 个可交互元素，全部计入统计。

过程中修掉的真实缺陷：

| 缺陷 | 实测值 | 修复 |
| --- | --- | --- |
| 选集角标「评论数」在当前集上不可读 | 2.88:1（`text-on-scrim-muted` 白 70% on `#d61f45`） | 改为 `text-on-accent`（纯白 on accent = 4.70:1） |
| 播放器时间显示不可读 | 3.18:1（`text-text-secondary` `#5c5c66` on 黑色视频） | 改用 `text-on-scrim-muted`（白 70% on 黑 = 8.9:1） |
| 播放器操作提示不可读 | 3.00:1（`text-on-scrim-faint` 白 35% on 黑） | 改用 `text-on-scrim-muted` |

第三条同时说明一个设计原则：播放器上的所有文字必须用 `on-scrim` 系，
不能用主题色。浅色主题下 `text-secondary` 是深灰，压在黑色视频上直接消失。

### 2.6 主题切换与持久化

实现：`web/src/features/theme/theme-store.ts`（zustand + persist，key `hongguo.theme.v1`）
+ `web/src/features/theme/use-theme-effect.ts`（同步 `html[data-theme]` 与 `style.colorScheme`）。

实测（真实鼠标点击）：

| 步骤 | `data-theme` | `body` 背景 | localStorage | 按钮 aria-label |
| --- | --- | --- | --- | --- |
| 首次访问（系统浅色） | `light` | `rgb(244,244,246)` | `null` | 切换到深色模式 |
| 点击 1 次 | `dark` | `rgb(10,10,10)` | `{"state":{"mode":"dark"},"version":0}` | 切换到浅色模式 |
| 点击 2 次 | `light` | `rgb(244,244,246)` | `mode: light` | 切换到深色模式 |
| 点击 3 次 | `dark` | `rgb(10,10,10)` | `mode: dark` | 切换到浅色模式 |

首屏跟随系统：

| 系统偏好 | 存储值 | 首屏 `data-theme` | `body` 背景 |
| --- | --- | --- | --- |
| `prefers-color-scheme: light` | 无 | `light` | `rgb(244,244,246)` |
| `prefers-color-scheme: dark` | 无 | `dark` | `rgb(10,10,10)` |
| `prefers-color-scheme: dark` | `mode: light` | `light`（显式选择优先） | `rgb(244,244,246)` |

`system` 模式下实时跟随（不刷新页面）：

| 系统切到 | `data-theme` |
| --- | --- |
| `light` | `light` |
| `dark` | `dark` |

防闪烁：`persist` 的 `onRehydrateStorage` 里立刻调用 `applyTheme()`，
在 React 首次渲染前就写好 `data-theme`，不会出现「先深色再跳浅色」。

### 2.7 硬编码颜色清零验证

```
$ grep -rn 'white/\|black/\|text-white\|bg-black\|border-white' web/src --include='*.tsx'
（无输出）
```

播放器遮罩保留 `bg-scrim`（`#000000`）与 `text-on-scrim`（`#ffffff`），
但走的是 token 而不是字面量，且 token 值在两套主题下相同——符合豁免条款。

---

## 3. 缺陷 2：PC 端 cursor: pointer

### 3.1 根因

Tailwind 4.3.5 的 `preflight.css` 里搜不到给 `button` 设 `cursor: pointer` 的规则
（只剩 Safari 的 `appearance` 和 spinner 修正）。Tailwind 3 有这条规则，
4 把它删了，因为 W3C 的默认样式就是这样。于是所有 `<button>` 计算值都是 `cursor: default`。

改造前实测：

| 页面 | 元素 | 计算值 |
| --- | --- | --- |
| `/` | 11 个 `button` | 全部 `default` |
| `/search` | `button` / `input` / `a` | `default` / `text` / `default` |

### 3.2 修复

放在 `@layer base`，一处生效全站：

```css
button, [role='button'], [role='slider'], [role='tab'], summary, label[for], select {
  cursor: pointer;
}
:disabled, [aria-disabled='true'] {
  cursor: not-allowed;
}
input, textarea {
  cursor: text;
}
```

用 `@layer base` 而不是逐个组件加 `cursor-pointer`，理由是：组件库不存在，
按钮形态有 20 多种，靠自觉迟早会漏；而且 `disabled` 和 `input` 的例外规则
只能在同一层里按优先级处理。

### 3.3 逐页断言结果

| 页面 | 视口 | `button:enabled:pointer` | `input:enabled:text` | 其他 | 结论 |
| --- | --- | --- | --- | --- | --- |
| `/` | 1440 | 12 | — | — | 通过 |
| `/search` | 1440 | 11 | 1 | — | 通过 |
| `/history` | 1440 | 11 | — | — | 通过 |
| `/series/:id` | 1440 | 108 | — | — | 通过 |
| `/watch/:id` | 1440 | 5 | — | `div:pointer ×1`（进度条 `role="slider"`） | 通过 |
| `/` | 390 | 12 | — | — | 通过 |
| `/search` | 390 | 11 | 1 | — | 通过 |
| `/history` | 390 | 11 | — | — | 通过 |
| `/series/:id` | 390 | 108 | — | — | 通过 |
| `/watch/:id` | 390 | 5 | — | `div:pointer ×1` | 通过 |

没有任何元素落在 `default`。禁用态分支用注入元素单独验证（测试数据里所有剧集都可播，
页面上没有现成的禁用按钮）：

| 探测元素 | `cursor` |
| --- | --- |
| `<button>` | `pointer` |
| `<button disabled>` | `not-allowed` |
| `<button aria-disabled="true">` | `not-allowed` |
| `<div role="button">` | `pointer` |
| `<div role="button" aria-disabled="true">` | `not-allowed` |
| `<input>` | `text` |
| `<textarea>` | `text` |
| `<div role="slider">` | `pointer` |
| `<select>` | `pointer` |
| `<summary>` | `pointer` |

这里挖到一个真缺陷：第一版写的是 `button:not(:disabled)`（特异性 0,1,1），
它压过了后面的 `[aria-disabled='true']`（0,1,0），导致 `aria-disabled` 的按钮
光标仍然是 `pointer`。实测注入探测元素才暴露出来——页面上所有按钮都可用，
跑一百次逐页扫描也不会报错。修法是把 `:not([aria-disabled='true'])`
写进每一条选择器里。

---

## 4. 缺陷 3：搜索页重做

### 4.1 改造前的问题

| 问题 | 实测 |
| --- | --- |
| 输入框焦点是红环 | `focus:ring-2 focus:ring-accent-soft`，`autoFocus` 导致进页即红环 |
| 空状态只有一个「搜索」按钮 | 无图标、无标题、无说明、无推荐词 |
| 结果区不与顶栏对齐 | 顶栏内容 x=100，结果区 x=80（差 20px） |
| 桌面端内容贴左 | 无 `max-width` 居中 |

### 4.2 改造后

**焦点态**：去掉 `ring-accent-soft`，改三重弱信号——

```
focus:bg-surface-overlay
focus:ring-border
focus:shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-accent)_12%,transparent)]
```

实测计算值：`outline: none`，`box-shadow` 第一层为 `rgb(99,99,111) 0px 0px 0px 1px`，
外发光是 accent 的 12% 透明。屏幕上是一圈很淡的暖色光晕，不是红色描边。

**空状态**：16×16 图标块 + `h2` 标题「搜一部想看的短剧」+ 说明文字 +
8 个可点推荐词（总裁/重生/穿越/甜宠/逆袭/战神/复仇/闪婚）。

推荐词全部实测有结果：

| 关键词 | 结果数 |
| --- | --- |
| 总裁 | 6 |
| 重生 | 5 |
| 穿越 | 5 |
| 甜宠 | 5 |
| 逆袭 | 4 |
| 战神 | 6 |
| 复仇 | 6 |
| 闪婚 | 5 |

**无结果状态**：图标换成「搜索 + 叉」，标题「没有找到「{keyword}」」，
说明「换个词试试，或者从下面的题材开始」，chips 过滤掉当前词。

**对齐**：实测顶栏内容左边界、结果计数行、结果网格三者 x 都是 `100`（1440 视口）。
桌面端内容宽 1280，左右留白各 80px，居中。

**移动端顶栏**：第一版把表单放进 `left` 的 `flex-1` 容器，右侧 `flex-1` 空占位
把输入框挤成 44px 宽的一个图标（截图已留证）。修复方式是按有无居中标题
分开处理伸缩：

```tsx
// 有标题时两侧必须等宽，否则标题会偏
// 无标题时右侧只能 flex-none，否则白占一半宽度
<div className={title === undefined ? 'flex-none' : 'flex-1'}>…</div>
```

修复后 390 视口：返回按钮 `x=4 w=44`，输入框 `x=56 w=194`，搜索按钮 44×44，
横向溢出 0px。

### 4.3 关键词搜索真实交互

用真实鼠标点击输入框 + `keyboard.type('总裁')` + `Enter`：

| 项目 | 结果 |
| --- | --- |
| 请求参数 | `?keyword=总裁` |
| 结果数 | 11 |
| 结果区左边界 | 100px（与顶栏一致） |
| 卡片列数 | 6 |
| 横向溢出 | 0px |

---

## 5. 缺陷 4：骨架屏填补当前行

### 5.1 根因

`feed-route.tsx` 里骨架屏渲染在哨兵之后的**独立 grid 容器**：

```tsx
<div className="grid …">{items.map(...)}</div>
<div ref={sentinelRef} aria-hidden className="h-8" />
{query.isFetchingNextPage && (
  <div className="grid …">{6 个骨架}</div>   // ← 另一个 grid
)}
```

独立容器必然另起一行，而且固定 6 个：如果当前行只剩 3 个空位，6 个骨架会
填满这一行再溢出 3 个到下一行。

### 5.2 修复

骨架合并进同一 grid，数量按**真实列数**动态计算：

```tsx
const gridRef = useRef<HTMLDivElement>(null)
const columns = useGridColumns(gridRef, 2)
const placeholderCount = (columns - (items.length % columns)) % columns || columns
```

`useGridColumns` 用 `ResizeObserver` + `getComputedStyle().gridTemplateColumns`
读出真实列数，而不是手写断点映射。理由是断点会改、容器查询会加，
手写映射一旦和真实布局脱钩，骨架又会算错。

还修了一个顺序 bug：搜索页第一版把骨架放在真实卡片**前面**，导致搜索词变化时
旧结果还在缓存、新结果未到，骨架顶到第一排、真实卡片被挤到下面（截图留证）。
现在骨架永远在真实卡片之后。

### 5.3 实测数据

桌面 1440，用真实滚轮事件连续触发加载更多，每 160ms 采样一次：

| 时刻 | 列数 | 总格数 | 真实卡 | 骨架 | 每行格数 | 总格数是列数整数倍 | 骨架在最后一张卡之后 | 与最后一张卡同行 | 宽度相同 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 首屏（纯骨架） | 6 | 12 | 0 | 12 | 6,6 | 是 | — | — | — |
| 加载中（采样 1） | 6 | 30 | 27 | 3 | 6,6,6,6,6 | 是 | 是 | 是 | 是 |
| 加载中（采样 6） | 6 | 30 | 27 | 3 | 6,6,6,6,6 | 是 | 是 | 是 | 是 |
| 继续加载 | 6 | 48 | 45 | 3 | 6,6,6,6,6,6,6,6 | 是 | 是 | 是 | 是 |

关键行是「27 张真实卡 + 3 个骨架 = 30 = 6×5」。27 % 6 = 3，当前行只剩 3 个空位，
所以补 3 个骨架正好填满，不多不少。骨架宽度与真实卡一致（差值 <1px），
`getBoundingClientRect().top` 差值 <2px，确认在同一行。

首屏是 `columns × 2 = 12` 个纯骨架，正好两整行——不会出现「一行骨架 + 半个空行」。

如果按改造前的固定 6 个：27 + 6 = 33，33 % 6 = 3，会多出半行骨架，视觉上多一段灰块。

移动端 390：列数 2，首屏骨架同理按 2 补齐，`perRow` 为 `[2,2,2,2,2,2,2,1]`
（15 张真实卡，最后一格是数据本身）。

### 5.4 完成度审计中发现的三个新缺陷

目标标记完成后，我按「逐条对照交付标准」重跑了一遍审计，发现三处**报告与代码不符**
或**逻辑用错判断条件**的问题。以下都是实测发现，不是猜测。

#### 缺陷 A：搜索页用错 `isFetching`，加载更多会画两整行骨架

`search-route.tsx` 第一版写的是：

```tsx
{(query.isFetching || query.isFetchingNextPage) &&
  Array.from({ length: query.isFetching ? columns * 2 : placeholderCount }, ...)}
```

`isFetching` 在 `fetchNextPage()` 期间**同样为 true**。于是「加载更多」被当成
「首屏」，一次渲染 `columns × 2 = 12` 个骨架，而不是只补当前行。

实测证据（修复前，关键词「总裁」，1440 视口）：

| 时刻 | 真实卡 | 骨架 | 总格数 | 列数 | 总格数是列数整数倍 |
| --- | --- | --- | --- | --- | --- |
| 搜索完成 | 11 | 12 | 23 | 6 | 否 |

修复：首屏判断改成 `isPending`（`@tanstack/react-query` 里它只在「还没有任何数据」时为
true），与 `feed-route.tsx` 保持一致。

修复后实测（关键词「重生」，1440 视口，每 130ms 采样，共 23 次命中）：

| 时刻 | 真实卡 | 骨架 | 总格数 | 每行格数 | 整数倍 | 骨架在最后之后 | 同行 | 同宽 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 加载更多 1 | 10 | 2 | 12 | 6,6 | 是 | 是 | 是 | 是 |
| 加载更多 2 | 11 | 1 | 12 | 6,6 | 是 | 是 | 是 | 是 |
| 结束 | 11 | 0 | 11 | — | — | — | — | — |

10 % 6 = 4，剩 2 个空位 → 补 2 个骨架。11 % 6 = 5，剩 1 个空位 → 补 1 个。
数量和空位严格相等。

#### 缺陷 B：`aria-busy` 报告里写了但代码里没有

1.3 节说「骨架加 `aria-hidden`，容器状态由父级 `aria-busy` 表达」，
但 `grep -rn 'aria-busy' web/src` 的结果是 **0 次**。这是一句没有落地的声明。

后果：骨架是 `aria-hidden` 的纯装饰，屏幕阅读器读不到任何「正在加载」信号。

修复：给两个 grid 容器加 `aria-busy`：

```tsx
aria-busy={query.isPending || query.isFetchingNextPage}   // feed
aria-busy={query.isPending || query.isFetchingNextPage}   // search
```

实测（1440）：

| 状态 | `aria-busy` | 骨架数 | 真实卡 |
| --- | --- | --- | --- |
| 首屏加载中 | `true` | 12 | 0 |
| 加载更多中 | `true` | 3 | 27 |
| 稳定态（连续 8 次采样） | `false` | 0 | 15 |
| 搜索中 | `true` | 12 | 0 |
| 搜索完成 | `false` | 0 | 11 |

#### 缺陷 C：图标对比度从未被测量过

审计脚本的边框检查只覆盖 `border-width > 0` 的元素，**SVG 图标一次都没测**。
而交付标准写的是「图标/边框 ≥3:1」。这是覆盖缺口，不是实现缺陷。

补测方法：枚举所有可见 `<svg>`，取 `stroke`（`fill` 为 `none` 时）或 `fill`，
用同一套 canvas 解析 + 祖先背景合成算对比度。

结果（1440，两主题，5 页共 16 个图标实例）：

| 页面 | dark 图标数 | light 图标数 | <3:1 失败数 |
| --- | --- | --- | --- |
| `/` | 1 | 1 | 0 |
| `/search` | 4 | 4 | 0 |
| `/history` | 5 | 5 | 0 |
| `/series/:id` | 4 | 4 | 0 |
| `/watch/:id` | 2 | 2 | 0 |

图标数量偏少是因为大多数图标在「返回」按钮里、以及抽屉/播放器控件默认隐藏。
首页只有主题切换一个图标是符合当前设计的。

---

## 6. 交互回归（真实鼠标/键盘）

| 操作 | 实测结果 |
| --- | --- |
| 点击首页卡片 | `/series/7654222159966899224`，标题「九天镇压之主角就应该无敌」 |
| 点击「开始观看」 | `/watch/7654229415169117209`，`video` 就绪：`paused=false`，`duration=309s`，`1280×720` |
| 点击「静音」 | `muted: false → true`；再点 `true → false` |
| 点击「1×」 | `playbackRate: 1 → 1.25` |
| 点击「选集」 | 抽屉打开，按钮数从 4 增到 108 |
| 主题切换按钮 | 三轮切换，`data-theme` 与 localStorage 同步 |

有一个测量陷阱要记录：播放器控件约 3.2 秒自动隐藏。控件隐藏后点击坐标会落到
视频区，效果是「切换控件显示」，不是点到按钮。第一次测静音得到的
`muted: false → false` 就是这个假阴性。正确做法是先用
`document.elementFromPoint(x, y)` 确认命中的就是目标按钮，否则先点一下视频
把控件唤出来。加上这个前置检查后，静音两次点击都正确翻转。

---

## 7. 代码检查

```
pnpm -r typecheck   ✅
pnpm -r lint        ✅
pnpm -r test        ✅
pnpm -r build       ✅
```

Web 产物：JS 335.19 kB / 103.36 kB gzip，CSS 36.67 kB / 6.95 kB gzip。

---

## 8. 改动文件

新增：

- `web/src/features/theme/theme-store.ts` — zustand + persist 主题状态
- `web/src/features/theme/use-theme-effect.ts` — 同步 DOM 与系统偏好
- `web/src/lib/use-grid-columns.ts` — `ResizeObserver` 读真实列数
- `scripts/ui-audit.mjs` — 审计脚本（canvas 解析颜色）
- `design-system/hongguo/MASTER.md` — 设计系统（skill 生成）
- `docs/ui-redesign-log.md` — 本文
- `shots/` — 20 张截图（4 组组合 × 5 页）

重写：

- `web/src/styles/index.css` — 语义 token + 双主题 + cursor 修复 + a11y
- `web/src/components/page-header.tsx` — 主题切换按钮 + 伸缩逻辑修复
- `web/src/components/series-card.tsx` — token 化 + 骨架尺寸对齐
- `web/src/routes/search-route.tsx` — 整页重做

修改：

- `web/src/app.tsx` — 挂 `useThemeEffect()`
- `web/src/routes/feed-route.tsx` — 骨架合并进同一 grid
- `web/src/routes/series-route.tsx` — token 化 + 触摸目标 44px
- `web/src/routes/history-route.tsx` — token 化
- `web/src/features/player/player.tsx` — scrim token + 文字对比度
- `web/src/features/player/progress-bar.tsx` — 命中区 36→44px + scrim token
- `web/src/features/player/episode-drawer.tsx` — 当前集文字色 + token
- `web/src/features/player/sprite-preview.tsx` — scrim token

---

## 9. 截图清单

> **截图未随代码迁移。** 这些 PNG 共 51 个文件、约 23 MB，是逐轮 UI 改造的
> 视觉证据。迁入 `mlzwl` 仓库时只保留了代码与文档，截图留在原 `hongguo`
> 仓库的 `shots/` 目录。原因：仓库根 `.gitignore` 本就忽略截图，且 mlzwl
> 的维护约定要求仓库内临时材料统一放 `.tmp/`，把 23 MB 二进制证据纳入版本
> 控制不划算。
>
> 下表保留完整的文件名与说明，作为「当时拍了什么、验证了哪一项」的记录。
> 需要重拍时，用 `scripts/ui-audit.mjs` 起前后端后按表中视口与主题重跑即可。

`shots/` 目录（原仓库），全部为 `scale: 'css'`（CSS 像素尺寸，与视口一致）：

| 文件 | 内容 |
| --- | --- |
| `d-dark-feed.png` / `d-light-feed.png` | 桌面首页 |
| `d-dark-search.png` / `d-light-search.png` | 桌面搜索页 |
| `d-dark-history.png` / `d-light-history.png` | 桌面历史页 |
| `d-dark-series.png` / `d-light-series.png` | 桌面详情页 |
| `d-dark-player.png` / `d-light-player.png` | 桌面播放器 |
| `m-dark-*.png` / `m-light-*.png` | 移动端同样 5 页 |
| `skeleton-during.png` | 首页加载更多时的骨架补位（深色，1440）：3 张真实卡 + 3 个骨架填满最后一行 |
| `skeleton-search.png` | 搜索页骨架补位（深色，1440） |
| `interaction-player.png` | 播放器控件 |
| `interaction-drawer.png` | 选集抽屉 |
| `focus-search.png` | 搜索框焦点态（验证非红描边） |

共 25 张。其中 `skeleton-search.png` 与 `focus-search.png` 是完成度审计阶段补拍的。

---

## 10. 遗留问题

1. **浅色主题的封面角标依赖 scrim**。`bg-scrim/65` 在两套主题下都是半透明黑，
   这是刻意的（封面图是彩色的，白字必须压在暗底上）。但如果将来允许用户上传
   纯白封面，角标会不可读。届时需要改成「角标底色跟随封面平均色」。
2. **`--color-on-scrim-faint` 已删除**。改完对比度后没有组件再用它（白 35% on 黑
   只有 3.0:1，过不了 4.5 线），留着只会被后人误用。
3. **`useGridColumns` 的 `fallback` 是 2**。SSR 场景下首帧会按 2 列渲染骨架，
   水合后跳到真实列数。当前是纯 CSR，不触发；如果将来上 SSR 需要改成
   CSS 变量 + `calc()` 的纯 CSS 方案。
4. **播放器控件自动隐藏时间 3.2s 对慢速用户偏短**。这是上一轮的设计决策，
   本轮没有改。可用性测试可以验证是否该延长到 4s。
5. **搜索页没有防抖**。当前是「提交才发请求」，按键不发请求，所以不需要防抖。
   但如果将来改成实时搜索，必须加 300ms 防抖。
6. **截图未随代码迁移**。`shots/`（51 个文件、约 23 MB）与 `docs/ui-polish-log.md`
   引用的 8 张根目录 `ui-*.png` 都留在原 `hongguo` 仓库。本文档保留文件名与
   说明，但不含图片本身。重拍方法见第 9 节。
7. **主题切换是即时生效，没有过渡动画**。`body` 有 260ms 颜色过渡，但背景图、
   视频封面不会跟随。刻意为之：整个页面同时渐变会在切主题时闪一下，
   瞬时切换反而更稳。

---

## 11. 完成度审计（第二轮自查）

目标第一次标记完成后，我没有停在「测试都过了」这个结论上，而是按交付标准逐条回查
**实际文件内容**。结果发现 4 处「报告写了但代码不符」或「从未被测量」的问题。
这一节是审计记录，也是本报告可信度的一部分。

### 11.1 审计方法

对每一条交付标准问三个问题：

1. 这条标准要求的**证据类型**是什么？（脚本数值 / 源码 grep / 截图 / 交互结果）
2. 我手上有没有**这种类型**的证据？
3. 证据覆盖的是**全部对象**还是**抽样**？

第 3 问是主要失分点。首轮审计的两个漏洞都出在这里：边框检查只覆盖
`border-width > 0` 的元素（漏掉 SVG 图标），响应式只测了 1440 和 390（漏掉 375/768/1024）。

### 11.2 逐条对照

| # | 交付标准 | 证据类型 | 首轮状态 | 审计结论 |
| --- | --- | --- | --- | --- |
| 1 | 双主题可切换 | 真实鼠标点击 + localStorage + 首屏跟随系统 | 已测 | 通过 |
| 1 | 全部走语义 token | `grep` 硬编码色 = 0 | 已测 | 通过 |
| 1 | 文字 ≥4.5:1 | 脚本逐元素 | 已测 | 通过（4 组组合 0 失败） |
| 1 | **图标/边框 ≥3:1** | 脚本逐元素 | **图标漏测** | 已补，见 5.4-C |
| 2 | 可点击元素 `pointer` | 脚本枚举 + 注入探测 | 已测 | 通过 |
| 2 | disabled → `not-allowed` | 注入探测 10 例 | 已测 | 通过 |
| 2 | 输入框 → `text` | 脚本枚举 | 已测 | 通过 |
| 3 | 搜索页空状态四件套 | 截图 + DOM | 已测 | 通过 |
| 3 | 结果区与顶栏对齐 | 边界坐标 | 已测 | 通过 |
| 3 | **桌面限宽居中** | 边界坐标 | 已测 | 通过 |
| 3 | **focus 非红描边** | 计算样式 | 已测 | 通过（补实测数值，见 1.4） |
| 4 | 骨架合并同一 grid | DOM 结构 + 截图 | 已测 | 通过 |
| 4 | **骨架补当前行** | 真实滚轮 + 逐帧采样 | feed 已测 | **search 用错 `isFetching`**，见 5.4-A |
| 4 | 骨架同行同宽 | `getBoundingClientRect` | 已测 | 通过 |
| 4 | 总格数 = 列数整数倍 | 计算 | 已测 | 通过 |
| 5 | 真实使用 skill | `MASTER.md` + 9 条查询记录 | 已测 | 通过 |
| 5 | **Pre-Delivery Checklist** | 逐条 | **3 条不准确** | 已修正，见 1.4 |
| 6 | 1440/390 × 双主题 × 5 页截图 | 20 张文件 | 已测 | 通过 |
| 6 | 数值写入报告 | 本文档 | 已测 | 通过 |
| 6 | `typecheck/lint/test/build` | 命令输出 | 已测 | 通过 |
| 7 | **`aria-busy`（skill 规则）** | grep | **0 次，报告虚假声明** | 已补，见 5.4-B |

### 11.3 审计发现并修复的问题

| 编号 | 问题 | 性质 | 修复 |
| --- | --- | --- | --- |
| A | 搜索页用 `isFetching` 判断首屏，加载更多时画两整行骨架 | 逻辑错误 | 改 `isPending`，与 feed 一致 |
| B | 报告声称有 `aria-busy`，代码 0 处 | 报告虚假声明 | 两个 grid 容器补上，实测翻转 |
| C | SVG 图标对比度从未测量 | 覆盖缺口 | 补测 16 个实例，并入 `ui-audit.mjs` |
| D | 「8dp 间距全为 4 的倍数」不准确 | 报告夸大 | 改为「部分通过」，列出 12 处半档值及理由 |
| E | 「375/768/1024/1440 响应式通过」只测了 2 个 | 覆盖缺口 | 补测 375/768/1024，列数 2→4→6 正确 |
| F | 未核实图标描边一致性 | 未验证声明 | 实测 4 种值，说明层级理由 |

**这 6 条里，A 和 B 是真实缺陷（用户会感知到），C/D/E/F 是报告严谨性问题。**
两类都要修：A 让用户看到错位的骨架，B 让屏幕阅读器用户得不到加载提示。

### 11.4 修复后完整复测

代码改动后重跑全部指标（1440 与 390、dark 与 light、5 个页面）：

| 组合 | 文字失败 | 边框失败 | 图标失败 | 触摸目标 | 横向溢出 |
| --- | --- | --- | --- | --- | --- |
| 1440 dark | 0 | 0 | 0 | 0 | 0px |
| 1440 light | 0 | 0 | 0 | 0 | 0px |
| 390 dark | 0 | 0 | 0 | 0 | 0px |
| 390 light | 0 | 0 | 0 | 0 | 0px |

cursor 分布（修复后）：

| 页面 | 1440 dark | 1440 light |
| --- | --- | --- |
| `/` | `pointer` ×12 | `pointer` ×18 |
| `/search` | `pointer` ×11、`text` ×1 | `pointer` ×11、`text` ×1 |
| `/history` | `pointer` ×11 | `pointer` ×11 |
| `/series/:id` | `pointer` ×108 | `pointer` ×108 |
| `/watch/:id` | `pointer` ×6 | `pointer` ×6 |

（首页 light 多 6 个是因为骨架格消失时机不同，两次采样时列表长度不同，不影响结论：
所有元素都是 `pointer`，0 个 `default`。）

骨架补位（修复后，两个页面都验证）：

| 页面 | 真实卡 | 骨架 | 总格数 | 每行 | 整数倍 | 在最后之后 | 同行 | 同宽 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `/` feed | 27 | 3 | 30 | 6,6,6,6,6 | 是 | 是 | 是 | 是 |
| `/search` | 10 | 2 | 12 | 6,6 | 是 | 是 | 是 | 是 |
| `/search` | 11 | 1 | 12 | 6,6 | 是 | 是 | 是 | 是 |

`aria-busy` 翻转（修复后）：

| 状态 | 值 |
| --- | --- |
| 首屏加载中 | `true` |
| 加载更多中 | `true` |
| 稳定态（8 次连续采样） | `false` |
| 搜索中 | `true` |
| 搜索完成 | `false` |

### 11.5 最终代码检查

```
pnpm -r typecheck   Done (3/3)
pnpm -r lint        Done (3/3)
pnpm -r test        shared 10 passed, server 13 passed, web no tests
pnpm -r build       Done (3/3)
                    web: JS 335.28 kB / 103.38 kB gzip, CSS 36.67 kB / 6.95 kB gzip
npx prettier --check  全部 clean
```

### 11.6 结论

4 个用户报告的缺陷全部修复，5 条交付标准全部有实测证据，7 条硬约束全部遵守
（受保护文件 mtime 未变、无新框架、无外链字体、无 git 操作、kebab-case、
strict 三标志保留、未新增测试文件）。

审计中额外发现并修复了 2 个真实缺陷（搜索页骨架数量、`aria-busy` 缺失），
修正了 4 处不严谨的报告声明。报告现在与实际代码一致。

---

# 第六轮：7 个缺陷修复 + 视觉高级感重构

> 本轮起点：用户反馈「整体页面来看还是不够高级感，比较 low，视觉不太行」，
> 并附 4 张截图指出 7 个具体缺陷。上一轮已把可读性和交互做对，这一轮
> 解决「对不对」之上的「好不好看」。
>
> 全部数字用 `scripts/ui-audit.mjs` 与 Playwright 真实鼠标事件实测，
> 视口 1440×900 / 390×844 为主，第 2 项另测 1920×1200 / 2560×1440 / 3840×1600。

## 1. 搜索页未输入关键词就渲染骨架

### 1.1 根因

`search-route.tsx` 原来写的是：

```tsx
const query = useInfiniteQuery({ ..., enabled: keyword.length > 0 })
// 后面
{query.isPending && Array.from({ length: columns * 2 }, ...)}
```

React Query 对 `enabled: false` 的查询**不会跳过状态机**，它把查询留在
`status: 'pending'`。所以 `keyword === ''` 时 `query.isPending === true`，
骨架照常渲染。这不是 React Query 的 bug，`pending` 的语义是「还没有数据」，
而「被禁用」也确实「还没有数据」。

### 1.2 修复

把「有关键词」这个前提显式叠上去：

```tsx
const isFirstLoad = keyword !== '' && query.isPending
const showSkeleton = isFirstLoad || query.isFetchingNextPage
```

`aria-busy` 与骨架同源，避免再次出现「报告声称有、代码里没有」的问题。

### 1.3 实测

| 视口 | 关键词 | `.grid` 子节点 | 骨架 | `aria-busy` |
| --- | --- | --- | --- | --- |
| 390×844 | 空 | 0 | **0** | **false** |
| 1440×900 | 空 | 0 | **0** | **false** |

截图：`shots/fix1-search-390.png`、`shots/fix1-search-1440.png`。

## 2. 大视口首屏不继续加载

### 2.1 根因（两个叠加）

`use-infinite-scroll.ts` 原来有两处失效路径：

1. **冷却期直接返回**。`COOLDOWN_MS = 700` 内再次触发时执行
   `if (now - lastTriggeredAt.current < COOLDOWN_MS) return`。这个 `return`
   不重排任何定时器，所以这一次触发被**永久丢弃**。
2. **哨兵已在视口内时不再产生新的交叉回调**。`IntersectionObserver` 只在
   「相交状态发生变化」时回调。大视口下第一屏内容不足，哨兵从头到尾都
   处于 `isIntersecting: true`，`scrollHeight - clientHeight === 0`，用户
   无法滚动，也就永远不会产生第二次状态变化。

两者相乘：第一次加载完成 → 冷却期内哨兵仍然可见 → 回调被丢弃 → 之后再无
任何回调 → 卡死在第一页。

实测 2560×1440：`items: 15`、`scrollable: 0`、`sentinelInView: true`、
`/api/feed` 请求数 **2**。手工建 `IntersectionObserver` 确认
`isIntersecting: true`，即观察器正常，是 hook 把回调丢了。

### 2.2 修复

冷却期内不再丢弃，而是**排一次重试**：

```ts
const RETRY_MS = 250
const wait = COOLDOWN_MS - (now - lastTriggeredAt.current)
if (wait > 0) {
  const timer = setTimeout(() => setTick((v) => v + 1), wait + RETRY_MS)
  return () => clearTimeout(timer)
}
```

`tick` 参与 effect 依赖，重试会重新走一遍「哨兵是否仍在视口内」的判断。
只要内容还没填满视口，就继续请求，直到 `hasNextPage === false`。

### 2.3 实测（首屏打开后等 9 秒，不滚动）

| 视口 | `/api/feed` 请求数 | 卡片数 | 可滚动高度 | 通过条件 |
| --- | --- | --- | --- | --- |
| 1920×1200 | **5** | **33** | **921** | >2 / >15 / >0 ✅ |
| 2560×1440 | **4** | **27** | **361** | >2 / >15 / >0 ✅ |
| 3840×1600 | **6** | **33** | **521** | >2 / >15 / >0 ✅ |

稳定性：2560×1440 连续观察 24 秒，稳定在 `items 27 / requests 4 / scrollable 399`，
没有出现无限请求链（`getNextPageParam` 在无新 id 时返回 `undefined`，
加上 40 页上限）。

## 3. 四个页面容器宽度不统一

### 3.1 修复前（1440×900）

| 页面 | 容器类 | 宽 | 左边界 |
| --- | --- | --- | --- |
| `/` | `max-w-7xl` | 1280 | 80 |
| `/search` | `max-w-7xl` | 1280 | 80 |
| `/history` | `max-w-3xl` | **768** | **336** |
| `/series/:id` | `max-w-4xl` | **896** | **272** |

切页时内容左右横跳最多 256px，是最明显的「没做完」信号。

### 3.2 修复

`page-header.tsx` 导出单一常量，四个页面全部引用：

```ts
export const SHELL_WIDTH = 'max-w-7xl'
```

顶栏内层与正文外壳都用它，因此两者天然同宽同左。
长描述的行长约束单独用 `max-w-[65ch]`——那是**文字内部**的约束，
不是容器宽度的差异。

同时做了一次光学对齐：44px 图标按钮内居中 20px 图标，图标左沿距按钮
左沿 12px，所以按钮要向左外扩 12px（`-ml-3`）才能让图标左沿与正文重合。
用 `-ml-2`（8px）会差 4px，肉眼可辨。

### 3.3 修复后

| 视口 | 页面 | 顶栏宽/左 | 正文宽/左 | 顶栏墨迹左 | 正文墨迹左 | 差值 |
| --- | --- | --- | --- | --- | --- | --- |
| 1440 | `/` | 1280/80 | 1280/80 | 100 | 100 | **0** |
| 1440 | `/search` | 1280/80 | 1280/80 | 100 | — | — |
| 1440 | `/history` | 1280/80 | 1280/80 | 100 | 100 | **0** |
| 1440 | `/series` | 1280/80 | 1280/80 | 100 | 100 | **0** |
| 2560 | 四个页面 | 1280/640 | 1280/640 | 660 | 660 | **0** |

四页容器宽、左边界、内容左边界完全一致，顶栏↔正文差值 0px（要求 ≤1px）。

## 4. 详情页头部模糊封面 + 灰色渐变

删除 `series-route.tsx` 中：

```tsx
<img className="h-full w-full scale-125 object-cover opacity-25 blur-2xl" />
<div className="absolute inset-0 bg-gradient-to-b from-surface/40 via-surface/70 to-surface" />
```

换成干净的 `surface` 底 + 封面本体 + 一条 `border-border-subtle` 分隔线。

代码验证：`grep -E 'blur-2xl|from-surface/40'` → 0 命中；
页面内 `getComputedStyle(img).filter` 含 `blur` 的图片 **0** 张，
含 `gradient` 背景的 div **0** 个。

顺带把封面从 176×132 放大到 208×156（`sm` 下 288×216），
元信息从两块灰胶囊改成「104 集全 · 看到第 2 集」纯文本 + 中点，
选集格子从「灰底块 + 描边」改成纯文字 + hover 底色。

截图：`shots/fix4-series-dark.png`、`shots/fix4-series-light.png`、
`shots/v2-dark-series.png`、`shots/v2-light-series.png`。

## 5. 播放器顶栏标题与集数错行 + 浅色主题文字不可见

### 5.1 修复前

| 元素 | top | bottom | centerY | 颜色 |
| --- | --- | --- | --- | --- |
| 返回按钮 | 0 | 44 | 22 | `text-on-scrim` |
| 标题 | **4** | 24 | **14** | 深色 `rgb(245,245,247)` / 浅色 **`rgb(22,22,26)`** |
| 第 N 集 | **24** | 40 | **32** | `rgba(255,255,255,0.7)` |

标题和集数纵向相差 18px，集数行还压在返回按钮底部。浅色主题下标题继承
`text-primary`（`#16161a`），压在黑色渐变上对比度约 **1:1**，等于隐形。

### 5.2 修复

标题与集数合并到同一行，两者都用 `on-scrim` 系 token：

```tsx
<div className="flex min-w-0 items-center gap-2">
  <p className="truncate text-sm font-medium text-on-scrim">{title}</p>
  <span className="flex-none text-xs tabular-nums text-on-scrim-muted">{episodeLabel}</span>
</div>
```

### 5.3 修复后（两个主题一致）

| 元素 | top | bottom | centerY | 颜色 | 对黑底对比度 |
| --- | --- | --- | --- | --- | --- |
| 返回按钮 | 0 | 44 | **22** | `on-scrim` | — |
| 标题 | 12 | 32 | **22** | `rgb(255,255,255)` | **21.0:1** |
| 第 N 集 | 14 | 30 | **22** | `rgba(255,255,255,0.7)` | **21.0:1**（合成后 ≥11:1） |

纵向中心差 **0px**（要求 ≤2px），两主题文字色完全相同，对比度远超 4.5:1。
`on-scrim` 系列 token 刻意不随主题变化——视频画面永远是暗的，
浅色主题下把遮罩改成白色会让控件完全看不见。

截图：`shots/fix5-topbar-dark.png`、`shots/fix5-topbar-light.png`、
`shots/v2-dark-player.png`、`shots/v2-light-player.png`。

## 6. 播放器倍速与音量

### 6.1 修复前

- `SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]`，**没有 3×**。
- 倍速按钮是「点一下循环切下一档」，从 1× 到 3× 若存在也要点 5 次，
  且看不到有哪些档位。
- 静音按钮只 `video.muted = !video.muted`，**全站没有音量滑块**。

### 6.2 新增 `speed-menu.tsx`

```ts
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const
```

为什么加 3×：短剧单集 1–3 分钟，扫剧时经常想再快一档；3× 只改
`playbackRate`，不解码更多帧，对 HEVC 没有额外压力。

菜单用 `role="menu"` + `role="menuitemradio"` + `aria-checked`，点击外部关闭、
Esc 关闭、打开时焦点落到当前档位、向上弹出（按钮在屏幕底部）。

### 6.3 新增 `volume-control.tsx`

喇叭按钮 + 悬停/点击展开的 0–100 滑块。**只在桌面显示滑块**：iOS Safari 的
`HTMLMediaElement.volume` 是只读的，写进去不报错也不生效；给一个拖不动的
滑块比不给更糟。移动端保留喇叭按钮。

滑块用 `input[type=range]` + 自定义 `::-webkit-slider-thumb`，
轨道 4px、thumb 12px 圆点，与进度条同一套视觉。音量 0 自动静音、
>0 自动取消静音，与系统播放器一致。

### 6.4 实测（1440×900，真实鼠标事件）

| 检查项 | 结果 |
| --- | --- |
| 菜单档位 | `0.5× / 0.75× / 正常 / 1.25× / 1.5× / 2× / 3×`，共 **7** 档 |
| 选 3× 后 `video.playbackRate` | **3** |
| 选 3× 后按钮文本 | **`3×`** |
| 选完菜单是否关闭 | **是** |
| 音量滑块存在 | **是**，`value = 100` |
| hover 喇叭后滑块宽度 | **96px**（展开） |
| 拖到 40% 位置后 `video.volume` | **0.38**，`muted: false`，滑块 `value: 38` |
| 点击喇叭后 `muted` | **true**，`volume` 保持 0.38 |
| Esc 关闭菜单 | **是**（`[role=menu]` 消失） |
| 菜单打开 5 秒后 | 菜单仍在，控件栏 `opacity: 1`（未被自动隐藏） |

截图：`shots/fix6-speedmenu.png`、`shots/fix6-3x.png`、`shots/fix6-volume.png`。

## 7. 视觉高级感重构

### 7.1 用了什么技能查询（逐条记录）

先读 `design-system/hongguo/MASTER.md`（233 行，上一轮生成，Category
Video Streaming/OTT，"Cinema dark + play red"）。本轮重新跑一次设计系统，
再按域查询具体规则。

| # | 命令 | 返回规则 | 采纳/否决与理由 |
| --- | --- | --- | --- |
| 1 | `search.py "cinematic immersive premium streaming minimal near-black" --design-system --variance 4 --motion 3 --density 4 -p Hongguo` | Style **AI-Native UI**，Pattern Product Demo + Features，Primary `#7C3AED` 紫 | **否决**。返回的是 AI 助手风格，与短剧娱乐产品无关；紫色主色也与「红果」品牌冲突。说明设计系统的关键词匹配对风格类查询不稳，需要退回域查询。 |
| 2 | `search.py "video streaming OTT entertainment" --domain product` | **Video Streaming/OTT**：Primary Style = Dark Mode (OLED) + Motion-Driven；Color Focus = "Dark bg + Content poster colors + Brand accent" | **部分采纳**。"Dark bg + 海报色 + 品牌色"正是本项目取向；但否决 Glassmorphism 次级风格（见 #6）。 |
| 3 | `search.py "cinematic dark minimal luxury" --domain style` | **Minimalism & Swiss Style**：Keywords = clean / spacious / functional / white space / high contrast / geometric / grid-based / essential；Effects = subtle hover 200–250ms、sharp shadows if any、clear type hierarchy；Checklist 含 "no unnecessary decorations"、"avoid shadows and gradients" | **采纳，作为本轮主导方向**。这是「高级感」的正确答案：克制、留白、清晰层级、无装饰。用户说的「low」本质是装饰过度。 |
| 4 | `search.py "editorial precise sans serif tracking" --domain typography` | **Minimalist Monochrome Editorial**（Playfair Display + Source Serif 4 + JetBrains Mono） | **否决**。三衬线字体栈适合时尚杂志，不适合高密度短剧列表；且必须引入 Google Fonts 外链，违反约束。保留"收紧字距 + 降低字重"的思路，字体仍用系统栈。 |
| 5 | `search.py "card hover affordance elevation" --domain ux` | **Hover vs Tap**（High）：不要只依赖 hover；**Input Affordance** | **采纳**。卡片 hover 只做「提亮 + 标题变色」，点击行为不依赖 hover；音量滑块同时支持 hover 展开与点击展开。 |
| 6 | `search.py "grid card image aspect ratio" --stack html-tailwind` | **Images / Aspect ratio**（Medium）：`aspect-video` / `aspect-square`，容器必须有比例；**Reserve image space** 防布局跳动 | **采纳**。封面保持 `aspect-[3/4]`，骨架同比例，填充时不跳。 |
| 7 | `search.py "focus ring visible keyboard" --domain ux` | **Focus States**（High）：每个可交互控件都要可见焦点环；不要 `outline-none` 无替代 | **采纳**。卡片 `group-focus-visible:ring-2`、滑块 `:focus-visible` 2px `accent-soft`、全局 `@layer base` 保留 outline。 |

`.agents/skills/ui-ux-pro-max/references/pro-rules.md` 的 Pre-Delivery Checklist 逐项走过，结果见 7.6。

### 7.2 语义 token 重校准

深色底从 `#0a0a0a` 改到 **`#08080a`**。不用纯黑 `#000000`：纯黑在 OLED 上会把
卡片和背景彻底融掉，层级只能靠描边硬撑。

三级层级只差 4–5 个亮度单位：`#08080a → #101013 → #17171b`。差值再大就会
显得「色块拼接」——这是廉价感的主要来源。

| Token | 修复前（dark） | 修复后（dark） | 修复前（light） | 修复后（light） |
| --- | --- | --- | --- | --- |
| `--color-surface` | `#0a0a0a` | **`#08080a`** | `#f4f4f6` | **`#f5f5f7`** |
| `--color-surface-raised` | `#16161a` | **`#101013`** | `#ffffff` | `#ffffff` |
| `--color-surface-overlay` | `#1f1f24` | **`#17171b`** | `#e8e8ec` | **`#ebebef`** |
| `--color-text-primary` | `#f5f5f7` | **`#f4f4f5`** | `#16161a` | **`#101013`** |
| `--color-text-secondary` | `#a1a1aa` | **`#9d9da6`** | `#5c5c66` | **`#57575f`** |
| `--color-text-tertiary` | `#8e8e98` | **`#7d7d86`** | `#63636e` | **`#63636b`** |
| `--color-border` | `#71717d` | **`#6e6e78`** | `#7c7c88` | **`#78788a`** |
| `--color-border-subtle` | `#2a2a30` | **`#22222a`** | `#dcdce4` | **`#e3e3e9`** |

`--color-accent` `#e11d48`、`--color-accent-soft` `#fb7185`、`--color-scrim` 系列不变。

浅色是深色的镜像：深色靠「变亮」提升层级，浅色靠「变白」。
页面 `#f5f5f7`、卡片纯白，靠 4% 亮度差区分，不依赖描边。

### 7.3 逐项视觉改动

**卡片（`series-card.tsx`）** — 改动最大：

1. **不再画卡片底色和描边**。原来是 `bg-surface-raised + ring-1 ring-border-subtle`，
   等于给每张封面套一个可见的框；一整屏 18 个框形成「表格感」。
   现在卡片背景透明，只有封面 + 两行文字，靠网格间距分隔。
2. **去掉 hover 放大**。`scale-[1.04]` 在 6 列网格里会挤到邻居，
   且短剧列表点击频率高，每次划过都缩放显得躁。改成封面 `brightness-110`
   + 标题变 `accent-soft`，安静但明确。
3. **集数角标从封面里挪到标题下方**。见 7.4，这是本轮唯一由审计抓出的新缺陷。

**顶栏（`page-header.tsx`）**：`bg-surface/85 + backdrop-blur-xl` 改成不透明
`bg-surface` + 1px `border-border-subtle`。滚动时封面在毛玻璃后面糊成彩色噪点，
是「廉价」的典型来源。标题 `text-base font-semibold` → `text-[15px] font-medium`。

**搜索页（`search-route.tsx`）**：空状态图标去掉 `rounded-2xl bg-surface-raised ring-1`
方块（近黑底上一个浅灰方块比文字还抢眼），推荐词从填充块改成极细描边，
输入框与按钮从 `rounded-full` 改 `rounded-lg`，焦点外发光从 12%/4px 降到 10%/3px。

**历史页（`history-route.tsx`）**：记录行去掉 `rounded-xl + ring-1`，改
`rounded-lg` + hover 变底色；进度条 `h-1 bg-on-scrim/15` 改 `h-0.5 bg-border-subtle`
（`on-scrim` 是给视频遮罩用的，用在页面上是误用）。

**详情页（`series-route.tsx`）**：见第 4 项；另外选集格子去掉灰底与描边，
改纯文字 + hover 底色；标题 `text-lg` → `text-xl sm:text-2xl`。

### 7.4 审计抓出的新缺陷：浅色主题下集数角标不可读

改完第一版卡片后跑审计，浅色主题首页出现 **14 个文字失败**：

```
{"t":"80 集","r":1.19} {"t":"432 集","r":1.19} {"t":"177 集","r":1.19} ...
```

原因：集数是压在封面底部的白字 + 64px 渐变遮罩。封面亮度不可控，
浅色封面 + 白字 = 1.19:1。这不是配色问题，是**结构问题**——把文字放在
不可控背景上，无论怎么调 token 都无法保证对比度。

修复：把集数移到封面下方，与题材同一行，用 `text-text-tertiary`。
封面完全裸露，不再需要渐变遮罩。修复后浅色首页 `tf: 0`、`minText: 6.57`。

### 7.5 全量对比度复测

`scripts/ui-audit.mjs` 同一份脚本，5 个页面 × 2 个主题 × 2 个视口。

**1440×900 / dark**（`bodyBg: rgb(8, 8, 10)`）：

| 页面 | 文字失败 | 边框失败 | 图标失败 | 最低文字对比度 | <44px 目标 | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | 0 | 0 | 0 | **4.91** | 0 | 0 |
| `/search` | 0 | 0 | 0 | **4.70** | 0 | 0 |
| `/history` | 0 | 0 | 0 | **4.66** | 0 | 0 |
| `/series` | 0 | 0 | 0 | **4.70** | 0 | 0 |
| `/watch` | 0 | 0 | 0 | **10.02** | 0 | 0 |

**1440×900 / light**（`bodyBg: rgb(245, 245, 247)`）：

| 页面 | 文字失败 | 边框失败 | 图标失败 | 最低文字对比度 | <44px 目标 | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | 0 | 0 | 0 | **6.57** | 0 | 0 |
| `/search` | 0 | 0 | 0 | **5.07** | 0 | 0 |
| `/history` | 0 | 0 | 0 | **5.95** | 0 | 0 |
| `/series` | 0 | 0 | 0 | **5.07** | 0 | 0 |
| `/watch` | 0 | 0 | 0 | **10.02** | 0 | 0 |

**390×844 / dark**：五页 `tf 0 / bf 0 / icf 0 / u44 0 / ox 0`，
最低文字对比度 4.66–10.02，与桌面一致。

所有文字 ≥4.5:1（最低 4.66），所有图标与边框 ≥3:1（失败数 0）。

### 7.6 Pre-Delivery Checklist 逐项

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 语义 token，无硬编码白/黑 | ✅ | `grep -c 'ring-white\|bg-white\|text-white\|bg-black\|from-black\|border-white'` → 0 |
| 双主题持久化 + 跟随系统 | ✅ | 上一轮已验证，本轮未改机制 |
| 文字 ≥4.5:1 | ✅ | 上表，最低 4.66 |
| 图标/边框 ≥3:1 | ✅ | `iconFails 0 / borderFails 0` |
| 触摸目标 ≥44px | ✅ | `under44: []`，五页 × 两主题 |
| 可见焦点环 | ✅ | 卡片 `group-focus-visible:ring-2`、滑块 `:focus-visible` 2px、全局 base outline |
| 不依赖 hover 完成关键操作 | ✅ | 卡片点击、音量点击展开、倍速点击展开 |
| 图片有固定比例，无布局跳动 | ✅ | `aspect-[3/4]` 封面与骨架同比例 |
| `prefers-reduced-motion` | ✅ | 卡片与骨架均带 `motion-reduce:` |
| 无渐变滥用 | ✅ | 全站渐变只剩封面底部 32px 的角标遮罩（已随角标一起删除）与播放器控件遮罩 |
| 无 glow / 毛玻璃 | ✅ | `grep -rn backdrop-blur web/src --include=*.tsx` → 只剩注释 2 行，代码 0 处；搜索框外发光 10% 单层 |
| 无 Google Fonts 外链 | ✅ | 未引入，仍用系统字体栈 |
| 无新 UI 框架 / 组件库 / CSS-in-JS | ✅ | 仍为 Tailwind 4 + 手写组件 |
| 文件名 kebab-case | ✅ | `speed-menu.tsx`、`volume-control.tsx` |
| strict 三标志保留 | ✅ | `tsconfig.base.json` 未改 |
| 受保护文件未触碰 | ✅ | `spade.ts` / `mp4.ts` / `cenc.ts` / `server/src/media/*` mtime 均早于本轮 |
| 未新增测试文件 | ✅ | `git status` 无 repo；`find` 无新增 `*.test.ts` |

### 7.7 工程检查

```
pnpm -r typecheck   → 3/3 Done
pnpm -r lint        → 3/3 Done
pnpm -r test        → shared 10 passed / server 13 passed / web 无测试
pnpm -r build       → 3/3 Done
                      JS  337.84 kB │ gzip 104.14 kB
                      CSS  35.89 kB │ gzip   7.00 kB
prettier --write    → 全部 unchanged / 已格式化
```

### 7.8 截图清单（本轮新增）

| 文件 | 内容 |
| --- | --- |
| `shots/fix1-search-390.png` | 第 1 项：390 无关键词，0 骨架 |
| `shots/fix1-search-1440.png` | 第 1 项：1440 无关键词，0 骨架 |
| `shots/fix4-series-dark.png` / `-light.png` | 第 4 项：详情页去模糊背景，双主题 |
| `shots/fix5-topbar-dark.png` / `-light.png` | 第 5 项：顶栏单行对齐，双主题 |
| `shots/fix6-speedmenu.png` | 第 6 项：7 档倍速菜单 |
| `shots/fix6-3x.png` | 第 6 项：选中 3× 后 |
| `shots/fix6-volume.png` | 第 6 项：音量滑块展开 |
| `shots/v2-dark-feed.png` / `v2-light-feed.png` | 第 7 项：首页双主题 |
| `shots/v2-dark-search.png` | 第 7 项：搜索空状态 |
| `shots/v2-dark-series.png` / `v2-light-series.png` | 第 7 项：详情页双主题 |
| `shots/v2-dark-player.png` / `v2-light-player.png` | 第 7 项：播放页双主题 |
| `shots/v2-m-dark-feed.png` | 第 7 项：390 首页 |
| `shots/v2-m-dark-series.png` | 第 7 项：390 详情页 |

## 8. 本轮结论

7 个缺陷全部修复并实测通过。其中 3 个的根因不是「样式写错」而是**机制写错**：

- 第 1 项：`isPending` 在 `enabled: false` 时仍为 `true`，是库语义而非 bug。
- 第 2 项：冷却期 `return` 丢弃回调 + `IntersectionObserver` 无状态变化，
  两个独立机制相乘才导致卡死。
- 第 7.4 项：白字压在不可控亮度的封面上，任何 token 调整都无法保证对比度，
  必须改结构。

视觉方向上，设计系统对风格类关键词（"cinematic premium"）会返回不相关的
AI-Native UI，必须退回 `--domain style` / `--domain product` 查询。
最终采纳 **Minimalism & Swiss Style**：克制、留白、清晰层级、去掉装饰。
「廉价感」的来源不是颜色不够炫，而是装饰太多——卡片框、毛玻璃、渐变遮罩、
灰胶囊、发光焦点环。逐个删掉之后，封面本身成为视觉主角。

---

# 第七轮：播放器全屏

> 用户需求：「加一个全屏功能，PC 上就是直接全屏，移动端应该是横屏全屏」，
> 并附一张竖屏播放截图——上下各一大块黑边，视频只占屏幕 26%。

## 1. 全屏目标：容器，不是 `<video>`

这是本轮唯一重要的架构决定。

`video.requestFullscreen()` 会进入**浏览器原生视频全屏**：控件、倍速菜单、
选集抽屉、手势全部被系统 UI 覆盖，等于放弃自己的播放器。第六轮刚做的
7 档倍速菜单、音量滑块、单行顶栏会全部失效。

所以全屏目标是 `.player-shell`——包裹 `<video>` 和控件层的那个 `div`。

代价：移动端**不会自动横屏**。原生视频全屏由系统负责旋转，元素全屏不会，
必须显式调 `screen.orientation.lock('landscape')`。

## 2. 三条执行路径

| 场景 | 判断条件 | 行为 |
| --- | --- | --- |
| 已在全屏 | `document.fullscreenElement !== null` | 退出全屏 |
| 触屏 + 支持元素全屏（Android Chrome / iPad Safari 16+） | `requestFullscreen` 存在 且 `(pointer: coarse)` | 容器全屏 → 锁横屏，保留自有控件层 |
| 触屏 + 不支持元素全屏（iPhone Safari） | `requestFullscreen` 不存在 | 退回 `video.webkitEnterFullscreen()`，进入系统播放器 UI |
| 桌面 | `requestFullscreen` 存在 且 非 coarse | 容器全屏，**不尝试锁横屏** |

桌面不尝试锁横屏是有意的：桌面浏览器普遍拒绝 `lock('landscape')`（没有
物理旋转），每次全屏都会产生一个被拒绝的 Promise。桌面全屏本身就是横屏窗口，
锁方向没有意义。

## 3. 顺序约束：必须全屏后才能锁方向

非全屏状态下调 `screen.orientation.lock()` 会抛 `InvalidStateError`。
所以 `enter()` 里是 `requestFullscreen().then(() => lock('landscape'))`，
不能并行，也不能提前。

实测验证（mock `screen.orientation.lock` 记录调用时刻）：

```json
{"call":"lock","type":"landscape","fsActive":true}
```

`fsActive: true` 证明锁方向发生在全屏生效之后。桌面路径下 `lock` 调用数
为 **0**（`lockLandscape: false`），符合设计。

## 4. 修掉一个由全屏引入的新缺陷

**问题**：`volume-control.tsx` 原来用 `sm:block`（≥640px）控制音量滑块显隐。
手机竖屏 390px 时滑块隐藏——正确。但**全屏横屏后宽度变成约 844px**，
`sm:` 断点命中，滑块重新出现。而 iOS 的 `HTMLMediaElement.volume` 是只读的，
这个滑块拖不动。等于用全屏功能把一个已修好的缺陷又打开了。

**修复**：把判断依据从**视口宽度**改成**设备能力**。

```ts
const [canSetVolume] = useState(() => {
  const probe = document.createElement('video')
  probe.volume = 0.5
  return Math.abs(probe.volume - 0.5) < 0.01
})
```

实际赋值后读回，比 UA 嗅探可靠，比 `matchMedia` 精确。用 `useState` 一次性
探测，因此横屏/竖屏切换不会让判断结果翻转。

同时把「隐藏」改成「不渲染」：`w-0` 隐藏的滑块仍留在无障碍树里，
屏幕阅读器用户可以聚焦到一个完全无效的控件。

**实测**（模拟 iOS：`volume` setter 静默忽略）：

| 场景 | 视口 | 滑块在 DOM | 静音按钮 | 探测 `canSetVolume` |
| --- | --- | --- | --- | --- |
| 桌面 | 1440×900 | **是** | 是 | `true` |
| iOS 模拟（全屏横屏尺寸） | 844×390 | **否** | **是** | `false` |

## 5. 全屏样式

全屏元素需要显式铺满并压黑：

```css
.player-shell:fullscreen,
.player-shell:-webkit-full-screen {
  width: 100vw;
  height: 100vh;
  background: var(--color-scrim);
  overflow: hidden;
}
```

浏览器只保证全屏元素占满视口，不保证背景色。容器背景若是透明的，
会露出浏览器默认白底，在暗场视频里非常刺眼。

## 6. 交互与快捷键

- 按钮放在控件行最右侧，紧邻进度时间，与主流播放器一致。
- 图标随状态切换：进入前四角向外，全屏中四角向内。
- `aria-label` 在「全屏 / 退出全屏」之间切换，`aria-pressed` 暴露状态。
- **`F` 键**切换全屏（YouTube / Bilibili 通用约定）。
- **`Esc`** 由浏览器原生处理，`fullscreenchange` 监听器同步 UI 状态并
  `unlock()` 方向锁，避免设备卡在横屏。

`F` 键单独一个 effect，没有塞进已有的键盘 effect：那个 effect 依赖
`togglePlay` / `seekBy`，加进来会让它在每次倍速变化时重绑。

## 7. 实测数据

### 7.1 桌面（1440×900，真实鼠标事件）

| 检查项 | 结果 |
| --- | --- |
| 按钮存在且可命中 | 是，`44×44`，`elementFromPoint` 命中按钮本身 |
| 点击后 `document.fullscreenElement` | **`.player-shell`**（不是 video） |
| 全屏后容器尺寸 | **1440×900**，等于视口 |
| 全屏后按钮标签 | **退出全屏** |
| 再点击 | 退出成功，标签回到**全屏** |
| Esc | 退出成功，标签回到**全屏** |
| `F` 键 | 进入 / 退出均生效 |
| 横屏锁调用数 | **0**（桌面不尝试，符合设计） |

截图：`shots/fs-desktop-entered.png`。

### 7.2 触屏模拟（`(pointer: coarse)` 命中）

| 检查项 | 结果 |
| --- | --- |
| `isTouch` | `true` |
| 全屏后 `lock` 调用 | **1 次**，`type: 'landscape'`，`fsActive: true` |
| 按钮标签 | 退出全屏 |
| 容器背景 | `rgb(0, 0, 0)`（scrim，不是浏览器白底） |

### 7.3 横屏布局（844×390，模拟全屏后的手机）

| 检查项 | 结果 |
| --- | --- |
| 容器 | `0,0 844×390`，铺满视口 |
| 视频显示高度 | **390px**（占满，无黑边） |
| 顶栏 | 返回按钮 `44×44`，与标题同行 |
| 控件行 | 静音 / 倍速 / 选集 / 全屏，全部 ≥44px |
| `<44px` 目标数 | **0** |
| 音量滑块 | **不在 DOM**（iOS 只读，正确） |

截图：`shots/fs-mobile-landscape.png`、`shots/fs-ios-landscape.png`。

### 7.4 竖屏黑边量化（用户截图里的问题）

| 场景 | 视频比例 | 容器 | 视频显示 | 上下黑边 | 面积占用 |
| --- | --- | --- | --- | --- | --- |
| 竖屏 390×844 | 1.78 | 390×844 | 390×219 | **各 313px** | **25.9%** |
| 竖屏 430×932 | 1.78 | 430×932 | 430×242 | 各 345px | 26.0% |
| 横屏 844×390 | 1.78 | 844×390 | 693×390 | **0** | **82.1%** |

竖屏下视频只占 25.9% 面积——这是用户截图里「上下两坨黑」的根因。
横屏全屏后升到 82.1%，黑边归零。这正是「移动端应该横屏全屏」的产品依据。

## 8. 一个必须说明的测试环境限制

无头 Chromium 里 `requestFullscreen()` 会在约 **1.08 秒后自动退出**，
`fullscreenchange` 触发第二次且 `fullscreenElement` 变为 `null`。

我做了对照实验排除自己的代码：向页面注入一个**与 React 完全无关**的静态
`div`，直接调 `requestFullscreen()`，同样在 1.08 秒后自动退出。

```
{"events":[{"dt":1629,"el":"probe"},{"dt":2706,"el":null}]}   ← 间隔 1077ms
```

所以这是无头环境的行为，不是应用缺陷。真实浏览器中不会发生。
状态机逻辑因此改用 mock 验证：mock `screen.orientation.lock` 记录调用时刻，
用 `document.fullscreenElement` 的瞬时值确认容器确实进入过全屏。

## 9. 工程检查

```
pnpm -r typecheck   → 3/3 Done
pnpm -r lint        → 3/3 Done
pnpm -r test        → shared 10 passed / server 13 passed
pnpm -r build       → 3/3 Done
                      JS  340.80 kB │ gzip 104.96 kB
                      CSS  36.02 kB │ gzip   7.03 kB
prettier --write    → 已格式化
```

新增文件：`web/src/features/player/use-fullscreen.ts`（kebab-case）。
未新增测试文件，未触碰受保护文件，未引入新依赖。

## 10. 遗留与后续建议

竖屏**非全屏**状态下黑边仍在（25.9% 面积占用）。这是竖屏播放横屏内容的
固有结果，只有三种处理方式，都需要产品决策：

1. **保持现状**：`object-contain`，画面完整但有黑边。当前实现。
2. **`object-cover` 填满**：无黑边，但会裁掉画面左右两侧（约 63% 的宽度），
   字幕和人物可能被切掉。短剧画面信息密度高，风险大。
3. **竖屏时把播放器改成 16:9 定高**：不铺满屏幕，下面留出选集/简介区域。
   这是 B 站/YouTube 竖屏的做法，但会改变当前「全屏沉浸」的页面结构。

用户明确要求的是「移动端横屏全屏」，已实现。竖屏非全屏态是否需要调整，
等用户确认后再做。
