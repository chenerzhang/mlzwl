---
name: npm-release
description: 管理 mlzwl monorepo 的公共 npm 子包 Changelog、首次发布、仅发布及 patch/minor/major 发版。用户要求分析发版差异、发布 lark-pi-bridge、升级版本或生成 GitHub Release 时使用。
---

# mlzwl npm 本地发布

当前支持：

| 包名                    | 包目录                | tag                         |
| ----------------------- | --------------------- | --------------------------- |
| `@mlzwl/lark-pi-bridge` | `apps/lark-pi-bridge` | `lark-pi-bridge-v<version>` |

公共 registry 固定为 `https://registry.npmjs.org`，默认分支为 `master`，托管平台为 GitHub。版本改动通过 PR 合入，npm publish 从维护者本机执行。

## 请求与授权

- 用户询问差异、流程或 Changelog 草稿时只读。
- 用户说“发布”“发一个版本”或“发一个 patch/minor/major 版本”即授权完成整个对应发布流程：版本准备、commit、普通 push、创建版本 PR、用允许的 merge commit 合入、从本机发布 npm、创建并 push annotated tag、创建 GitHub Release。
- 用户说“发布当前版本”或“仅发布”时不隐式 bump；校验当前 `master` manifest 后执行本地发布、tag 和 GitHub Release。
- 用户明确说“首次发布”时发布当前 manifest，不隐式 bump。
- 完整发布请求不在版本 PR 创建后等待二次人工确认；验证和 GitHub 分支规则满足后直接使用 `gh pr merge --merge`。不得使用 `--admin`、auto-merge、squash、force push、覆盖 tag或绕过分支保护。
- bump 类型不明确时：若用户只说“发布”，当前 manifest 已高于 npm latest 则发布当前版本，否则默认 patch。发现 breaking change、版本历史冲突或无法证明候选版本正确时停止询问。

## 凭据与本地发布入口

- npm 凭据仅来自仓库根目录被 Git 忽略的 `.env`：`NPM_TOKEN=<granular access token>`。`.env` 必须是普通文件；非 Windows 下权限不得宽于 `0600`。
- `.env.example` 只放占位值。不得输出、提交或复制真实 token 到 `.tmp/`、日志、命令参数、GitHub Secret、commit、PR 或聊天。
- 发布脚本 `scripts/npm-publish-local.mjs` 解析 `.env`，创建系统临时目录中的 `0600` npmrc，并只向 `npm whoami` / `npm publish` 子进程注入 token；结束后删除临时 npmrc。
- 不使用用户全局 npmrc 中的认证，不运行 `npm config set`，不使用 Keychain，不加 `--provenance`。
- 授权检查：

  ```bash
  pnpm npm:auth-check
  ```

  只报告账号和成功/失败，不显示 token。

- 安全预检和真实发布：

  ```bash
  pnpm npm:publish:preflight
  pnpm npm:publish:local
  ```

- `npm:publish:local` 是真实 registry 写入，只能在用户当前请求明确授权发布时运行。
- Bypass 2FA direct-publish token 将于 2027 年 1 月失效；到时必须改用 npm 当时支持的本地认证方式或重新评估 Trusted Publishing，不能降低验证边界。

## 共同边界

- 真实发布入口要求：工作区完全干净、当前分支恰为 `master`、`HEAD` 与 `origin/master` 完全一致。
- 普通源码、测试和非 Changelog 文档应先通过正常 PR 进入 `master`。版本 PR 只包含目标包 `package.json`、README 和因版本记录产生的 `pnpm-lock.yaml`（若实际变化）。
- Changelog 只能来自源码、测试和公开文档证据，只写用户、集成方或运维可感知的变化。使用 `Added`、`Changed`、`Fixed`、`Security`、`Deprecated`、`Removed`，不创建空分类。
- npm 版本不可覆盖。registry 查询、publish、PR merge、tag push 或 GitHub Release 结果不明确时先回读，不盲目重试。
- publish 始终针对脚本刚刚 `npm pack` 生成的绝对 tarball 路径，不使用 `npm publish apps/lark-pi-bridge`，不运行 publish lifecycle 第二遍。
- 发布脚本将精确 `master` SHA 写入最终 tarball 的 `gitHead`，并在 publish 后核验 registry 的版本、`gitHead`、SHA-512 integrity、SHA-1 shasum 和 `latest`。publish 前发现目标版本已存在时拒绝重复发布；publish 返回后即使退出状态异常，也先以本次本地 tarball 回读 registry，完整匹配才视为成功。
- release tag 必须是 annotated tag `lark-pi-bridge-v<version>`，并指向 `master` 上包含该精确版本的 commit。
- GitHub Release 从同一个 tag 创建；title 使用 `lark-pi-bridge v<version>`，notes 与 README 同版本 Changelog 语义一致。
- 当前只有一个包；以后多包也必须串行发布。

## Changelog 证据

确定上一个已发布 tag 与候选 `origin/master` SHA 后，至少检查：

```bash
git diff --name-status <previous-tag> <master-sha> -- \
  apps/lark-pi-bridge package.json pnpm-lock.yaml tsconfig.base.json eslint.config.js

git diff --stat <previous-tag> <master-sha> -- \
  apps/lark-pi-bridge package.json pnpm-lock.yaml tsconfig.base.json eslint.config.js

git log --no-merges --oneline <previous-tag>..<master-sha> -- \
  apps/lark-pi-bridge package.json pnpm-lock.yaml tsconfig.base.json eslint.config.js
```

