---
name: npm-release
description: 为 mlzwl monorepo 的一个或多个注册 npm 子包准备 initial、only-publish、patch、minor 或 major 版本 PR；PR 合并后由 GitHub Actions Trusted Publishing 自动发布、补 tag 和 GitHub Release。
argument-hint: '<initial|only-publish|patch|minor|major> [package-id ...]'
---

# mlzwl npm Trusted Publishing 发版

本 skill 只准备并创建版本 PR；PR 合并后的 npm publish、annotated tag 和 GitHub Release 由 [npm-publish.yml](../../../.github/workflows/npm-publish.yml) 自动完成。正常流程不要求用户提供版本、SHA、Workflow 输入、npm token 或人工 Environment 审批，也不得自动合并 PR。发布 job 绑定 `npm-release` GitHub Environment；该 Environment 不设置 required reviewers。

## 唯一配置源

先读取 [`.release/npm-packages.json`](../../../.release/npm-packages.json)。其中按 `order` 注册每个包的：

- `id`、npm `name`、目录和 manifest；
- README/Changelog、tag 前缀、Release title；
- 包级 verify、smoke、pack 命令；
- 固定公共 registry、npm CLI 版本、默认分支、GitHub Environment、可信 Workflow 路径和仓库验证命令。

每包发布意图写入 `.release/npm/<id>.json`：

```json
{
  "schemaVersion": 1,
  "package": "<id>",
  "version": "<stable-semver>",
  "intent": "initial|only-publish|patch|minor|major"
}
```

marker 是专用发布开关。基线不为已经发布的版本补 marker；只有下一次真实发版请求才创建或更新。新增包只需注册配置，不复制 Workflow。

## 请求与授权

1. 用户选择模式和一个或多个包 id；只有一个注册包时可省略 id。模式或多包选择不明确时先询问。
2. `draft` 只分析版本差异或起草 Changelog，不改文件、不创建 PR。
3. `initial`、`only-publish`、`patch`、`minor`、`major` 都授权准备版本分支，并按 `create-pr` skill 创建带 `npm-release` 标签的 PR；不授权自动合入、force push、tag、手动发布或触发 Workflow。
4. 真实发布授权在 PR 合并后由仓库 Workflow 使用 npm OIDC 执行；代理不得在本机运行 `npm publish`、`npm whoami`，不得索取 npm token/OTP。
5. 同一请求可选择多个包；全部写入同一个版本 PR，Workflow 合并后严格按注册表 `order` 串行处理。

## 计算目标版本

开始前要求工作区干净，fetch `origin/master` 和 tags，并从公共 registry 回读每个包的完整版本集合及 `latest`。E404 只在响应明确表示包或版本不存在时解释为未发布；认证、网络、限流或数据不完整必须停止。

- `initial`：除 npm Trusted Publishing 首次 staged review 可能公开的 `0.0.0-stage` 占位外，registry 中不得已有该包版本；使用 `origin/master` manifest 的当前 stable semver，不隐式 bump。计算首次发布基线时忽略该占位，但真实发布恢复时若目标版本尚不可见且只看到占位，必须停止等待，绝不重复 publish。
- `only-publish`：使用 `origin/master` manifest 的当前 stable semver；该精确版本不得已发布，且必须高于所有已发布版本。
- `patch`：从 npm `latest` 精确计算 `x.y.(z+1)`。
- `minor`：从 npm `latest` 精确计算 `x.(y+1).0`。
- `major`：从 npm `latest` 精确计算 `(x+1).0.0`。

patch/minor/major 要求包已有稳定 `latest`。任何更高已发布版本、目标版本已存在、manifest 基线与 npm/tag 证据冲突都必须停止，不能跳号或覆盖。

## Changelog 证据

对每个包，从上一个可信发布 tag（initial 时从包的可审计起点）到 `origin/master` 比较 tree、stat 和 commit；tag 不是 master 祖先时不得只依赖 log。还要检查会影响包行为的根配置和 lockfile。临时材料只放 `.tmp/npm-release/`。

