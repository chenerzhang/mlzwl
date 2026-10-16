# mlzwl 维护约定

所有代码代理必须使用中文与用户交流和回答。

## Monorepo

- 使用 pnpm workspace；应用放在 `apps/*`。
- `apps/lark-pi-bridge` 是独立的 Pi coding-agent 飞书/Lark channel bridge。
- `apps/x-adapter` 发布为 `@mlzwl/x-adapter`，是仅支持 Trae 与豆包工作的本地模型网关。
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

x-adapter 验证：

```bash
pnpm --filter @mlzwl/x-adapter verify
pnpm --filter @mlzwl/x-adapter pack:dry-run
```

Bridge 验证：

```bash
pnpm --filter @mlzwl/lark-pi-bridge verify
pnpm --filter @mlzwl/lark-pi-bridge smoke:local
pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
```

## 开发与安全

- 保持 TypeScript strict / NodeNext；源码使用 ESM，内部编译目标引用保留 `.js` 后缀。
- JavaScript/TypeScript 控制流必须使用花括号，并由 Prettier 格式化。
- `init --register` 是需人工扫码确认的真实平台写入，build/test/verify/smoke 不得触发。
- x-adapter 的真实 Trae / 豆包登录与模型调用需要用户明确授权；默认数据目录固定为 `~/.x-adapter`。
- Pi JSON/RPC preflight 只允许临时 profile、非真实 key 和 `127.0.0.1` mock；不得读取默认 Pi auth 或调用真实 provider。
- 真实飞书连接、模型调用、service 安装和 npm 发布都需要用户明确授权。
- 发布包 README 只保留面向用户的安装、配置、使用、安全提示和文档入口；架构与验证细节放在 app 的 `docs/`。Changelog 是否保留由各 app 自己的 AGENTS.md 约定。
- 修改用户可见能力时同步更新对应 app 的 README 和相关 `docs/`；README 与 `docs/` 是仓库内唯一文档来源。

## GitHub 与 npm

- 默认分支为 `master`，远端为 GitHub `chenerzhang/mlzwl`。
- 代理判断当前任务确需隔离开发、创建 PR 或执行发布流程时，可以自行创建并切换本地分支，无需另行询问用户；切换前必须确认不会覆盖或丢失现有工作区改动，不得借此执行 stash、reset、clean、rebase 或改写历史。创建或切换分支本身不扩大提交、push、PR、合入或发布授权。
- 提交、push、创建 PR、创建 tag 或发布 npm 前必须取得当前请求中的明确授权；不得 force push 或改写历史。普通代码 PR 不自动合入；用户明确要求“发布”或“发一个版本”时，授权范围按 npm-release skill 执行，包含创建并合入仅含版本元数据的版本 PR。
- Pull Request 使用 `.agents/skills/create-pr/SKILL.md`；npm 发布使用 `.agents/skills/npm-release/SKILL.md`。
- 公共 npm registry 固定为 `https://registry.npmjs.org`，release tag 使用包级前缀：bridge 为 `lark-pi-bridge-v<version>`，x-adapter 为 `x-adapter-v<version>`。
- 不得输出或提交 npm token、GitHub token、App Secret、provider key、Cookie、JWT 或 auth 文件内容。
