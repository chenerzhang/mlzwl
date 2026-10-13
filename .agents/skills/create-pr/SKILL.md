---
name: create-pr
description: 提交当前任务改动、普通 push 并创建或复用 GitHub Pull Request。仅当用户明确要求完成这组交付动作、显式点名 create-pr skill，或由已获得同等授权的仓库工作流移交时使用；负责校验改动范围、执行项目验证、生成 Conventional Commit，并确保 PR title、body 与最终远端 commit/diff 一致。不得执行发布、版本 bump、tag、自动合入或 force push。
argument-hint: '[-t <target-branch>] [--title <pr-title>] [--draft]'
---

# 提交、推送并创建 GitHub PR

把当前任务已经完成的本地改动整理为 commit，普通 push 到 `origin`，再通过 GitHub CLI 创建 Pull Request。PR 标题、body 和验证结论必须来自最终已推送的 commit 范围，不能根据对话臆造。

## 授权与边界

用户显式调用本 skill，或已获得同等授权的仓库工作流移交，只授权本次流程中的：

- 暂存当前任务范围内、已经确认归属的文件；
- 创建一个普通 Git commit；
- 将当前分支普通 push 到 `origin`；
- 为当前分支创建一个 GitHub PR。

授权不包括：

- force push、rebase、reset、amend、cherry-pick；
- 创建或切换分支、删除远端分支、合入 PR、进入 merge queue；
- 创建 tag、发布 npm 或写发布记录；
- 覆盖已有 PR 的人工 title/body；
- 使用 `--no-verify` 绕过 hook。

需要这些动作时停止并单独取得明确授权。上游工作流移交时必须给出 source、target、允许提交的精确路径、工作区是否必须排他干净，以及 PR 回读断言；缺少关键信息就停止。

本 skill 只交付已有实现，不借创建 PR 顺手修改业务代码。若发现行为变化缺少项目要求的文档或测试，停止并报告缺口。

## 输入

- `target-branch`：可选，默认读取 `origin/HEAD`，解析失败时使用 `master`；
- `pr-title`：可选，仍需确认与最终 commit 范围一致；
- `--draft`：可选，创建 Draft PR。

不自动添加 reviewer、assignee、label、milestone 或 Project。

## Commit 与 PR 约定

Commit subject 使用英文 Conventional Commit：

```text
<type>(<scope>): <summary>
```

优先使用 `feat`、`fix`、`refactor`、`test`、`docs`、`build`、`chore`。正文说明 `Why`、`What` 和 `Validation`。不要把多 commit 分支强行 amend/squash。

PR body 必须使用 [`assets/description-template.md`](assets/description-template.md) 的 `Summary`、`Changes`、`Impact` 结构，并覆盖 `origin/<target>..HEAD` 的全部 commit 和最终 diff。不要声称未执行的测试通过。

## 工作流

### 1. 仓库、GitHub 身份与基线

执行并记录：

```bash
git rev-parse --show-toplevel
git branch --show-current
git remote get-url origin
git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true
git status --short --branch
gh auth status
```

必须满足：

- 当前目录是有效 Git checkout，且已读取适用的仓库规则；
- `origin` 是 GitHub SSH 或 HTTPS URL，并解析出 `<owner>/<repo>`；
- GitHub CLI 已登录到有权访问该仓库的账号；
- 当前处于普通分支且不是目标分支。

用户指定 target 时使用其值，否则读取 `origin/HEAD`，空值回退 `master`。随后：

```bash
git fetch origin --prune
git ls-remote --exit-code --heads origin "<TARGET_BRANCH>"
```

失败时停止，不猜测成功。

### 2. 远端分支与 PR 防重复

检查同名远端分支；存在时确认没有远端独有 commit：

```bash
git ls-remote --exit-code --heads origin "<CURRENT_BRANCH>"
git rev-list --left-right --count "origin/<CURRENT_BRANCH>...HEAD"
```

输出为 `remote_only local_only`。`remote_only > 0` 时停止，不自动同步或 force push。

查询 open PR：

```bash
gh pr list --repo "<OWNER>/<REPO>" \
  --state open --head "<OWNER>:<CURRENT_BRANCH>" --base "<TARGET_BRANCH>" \
  --limit 20 --json number,title,url,headRefName,baseRefName
```

- 0 个：继续，稍后创建；
- 1 个：记录并复用，不覆盖人工 title/body；
- 多个：停止并列出结果。

### 3. 确认本地改动范围