Changelog 只能来自源码、测试和公开文档证据，只写用户、集成方或运维可感知变化，分类使用 `Added`、`Changed`、`Fixed`、`Security`、`Deprecated`、`Removed`，不创建空分类。

README 发布区间必须使用 `<!-- npm-release:start -->` / `<!-- npm-release:end -->`。把 `Unreleased` 的本批内容归入且仅归入一个目标版本标题：

```md
### [<version>] - <YYYY-MM-DD>
```

同版本条目已经存在但内容不同则停止，不覆盖人工内容。`only-publish` 或 `initial` 已有完全一致的版本条目时保留；没有时仍须根据证据补齐。

## 准备一个或多个包的版本 PR

1. 从精确 `origin/master` 创建专用发布分支（建议 `release/npm`）；已有同名远端分支或 PR 时先回读，禁止覆盖或 force push。
2. 对每个选中包更新：
   - manifest 的精确版本（若目标与当前不同）；
   - README 中目标版本 Changelog；
   - `.release/npm/<id>.json` 的目标版本和意图。
3. 执行 `pnpm install --lockfile-only`，只在确有版本记录变化时保留 `pnpm-lock.yaml`。
4. 允许路径严格限定为本批包的 manifest、Changelog、marker，以及共享 `pnpm-lock.yaml`；不得夹带源码、测试、普通文档、依赖升级或根 `package.json`。
5. 按注册表顺序执行每包全部 verify/smoke/pack 命令，再执行仓库验证命令、`node --test scripts/npm-release.test.mjs`、`node scripts/npm-release.mjs validate-config` 和 `git diff --check`。这些命令不得访问真实 provider、飞书或 npm publish。
6. 向 `create-pr` skill 移交：source、target=`master`、上述精确允许路径、排他干净要求、最终 head SHA/title/body 回读断言。create-pr 只 commit、普通 push、创建/复用 PR，不发布、不 tag、不合入。
7. PR 创建后确保仓库存在 `npm-release` label，并把**该唯一标签**加到版本 PR；随后回读 PR 的 base、head SHA、文件列表和标签。label 创建/添加结果不明确时停止，不声称 PR 已可发布。
8. 明确报告“版本 PR 已准备，等待人工审核并合入”。不得启用 auto-merge 或自行合并。

## 合并后的自动流程

`npm-publish.yml` 只在 `master` 的 `.release/npm/*.json` 发生变化时自动触发；普通源码、文档、依赖或仅 package.json PR 不触发。Workflow：

