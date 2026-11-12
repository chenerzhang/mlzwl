# hongguo 维护约定

所有代码代理必须使用中文与用户交流和回答。

本文件只约束 `apps/hongguo`。仓库级约定见根 [`AGENTS.md`](../../AGENTS.md)。

## 项目定位

红果短剧的自托管 Web 客户端。三个 workspace 包：

- `@mlzwl/hongguo-shared` — 同构层，server 与 web 共用。签名算法、CENC 规划、MP4 解析、Zod schema。
- `@mlzwl/hongguo-server` — NestJS + Fastify，持有上游 SDK、设备身份与内容密钥。
- `@mlzwl/hongguo-web` — Vite + React 19 + Tailwind 4。

## 核心契约

- **浏览器不接触上游**。签名头（`x-gorgon` / `x-ladon` / `x-argus` / `x-ss-stub`）和设备指纹只存在于服务端。不得把签名逻辑下移到 `web`。
- **不转码**。视频是 CENC 加密的，服务端原地解密（长度不变），因此 MP4 偏移表有效、可直接支持 Range 请求。不得引入 ffmpeg。
- **雪碧图按整张网格返回**。上游 `img_urls` 可能是多张，每张恰好 `img_x_len * img_y_len` 个格子。取帧必须用 `img_num` 并钳制到 `frameCount - 1`。
- **`server/data/` 不得提交**。`devices.profile` 是设备指纹，泄露等于交出设备身份。首次启动会自动建表并注册新设备，因此删掉它是安全的。
- 默认监听 `0.0.0.0`（所有 IPv4 网卡），方便同一局域网的手机访问。注意 `0.0.0.0` **不等于**只对局域网开放：主机有公网地址、VPN、容器网桥或端口转发时同样可被访问，而 `/api/*` 没有鉴权、`server/data/` 含设备指纹。实际隔离依赖主机防火墙与路由器，只能在可信网络使用，严禁暴露公网。需要仅限本机时设 `HOST=127.0.0.1`。

## 命令

全部在仓库根目录执行。

```bash
pnpm hongguo:typecheck
pnpm hongguo:lint
pnpm hongguo:test
pnpm hongguo:build
pnpm hongguo:verify      # 上面四项串行
pnpm hongguo:dev         # 开发：并行启动 server + web（热更新）
pnpm hongguo:start       # 生产：只启动 server（:9133），同时托管 web/dist
```

**端口约定**：生产期只有一个端口 `9133`，后端同时提供前端与接口。
`pnpm hongguo:dev` 会额外起 Vite（`:5173`）做热更新，这是开发期形态，
不是部署形态。不要为生产再引入独立的静态服务器或反向代理。

改 `server/src/serve-web-dist.ts` 或前端路由结构后，必须实测这三条：

1. `/` 返回 HTML（200）。
2. 深链如 `/series/:id` 返回 HTML（200），不是 404。
3. `/api/<不存在的路径>` 返回 JSON 404，不是 HTML。
   若回落逻辑写宽了，这里会返回 200 的 HTML，浏览器把 JS 当 HTML 解析并报
   `Unexpected token '<'`。

单包命令用 `pnpm --filter`：

```bash
pnpm --filter @mlzwl/hongguo-shared build    # server 与 web 依赖它的 dist/，必须先跑
pnpm --filter @mlzwl/hongguo-server test
pnpm --filter @mlzwl/hongguo-web dev
```

## 测试范围

默认只跑与改动对应的范围，不要因为改了几行就执行全仓 `pnpm verify`。

- 改 `shared/`：跑 `pnpm --filter @mlzwl/hongguo-shared test`，再跑 server 与 web 的 `typecheck`（两者都消费它的类型）。
- 改 `server/`：跑 `pnpm --filter @mlzwl/hongguo-server test`。
- 改 `web/`：跑 `pnpm --filter @mlzwl/hongguo-web test`（可能为空）+ `typecheck` + `lint`。
  涉及渲染、手势、媒体元素行为的改动仍需手动验证。
- 改 `scripts/ui-audit.mjs`：需要前后端都在运行，且改动后必须实际跑一次。
- 只改文档：`pnpm exec prettier --check <file>`。

改动命中根 `pnpm-workspace.yaml`、根 `package.json` 脚本或 `tsconfig.base.json` 时，才升级为全仓 `pnpm verify`。

## 代码风格

继承仓库根配置，另有子包覆盖：