若 tag 不是 master 祖先，commit log 不能作为唯一证据，必须直接比较 tree。临时材料只放 `.tmp/npm-release/`。

README 发布区间使用 `<!-- npm-release:start -->` / `<!-- npm-release:end -->`。准备发布时必须把 `### Unreleased` 中属于该版本的条目合并进候选版本并删除空章节。正式版本按新到旧排列：

```md
### [<version>] - <YYYY-MM-DD>

#### Fixed

- …
```

同版本条目已存在但内容不同则停止，不覆盖人工内容。

## 常规 patch/minor/major 发版

1. 记录用户请求的 bump 类型；只允许 stable SemVer。
2. 工作区必须干净。执行 `git fetch origin --prune --tags`，回读 npm latest、所有已发布版本、远端 release tag 和 `origin/master` manifest。E404 仅在输出明确表示包或版本不存在时解释为未发布；认证、权限、网络、限流错误必须停止。
3. 验证上一 npm 版本、对应远端 tag 和 manifest 历史一致；计算 candidate。不得跳过更高 npm 版本或 tag。
4. 从精确 `origin/master` 创建未占用的 `release/lark-pi-bridge-v<candidate>` 分支。远端分支或 open PR 已存在时先回读，不能覆盖。
5. 更新 `apps/lark-pi-bridge/package.json`、README Changelog 和必要的 `pnpm-lock.yaml`。只允许这三条路径变化。
6. 执行：

   ```bash
   pnpm --filter @mlzwl/lark-pi-bridge verify
   pnpm --filter @mlzwl/lark-pi-bridge smoke:local
   pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
   pnpm verify
   ```

7. 按 `.agents/skills/create-pr/SKILL.md` 的验证、commit、普通 push 和 PR 规则交付版本 PR；上游授权来自本次完整发布请求。create-pr 不负责合并或发布。
8. 回读 PR 的 base/head SHA、文件列表、checks、mergeability 和 merge state。必须满足：base=`master`、head 为刚 push 的 SHA、路径严格等于允许列表、非 draft、没有失败或进行中的 required checks、GitHub 允许 merge。
9. 执行并回读：

   ```bash
   gh pr merge <url> --repo chenerzhang/mlzwl --merge
   gh pr view <url> --repo chenerzhang/mlzwl \
     --json state,mergedAt,mergeCommit,headRefOid,baseRefName
   ```

   不用 `--admin`，不删除远端分支。结果不明确时只回读，不能重复提交替代 PR。

10. `git fetch origin --prune --tags`，切换本地 `master` 并只做 `git merge --ff-only origin/master`。若本地 master 不能 fast-forward，停止；不 reset、不 rebase。确认版本 PR 的 merge commit 是 `origin/master` 祖先，manifest/Changelog/candidate 一致。
11. 再执行完整验证和 `pnpm npm:publish:preflight`。然后执行真实发布：

    ```bash
    pnpm npm:publish:local
    ```

12. registry 确认成功后才创建 annotated tag。先回读远端 tag；不存在时执行：

    ```bash
    git tag -a "lark-pi-bridge-v<version>" \
      -m "Release lark-pi-bridge-v<version>" <published-master-sha>
    git push origin "lark-pi-bridge-v<version>"
    ```

    tag 已存在且 peeled commit 匹配时复用；类型错误或指向错误时停止，不删除、不覆盖。

13. 从 README 精确版本 Changelog 生成 `.tmp/npm-release/<version>/notes.md`。不存在时创建 GitHub Release；已存在时必须核验 tag、title 和 notes 一致：

    ```bash
    gh release create "lark-pi-bridge-v<version>" \
      --repo chenerzhang/mlzwl \
      --title "lark-pi-bridge v<version>" \
      --notes-file ".tmp/npm-release/<version>/notes.md" \
      --verify-tag
    ```

14. 最终回读 npm 精确版本、latest、integrity、shasum、远端 annotated tag 和 GitHub Release URL，报告最终 Git 状态。

## 仅发布与首次发布

不修改版本文件、不创建版本 PR。其余要求不降低：

- 当前 `master`、工作区、远端 SHA 符合发布入口要求；
- manifest 是目标版本，README 有且仅有一个对应 Changelog 条目，没有非空 `Unreleased`；
- 精确 npm 版本不存在；若已存在则不得再次 publish，只能在另行核验既有发布证据后补 tag 或 GitHub Release；
- release tag 与 GitHub Release 不得与目标 SHA/版本冲突；
- 本地 token 认证、完整验证、preflight 均通过。

随后按常规流程第 11–14 步执行。

## 失败与恢复

- 版本 PR 创建或合入失败：不发布。
- GitHub 分支保护不允许 merge：停止，不用管理员绕过。
- `.env` 缺失、权限过宽、token 无效、账号不是 `mlzwl`：停止；不得输出 token。
- publish 返回超时、失败或结果不明确：脚本先轮询 registry；目标版本完整可见则继续，仍不可见则停止。**不得立即重复 publish。**
- registry 已存在同版本但 integrity/shasum 不同：停止，不能覆盖。
- npm 成功而 tag push 失败：不得重新 publish；核验精确版本后只补 tag。
- tag 成功而 GitHub Release 失败：不得重新 publish 或重建 tag；只补 GitHub Release。
- 远端 tag 存在但不是 annotated tag或指向错误 SHA：停止，不删除、不覆盖、不 force push。