1. 使用 GitHub-hosted runner、固定 SHA 的官方 Actions、npm 11.6.1、`id-token: write`、`npm-release` Environment 和无 npm token的 OIDC；该 Environment 不设置 required reviewers；
2. 无 OIDC 的预检 job 负责 checkout、安装、校验、构建和 pack，并将只含发布 tarball、release plan 和 registry 副本的 artifact 传给发布 job；发布 job 才拥有 OIDC 与 GitHub 写权限，不执行 pnpm/npm 安装或仓库脚本，也不信任预检 job 提供的可执行文件。它从冻结 `GITHUB_SHA` 经 GitHub API重新获取状态机和 registry，以 Workflow 内固定 SHA-256 校验；npm CLI 和 Node 运行时则从官方源重新下载并按 Workflow 内固定 digest 校验。状态机启动后立即把 OIDC 和 GitHub token 移出全局进程环境：GitHub API helper 只使用内存中的 token，只有最终 `npm publish --provenance` 子进程重新获得 OIDC 且不获得 `GITHUB_TOKEN`；
3. push 以事件 `after`、dispatch 以 `GITHUB_SHA` 冻结不可变 snapshot；marker 选择、历史、PR 关联、祖先检查和 checkout 都只相对该 snapshot，排队期间 master 后移不能改变发布目标；无输入 dispatch 从 snapshot 扫描全部 marker；若旧 marker 对应版本仍未发布且其发布 commit 不等于本次 `GITHUB_SHA`，则在 publish 前失败关闭，不允许生成绑定错误 commit 的 provenance；
4. 由 marker 关联 commit 查找已合并 PR，兼容 merge commit 和 rebase merge；要求目标为 master、带 `npm-release` 标签，并拒绝 renamed 文件。从该 PR 文件提取全部注册 marker 来构造整批 allowlist，但只实际处理当前 snapshot 选中的 marker；旧批次中已发布但未完成 tag/Release 的包仍可恢复，master 前移后尚未 publish 的旧 marker 必须人工调查，不能从新 snapshot 重发；
5. fail-closed 校验 snapshot 祖先、registry/publishConfig、marker/manifest、唯一 Changelog、完整 SemVer/`latest`、staged placeholder、现有 tag/Release 冲突；
6. 执行包级和仓库级验证，以 `npm publish --provenance` 串行发布；
7. 回读精确 npm 版本、`latest`、integrity、`gitHead`，先通过 Sigstore 可信根验证 DSSE 签名、Fulcio GitHub Actions issuer/workflow identity、CT/Rekor 证据，再解析 SLSA provenance payload 并核对 sha512 subject、GitHub repository/workflow path、resolved commit 和 GitHub-hosted builder；成功后创建指向该 PR 实际发布 commit 的 annotated tag 和 GitHub Release，notes 从该包 README 的同版本 Changelog 提取。

安全重跑规则：未发布才 publish；npm 已正确发布时只补缺失 tag/Release；正确 tag/Release跳过；版本、integrity、gitHead、attestation、tag 目标、Release title/notes 任一冲突立即停止，绝不覆盖 tag 或盲目重复 publish。多批遗留 marker 在 dispatch 中仍按配置顺序处理。

## 故障恢复

只有自动 run 因临时网络、npm 可见性延迟、tag 或 Release API 故障而中断时，维护者才从 GitHub UI 对 `npm trusted publishing` 执行无输入 `workflow_dispatch`。不填写 version/SHA，不切换目标 commit。恢复入口冻结其 `GITHUB_SHA` 并扫描该 snapshot 的 marker，但只对缺失交付步骤采取动作；若首次发布只看到 `0.0.0-stage` 而目标尚不可见，继续等待目标版本出现后再 dispatch，不能重发。若 master 已前移，dispatch 只能补已发布版本的 tag/Release；旧 marker 尚未发布时会失败关闭，必须人工调查。其他冲突也不能通过删 tag、改版本或盲目重跑 publish 绕过。

## 一次性 npm Trusted Publisher 配置

每个 npm 包在 npmjs.com 的 **Settings → Trusted Publisher** 配置一次：

| 字段                 | 值                |
| -------------------- | ----------------- |
| Provider             | GitHub Actions    |
| Organization or user | `chenerzhang`     |
| Repository           | `mlzwl`           |
| Workflow filename    | `npm-publish.yml` |
| Environment          | `npm-release`     |

同时在 GitHub 仓库创建名为 `npm-release` 的 Environment，**不要配置 required reviewers**，因此正常流程没有人工 Environment 审批。保存 npm Trusted Publisher 后，在 npm 显示的 2 天验证窗口内合并该包的首个 marker 版本 PR，让 Workflow 完成第一次 OIDC 发布并回读 provenance；首次 staged review 期间 npm 可能只公开 `0.0.0-stage`，此时等待目标版本可见后再恢复，绝不重新 publish。过期则在 npm 重新创建 Trusted Publisher 配置。每个新增包都需独立完成这一次设置。不要配置 npm token secret。

## 最终报告

报告所选包及顺序、每包 npm 基线/目标版本/意图、Changelog 证据、变更文件、验证命令、PR URL/标签/head SHA，并再次说明等待人工合入。PR 合并后只报告 Workflow run、npm 精确版本与 provenance、annotated tag 和 GitHub Release 的回读证据；没有回读证据不得声称发布成功。