- Prettier 用根 `.prettierrc.json`（`semi: true`）。本包原仓库用 `semi: false`，迁入时已全部重格式化。
- ESLint 用子包自己的 `eslint.config.js`：在根规则基础上**额外启用 `curly: ['error', 'all']`**，并给 `web/` 单独配置浏览器全局变量。根 `eslint` 会自动发现这个文件。
- TypeScript 用子包 `tsconfig.base.json`，它 `extends` 根配置并**额外开启** `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noPropertyAccessFromIndexSignature`、`noUnusedLocals`、`noUnusedParameters`、`verbatimModuleSyntax`。这些严格标志必须保留。
- 所有文件和目录用小写 kebab-case。
- 前端静态资源放 `web/src/assets/`，由 Vite 打 hash 进 `dist/assets/`。
  不要用 `web/public/`：那是「原样拷贝、不带 hash」的逃生舱，只适合
  `robots.txt`、`favicon.ico` 这类必须固定路径的文件。本包连 favicon 都走
  `src/assets/`，所以没有 `public/` 目录。

## 禁止事项

- 不访问 `huangguoai.ai`（用户明确禁止）。只用本地代码、红果上游与 `openhongguo` SDK。
- 不改 `shared/src/{spade,mp4,cenc}.ts` 与 `server/src/media/*` 的算法语义。这些有真实向量测试（`shared/src/spade.test.ts` 6 组、`server/src/media/cenc.test.ts`）保护，改动必须先确认测试仍绿。
- 不引入新的 UI 框架、组件库或 CSS-in-JS。只用 Tailwind 4 + 手写组件。
- 不引入 Google Fonts 等外部字体链接。
- 不新增测试文件，除非用户明确同意。`web` 的测试白名单见下一条。

### web 测试边界

`web` 允许存在测试，但只测**纯逻辑**，不测渲染。约束：

1. **不引入 `jsdom` / `happy-dom` / `@testing-library/*`**。测试跑在 vitest 默认的
   node 环境，被测模块不得在 import 期访问 `window` / `document` / `localStorage`。
   需要浏览器能力时，把它抽成可注入的参数（如传入 `Storage` 或 `now()`），
   而不是在测试里伪造全局对象。
2. **测试文件与被测模块同目录**，命名 `<name>.test.ts`，只用 `vitest` 的
   `describe` / `it` / `expect`。
3. **只覆盖有分支或边界判断的纯函数**：格式化、归一化、区间合并、状态机、
   排序、去重、超时与重试策略。不测「组件能渲染出 div」这类断言。
4. **一个逻辑模块一个测试文件**，不要为同一个模块拆多个测试文件，也不要给组件写测试。
   同一目录下的多个独立逻辑模块各自带一个测试是正常的（`features/player/`
   就有画幅、快捷键、分组、区间合并等多个互不相关的纯函数模块）。
5. 新增测试文件时，同步确认 `pnpm --filter @mlzwl/hongguo-web test` 与
   `typecheck` 都通过（`tsconfig.json` 的 `include` 已含 `src`，测试文件会被
   typecheck 覆盖）。

## 视觉约定

改视觉前先查 skill，不要凭印象配色：

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "cinematic dark minimal" --domain style
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "video streaming ott" --domain product
python3 .agents/skills/ui-ux-pro-max/scripts/search.py "card hover affordance" --domain ux
```

注意 `--design-system` 模式对抽象形容词不可靠：查询 `cinematic immersive
premium streaming` 曾返回「AI-Native UI + 紫色 #7C3AED」，与本包完全不匹配。
用 `--domain style` / `--domain product` 查具体领域更稳。

`web` 的设计 token 在 `web/src/styles/index.css` 的 `@theme` 与 `[data-theme='light']` 两处。改 token 前先跑审计，改完再跑一次对比：

```bash
node apps/hongguo/scripts/ui-audit.mjs
```

审计覆盖 5 个页面 × 2 主题 × 2 视口，输出对比度、边框对比度、图标对比度、触摸目标尺寸、横向溢出。当前基线：文本对比度最低 4.66（暗）/ 5.07（亮），`textFails` / `borderFails` / `iconFails` / `under44` / `overflowX` 全为 0。

暗色三层表面只差 4–5 个亮度单位（`#08080a` → `#101013` → `#17171b`）。不要靠提高对比度做"层次感"，会变成廉价感。层次靠留白和发丝线。
