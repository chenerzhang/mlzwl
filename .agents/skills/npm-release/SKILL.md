---
name: npm-release
description: 管理 mlzwl monorepo 的公共 npm 子包 Changelog、首次发布、仅发布及 patch/minor/major 发版。用户要求分析发版差异、发布 lark-pi-bridge、升级版本或生成 GitHub Release 时使用。
---

# mlzwl npm 发布

当前支持：

| 包名                    | 包目录                | tag                         |
| ----------------------- | --------------------- | --------------------------- |
| `@mlzwl/lark-pi-bridge` | `apps/lark-pi-bridge` | `lark-pi-bridge-v<version>` |

公共 registry 固定为 `https://registry.npmjs.org`，默认分支为 `master`，托管平台为 GitHub。

## 请求分流与授权

| 用户意图                        | 模式           | 允许动作                                               |
| ------------------------------- | -------------- | ------------------------------------------------------ |
| 询问差异、流程或 Changelog 草稿 | `draft`        | 只读                                                   |
| 明确说“仅发布”或“发布当前版本”  | `only-publish` | 校验并发布当前 manifest；不改文件、不创建 PR           |
| 明确要求 patch/minor/major      | `release`      | 准备版本 PR；合入确认后发布 npm、tag 和 GitHub Release |
| 明确说“首次发布”                | `initial`      | 校验并发布当前 manifest；不隐式 bump                   |

真实发布请求授权对应模式内明确列出的 npm publish、package tag push 与 GitHub Release；常规 release 还授权版本准备并向 `create-pr` 移交。但它**不授权自动合入 PR、force push、覆盖 tag、绕过 2FA 或在分支保护外直推 master**。包名、bump 或发布意图不明确时先询问。

## 共同边界

- 开始真实发布前必须确认 `npm whoami --registry=https://registry.npmjs.org` 成功，且身份有权发布目标 scope；未登录或需要浏览器/OTP 时由用户本人完成，不能收集 token/OTP。
- 真实发布入口要求工作区干净；不 stash、reset、restore、clean，也不混入既有改动。
- 普通源码、测试和非 Changelog 文档应先通过正常 PR 进入 `master`；版本 PR 只包含目标包 `package.json`、README 和因 lockfile 版本记录产生的 `pnpm-lock.yaml`（若实际发生）。
- Changelog 只能来自源码、测试和公开文档证据，只写用户、集成方或运维可感知的变化。使用 `Added`、`Changed`、`Fixed`、`Security`、`Deprecated`、`Removed`，不创建空分类。
- npm 版本不可覆盖；registry 查询、publish 或 tag 结果不明确时先回读，不盲目重试。
- release tag 必须是 annotated tag `lark-pi-bridge-v<version>`，并指向 `master` 上包含该精确版本的 commit。
- GitHub Release 从同一个 tag 创建；title 使用 `lark-pi-bridge v<version>`，notes 与 README 同版本 Changelog 语义一致。
- 多包发布必须串行；当前仅有一个可发布包。

## Changelog 证据

确定上一个已发布 tag 与候选 `master` SHA 后，至少检查：

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

1. 确认工作区干净，`git fetch origin --prune --tags`，确认 `origin/master` 存在且本地分支没有未推送的非发布改动。
2. 回读 npm：

   ```bash
   npm view @mlzwl/lark-pi-bridge version --registry=https://registry.npmjs.org --json
   npm view @mlzwl/lark-pi-bridge@<candidate> version --registry=https://registry.npmjs.org --json
   ```

   首次发布时应转 `initial`，不能假装已有基线。E404 仅在输出明确表示包/版本不存在时解释为未发布；认证、权限、网络和限流错误必须停止。