收集状态、diff 和已有 commit：

```bash
git status --porcelain=v1
git diff --name-status
git diff --stat
git diff --cached --name-status
git diff --cached --stat
git log --reverse --format='%H%x09%s' "origin/<TARGET_BRANCH>..HEAD"
```

读取实际 diff；untracked 文件需逐个检查。规则：

1. 只暂存明确属于当前任务的文件；
2. 出现疑似他人改动或不相关主题时先询问；
3. 不使用 `git add -A`、`git add .` 或仓库级通配，使用精确路径；
4. 不暂存 `.tmp/`、`dist/`、`node_modules/`、日志、凭据或候选 tarball；
5. 不用 restore/reset/clean/stash 处理无关改动；
6. 无工作区改动但已有相对 target 的本地 commit 时继续；两者都没有则结束。

暂存后复核：

```bash
git diff --cached --check
git diff --cached --name-status
git diff --cached --stat
git status --short
```

上游要求排他工作区时，不允许任何未暂存改动，且 staged 路径必须与允许路径精确一致。

### 4. 项目约束与验证

读取适用于变更路径的规则和 package scripts。检查文档/测试要求、模块与安全边界，防止包含凭据、构建产物和临时文件。

根据最终交付范围执行项目规定的最小完整验证集。不得因创建 PR 自动运行真实平台、真实 provider、service 安装或其他有副作用 smoke。验证失败则停止，不 commit、不 push、不创建 PR。记录真实命令和结果；验证改写文件后重新检查状态。

### 5. 创建 commit

存在 staged 变更时，将 commit message 写入：

```text
.tmp/create-pr/<timestamp>/commit-message.txt
```

格式：

```text
<type>(<scope>): <summary>

Why:
- <动机>

What:
- <关键改动>

Validation:
- <实际通过的命令>
```

执行：

```bash
git commit -F ".tmp/create-pr/<timestamp>/commit-message.txt"
```

禁止 `--no-verify`。失败时停止，不 amend。随后回读 status 和 `git show --stat`。

### 6. 普通 push

再次检查远端分支，确保没有新增远端独有 commit：

- 远端不存在：`git push --set-upstream origin "<CURRENT_BRANCH>"`
- 远端存在且仅本地领先：`git push origin "<CURRENT_BRANCH>"`
- 已一致：不重复 push。

push 被拒绝时停止，不能改用 force。push 后必须验证：

```bash
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git ls-remote origin "refs/heads/<CURRENT_BRANCH>" | awk '{print $1}')"
test "$LOCAL_SHA" = "$REMOTE_SHA"
```

### 7. 生成并创建/复用 PR

只使用最终远端一致的范围：

```bash
git log --reverse --format='%H%x09%s%n%b' "origin/<TARGET_BRANCH>..HEAD"
git diff --name-status "origin/<TARGET_BRANCH>...HEAD"
git diff --stat "origin/<TARGET_BRANCH>...HEAD"
git diff "origin/<TARGET_BRANCH>...HEAD"
```

三点 diff 为空则停止。单 commit 时 title 优先使用 subject；多 commit 时生成覆盖整体的 Conventional Commit 标题。将 body 写到：

```text
.tmp/create-pr/<timestamp>/body.md
```

若已有唯一 open PR，不创建也不覆盖，只回读 source、target、head SHA；发现明显 body 差异时报告并询问。

若没有 PR，创建前再次查询防并发重复，然后执行：

```bash
gh pr create --repo "<OWNER>/<REPO>" \
  --head "<CURRENT_BRANCH>" --base "<TARGET_BRANCH>" \
  --title "<PR_TITLE>" \
  --body-file ".tmp/create-pr/<timestamp>/body.md"
```

Draft 时加 `--draft`。命令超时或结果未知时先查询，禁止盲目重试。成功后：

```bash
gh pr view "<PR_URL>" --repo "<OWNER>/<REPO>" \
  --json number,title,body,url,state,isDraft,headRefName,baseRefName,headRefOid
```

确认 source、target、远端 SHA、title、body 和 draft 状态符合本次交付。不自动设置 merge method、auto-merge 或合入。

### 8. 最终输出

报告：

- 新建 commit SHA 与 subject，或复用的 commit 范围；
- push 分支与远端 SHA；
- 实际验证命令及结果；
- PR title、完整 body 与 URL；
- 未纳入 commit 的本地改动；
- 最终 `git status --short --branch`。

没有命令与回读证据时，不得声称 commit、push、PR 或测试成功。
