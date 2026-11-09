# mlzwl 维护约定

所有代码代理必须使用中文与用户交流和回答。

## Monorepo

- 使用 pnpm workspace；应用放在 `apps/*`。
- `apps/lark-pi-bridge` 是独立的 Pi coding-agent 飞书/Lark channel bridge。
- `apps/x-adapter` 发布为 `@mlzwl/x-adapter`，是仅支持 Trae 与豆包工作的本地模型网关。
- `apps/magpie-x-adapter` 发布为 `@mlzwl/magpie-x-adapter`，以 OpenCode 插件格式向 Magpie 提供唯一的 `x-adapter` provider。该包不得带 `pi` manifest、`pi-package` 关键字或 Pi coding-agent 依赖，否则 Magpie 会改用 Pi 加载器并忽略 OpenCode 入口。
- 根目录维护共享 ESLint、Prettier、TypeScript 配置和仓库级脚本。
- 仓库内临时材料统一放在根目录 `.tmp/`；不提交 `node_modules/`、`dist/`、coverage、日志、候选 tarball、`.tmp/` 或真实凭据。

## 常用命令

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm verify
```

以上命令是全仓或单包的全量命令。日常改动的验证范围按「测试范围」一节决定，不要默认执行这些全量命令。

x-adapter 全量验证：

```bash
pnpm --filter @mlzwl/x-adapter verify
pnpm --filter @mlzwl/x-adapter pack:dry-run
```

Magpie 插件全量验证：

```bash
pnpm --filter @mlzwl/magpie-x-adapter verify
pnpm --filter @mlzwl/magpie-x-adapter pack:dry-run
```

Bridge 全量验证：

```bash
pnpm --filter @mlzwl/lark-pi-bridge verify
pnpm --filter @mlzwl/lark-pi-bridge smoke:local
pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
```

## 测试范围

默认只运行与本次改动范围对应的测试。不要因为改了少量代码就执行 `pnpm verify`、`pnpm test`、`pnpm build` 或全部子包的 `verify`。全量验证只在下面列出的条件下执行。

选择测试范围的步骤：

1. 先确定改动所属的范围：`apps/x-adapter`、`apps/lark-pi-bridge`、`apps/magpie-x-adapter` 或根 `scripts/`。
2. 只对该范围运行 `typecheck`、`lint`、`format:check` 与相关测试文件。
3. 改动命中跨包共享层时，才升级为全仓检查。跨包共享层指根 `scripts/*`、`tsconfig.base.json`、`eslint.config.js`、根 `package.json` 脚本和 `pnpm-workspace.yaml`。

各范围的目标测试命令：

- `apps/x-adapter`：`test/*.test.js` 依赖 `dist/` 的模块化编译产物。先在 `apps/x-adapter` 内执行 `node ../../scripts/build-package.mjs --test`，再执行 `node --test test/<name>.test.js`，只跑相关文件。需要发布产物时，最后执行 `pnpm --filter @mlzwl/x-adapter build` 恢复双 bundle 的 `dist/`。
- `apps/lark-pi-bridge`：按目录选择用例，例如 `pnpm --filter @mlzwl/lark-pi-bridge exec vitest run tests/unit/<name>.test.ts`；集成与进程用例替换目录名即可。只有改动涉及 Pi 进程启动、RPC 或真实平台行为时，才运行 `tests/process` 或 `smoke:local`。
- `apps/magpie-x-adapter`：改动插件入口或 manifest 时运行 `pnpm --filter @mlzwl/magpie-x-adapter test`。该命令包含构建和 manifest 校验。
- 根 `scripts/`：`node --test scripts/<name>.test.mjs`。
- 只改文档或注释时，只对改动文件执行 `pnpm exec prettier --check <file>`，不运行测试。

只有以下情况才运行全量 `pnpm verify`：

1. 改动命中上面列出的跨包共享层。
2. 用户明确要求全量验证。
3. 目标用例失败，且怀疑存在跨包影响，需要扩大范围确认。

交付时必须报告实际执行的命令和覆盖范围。不要用一次目标测试的结果声称全仓通过。

## 开发与安全

- 保持 TypeScript strict / NodeNext；源码使用 ESM，内部编译目标引用保留 `.js` 后缀。
- JavaScript/TypeScript 控制流必须使用花括号，并由 Prettier 格式化。
- magpie-x-adapter 的发布构建是单个压缩 bundle，`dist/` 只保留 `dist/index.js`。其 manifest 不得带 `pi` 字段、`pi-package` 关键字或 Pi coding-agent 依赖。
- `init --register` 是需人工扫码确认的真实平台写入，build/test/verify/smoke 不得触发。
- x-adapter 的真实 Trae / 豆包登录与模型调用需要用户明确授权；默认数据目录固定为 `~/.x-adapter`。
- 测试 Magpie 插件时必须使用 `.tmp/` 下的隔离 `HOME`、专用 `X_ADAPTER_PORT` / `X_ADAPTER_BASE_URL` 和专用 `X_ADAPTER_DATA_DIR`。不得停止或重启用户默认端口 `10100` 上的 daemon。
- Pi JSON/RPC preflight 只允许临时 profile、非真实 key 和 `127.0.0.1` mock；不得读取默认 Pi auth 或调用真实 provider。
- 真实飞书连接、模型调用、service 安装和 npm 发布都需要用户明确授权。
- 发布包 README 只保留面向用户的安装、配置、使用、安全提示和文档入口；架构与验证细节放在 app 的 `docs/`。Changelog 是否保留由各 app 自己的 AGENTS.md 约定。
- 修改用户可见能力时同步更新对应 app 的 README 和相关 `docs/`；README 与 `docs/` 是仓库内唯一文档来源。

## GitHub 与 npm

- 默认分支为 `master`，远端为 GitHub `chenerzhang/mlzwl`。
- 代理判断当前任务确需隔离开发、创建 PR 或执行发布流程时，可以自行创建并切换本地分支，无需另行询问用户；切换前必须确认不会覆盖或丢失现有工作区改动，不得借此执行 stash、reset、clean、rebase 或改写历史。创建或切换分支本身不扩大提交、push、PR、合入或发布授权。
- 提交、push、创建 PR、创建 tag 或发布 npm 前必须取得当前请求中的明确授权；不得 force push 或改写历史。普通代码 PR 不自动合入；用户明确要求“发布”或“发一个版本”时，授权范围按 npm-release skill 执行，包含创建并合入仅含版本元数据的版本 PR。
- Pull Request 使用 `.agents/skills/create-pr/SKILL.md`；npm 发布使用 `.agents/skills/npm-release/SKILL.md`。
- 公共 npm registry 固定为 `https://registry.npmjs.org`，release tag 使用包级前缀：bridge 为 `lark-pi-bridge-v<version>`，x-adapter 为 `x-adapter-v<version>`，Magpie 插件为 `magpie-x-adapter-v<version>`。
- 不得输出或提交 npm token、GitHub token、App Secret、provider key、Cookie、JWT 或 auth 文件内容。