3. 验证上一 npm 版本、对应远端 tag 和 `origin/master` 中 manifest 一致；计算 stable semver candidate。不得跳过更高 npm 版本或远端 tag。
4. 从 `origin/master` 的精确 SHA 创建 `release/npm`。创建/切换分支本身是 Git 状态变更，只有用户的明确 release 请求授权该工作流时才允许；若远端已有 `release/npm`，停止并检查现有 PR，不覆盖。
5. 使用 `pnpm --filter @mlzwl/lark-pi-bridge exec npm version <candidate> --no-git-tag-version` 或精确编辑 package manifest，并运行 `pnpm install --lockfile-only` 使 lockfile 保持一致。只允许预期的 package.json/README/lockfile 变化。
6. 写入审核后的 README Changelog，执行：

   ```bash
   pnpm --filter @mlzwl/lark-pi-bridge verify
   pnpm --filter @mlzwl/lark-pi-bridge smoke:local
   pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
   pnpm verify
   ```

7. 调用 `.agents/skills/create-pr/SKILL.md`，移交：source=`release/npm`、target=`master`、精确允许路径、排他干净要求，以及 source/target/head SHA/title/body 回读断言。create-pr 只负责验证、commit、普通 push 和 PR；不发布、不 tag、不合入。
8. **常规发版必须等待 PR 合入 master。** 回读：

   ```bash
   gh pr view <url> --json state,mergedAt,mergeCommit,headRefOid,baseRefName
   git fetch origin --prune --tags
   ```

   未合入时停止并报告“版本 PR 已准备，等待合入”，不能从未合入 PR 分支发布。

9. PR 合入后，从干净的 `master` checkout（或指向精确 `origin/master` 的干净 detached checkout）确认 manifest/changelog/candidate 一致、发布 commit 已在 `origin/master`，再重复 package verify 和 pack dry-run。
10. 执行：

```bash
pnpm --filter @mlzwl/lark-pi-bridge publish --access public \
  --registry=https://registry.npmjs.org --no-git-checks
```

scoped 包必须显式 `--access public`。如果 npm 要求 OTP 或浏览器认证，暂停让用户本人完成。11. 回读精确 npm 版本和 dist-tag；成功后创建 annotated tag 并普通 push：

```bash
git tag -a "lark-pi-bridge-v<version>" -m "Release lark-pi-bridge-v<version>" <published-master-sha>
git push origin "lark-pi-bridge-v<version>"
```

12. 使用 Changelog 生成 `.tmp/npm-release/<version>/notes.md`，创建 GitHub Release：

```bash
gh release create "lark-pi-bridge-v<version>" \
  --repo chenerzhang/mlzwl \
  --title "lark-pi-bridge v<version>" \
  --notes-file ".tmp/npm-release/<version>/notes.md" \
  --verify-tag
```

随后用 `gh release view` 回读 tag、title、URL 和 notes。

## 仅发布与首次发布

这两种模式不修改文件、不创建 PR、不隐式 bump。要求：

- 工作区干净；
- 当前 HEAD 已普通 push，并且是 `origin/master` 的精确 SHA；
- manifest 是目标版本，README 有且仅有一个对应 Changelog 条目，且没有遗留的非空 `Unreleased` 章节；
- 精确 npm 版本和远端 tag 不存在；首次发布还要求没有其他同包版本/tag；
- `npm whoami` 成功；
- package verify、smoke、pack dry-run 和 root verify 通过。

然后按常规流程第 10–12 步发布、tag、创建 GitHub Release。

如果 npm publish 返回未知结果：

1. 不立即重试；
2. 查询 `npm view <name>@<version> version`；
3. 已存在：只在 SHA/manifest 证据完整时补 tag 与 GitHub Release；
4. 不存在：保留证据并让用户明确授权重试；
5. 认证/网络导致无法判断时停止。

`pack:dry-run` 只做构建和包内容审计，不查询或写 npm/GitHub。

## 失败处理

- create-pr 或 PR 回读失败：不发布。
- PR 未合入：不发布。
- npm 身份、scope 权限或 2FA 未就绪：停止并让用户处理，不索取 secret。
- npm 已发布但 tag push 失败：不得重新 publish；核验 npm 精确版本与 master SHA 后只补 tag。
- tag 成功但 GitHub Release 失败：不得重新 publish 或重建 tag；只重试 GitHub Release。
- 远端 tag 已存在但指向错误 SHA：停止，不删除、不覆盖、不 force push。
