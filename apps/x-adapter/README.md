# @mlzwl/x-adapter

`@mlzwl/x-adapter` 是面向 Trae 与豆包工作的本地模型网关，提供 OpenAI-compatible、Anthropic Messages 和 Pi 接入。

> Trae Global/CN 接入目前为实验性能力：可从本机已登录的官方客户端只读导入 token 与绑定设备身份；独立 Global 浏览器 OAuth 复用已导入的设备身份后已可成功登录（设备数量上限 `20401` 不再触发）。Global SG/CN 模型目录与 Chat Completions 链路已使用导入凭据真实验证；Global DeviceProof refresh 也已在官方客户端完全退出后完成一次受控 E2E。Global 的 SOLO 模型（`trae-global-gpt-5.2` 等）走 `solo_work_lite` 池：需要一次性的 SOLO 身份 OAuth 授权（client `en1oxy7wnw8j9n`，token 存于 `~/.x-adapter/trae/global/solo-token.json` 并自动刷新），工具调用为提示词模拟（实测被上游模型精确遵从，含多轮工具结果回传），与原生 function calling 相比格式遵从度略低。每次 SOLO 调用消耗真实额度（单次约 1.7 万 prompt token 的系统开销），且高频使用会触发账号级限流（3004）。当前 `llm_utils_chat` 上游会忽略请求级 `max_tokens`；网关会按请求输出事件数与默认 1 MiB 输出字节上限主动取消，并分别投影为 Chat Completions `finish_reason=length`、Responses `status=incomplete`、Anthropic `stop_reason=max_tokens`，但这不是精确 token 计数。Trae 使用未公开接口，可能受服务条款、风控、额度限制或接口变更影响；请仅使用你有权访问的账号与额度。

## 安装

要求 Node.js `>=20`。

```bash
npm install -g @mlzwl/x-adapter
```

## 登录

Trae 对外仍是一个 provider，但 Global 与 CN 是相互隔离的账号 realm，必须显式选择：

```bash
# 推荐：复用本机官方客户端当前登录与其绑定设备身份
x-adapter trae import --realm global
x-adapter trae import --realm cn

# 可选：创建独立 OAuth 登录（复用已导入设备身份，不新增设备名额）
x-adapter trae login --realm global
x-adapter trae login --realm cn
x-adapter doubao login
# 可选：创建或复用实验性的个人 Connector，启用豆包客户端工具桥接
x-adapter doubao login --create-bridge

# SOLO 模型（trae-global-gpt-5.2 等）额外需要一次 SOLO 身份授权：
# 先完成上面任一 Global 登录（SOLO 登录复用其设备身份），再执行
x-adapter trae login --realm global --solo
```

Trae 凭据分别保存在 `~/.x-adapter/trae/global/auth.json` 和 `~/.x-adapter/trae/cn/auth.json`；不要复制、共享或提交这些文件。`trae import` 会只读解密官方客户端 `storage.json` 并复制 access/refresh token、machine/device ID 与 P-256 私钥，不会写回官方存储；两端共享同一 token family 和设备身份，任一端刷新或退出都可能影响另一端。认证方式及风险说明见 [`docs/operations.md`](docs/operations.md)。

## 启动与停止

```bash
x-adapter start
x-adapter status
```

服务默认地址为：

```text
http://127.0.0.1:10100/v1
```

停止服务：

```bash
x-adapter stop
```

## 选择模型

```bash
x-adapter models
x-adapter models --all
x-adapter models refresh
```

模型 ID 必须带 provider 和 realm 前缀，例如：

```text
trae-global-<upstream-id>
trae-cn-<upstream-id>
doubao-work-auto
```

Trae 上游若明确提供 Standard 与 Max 两个后端，网关会保留现有 Standard ID，并新增带 `-max` 后缀的 Max ID。例如 `trae-global-deepseek-v4.1-flash` 使用 200K Standard 后端，`trae-global-deepseek-v4.1-flash-max` 使用 1M Max 后端。Max 是独立后端和上下文规格，不是推理强度 `max`。

Global、CN 与豆包工作之间不会自动 fallback。默认模型为 `doubao-work-auto`，可通过 `X_ADAPTER_DEFAULT_MODEL` 修改。模型发现会同时声明每个模型的文本/图片输入能力；能力来自 Trae 目录元数据与少量实测覆盖，未声明能力的模型按纯文本处理。

豆包工作支持实验性的客户端工具桥接。该桥接依赖豆包工作的私有个人 Connector、`runtime_type: 2` 和 `/alice/office/tool_local/*` 接口，不是公开或受支持的 API。首次使用前，用户必须显式执行 `x-adapter doubao login --create-bridge` 并确认创建 `X Adapter Bridge`；普通请求不会静默创建连接器。工具轮次必须使用稳定的 `x-session-id`、Responses `previous_response_id` 或等价显式会话标识，且活动轮次只在当前 daemon 进程内存中保存。当前桥接只支持串行客户端工具调用。

## 发送请求

Chat Completions 示例：

```bash
curl -sS http://127.0.0.1:10100/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model":"doubao-work-auto",
    "messages":[{"role":"user","content":"只回复 PONG"}]
  }'
```

Trae Responses 示例（将占位符替换为 `x-adapter models` 返回的真实 ID）：

```bash
curl -sS http://127.0.0.1:10100/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"trae-global-<upstream-id>","input":"只回复 PONG"}'
```

完整 CLI 与 HTTP API 用法见 [`docs/operations.md`](docs/operations.md)。

## 接入 Pi

本包同时提供 Pi extension。先按上文安装 `@mlzwl/x-adapter`、完成所需 realm 登录或导入，再安装 Pi package：

```bash
pi install npm:@mlzwl/x-adapter
pi
```

进入 Pi 后运行 `/model`，选择 provider `x-adapter` 下的模型：

```text
x-adapter/trae-global-<upstream-id>
x-adapter/trae-cn-<upstream-id>
x-adapter/doubao-work-auto
```

也可以直接指定模型启动；其中 `<upstream-id>` 必须替换为 `/model` 或 `x-adapter models` 返回的真实 ID：

```bash
pi --model x-adapter/trae-global-<upstream-id>
```

extension 默认连接 `http://127.0.0.1:10100/v1`，并按模型发现结果向 Pi 声明图片能力，避免 Pi 在图片模型上提前丢弃用户图片或工具返回的图片。本机网关未运行时会尝试执行 `x-adapter start`，但不会自动登录 provider 或读取官方客户端账号存储。Pi 内还可使用：

```text
/x-adapter status
/x-adapter models --all
/x-adapter version
```

若当前 Pi 会话已有工具调用历史，需要切换到豆包模型，请用 `/x-adapter-doubao [doubao-work-model-id]`。extension 会先让当前模型生成一份禁止调用工具的迁移摘要，确认 retain-none compaction 已持久化后才切换，默认目标为 `doubao-work-auto`。摘要、落盘、认证或切换任一步失败都会保持当前模型。原始 transcript 仍保留在 Pi session 文件中，只有后续活动模型上下文从摘要重新开始。

自定义地址、本机鉴权、关闭自动启动/安装及离线模式见 [`docs/pi-provider-setup.md`](docs/pi-provider-setup.md)。

## 接入 Magpie

Magpie 插件尚未发布时，先完成 x-adapter 发版，再发布插件。安装顺序如下：

```bash
npm i -g @mlzwl/x-adapter@latest   # 需要 >= 0.1.3
magpie plugin add @mlzwl/magpie-x-adapter
magpie plugin login x-adapter
```

该插件复用已运行的 x-adapter daemon、登录、模型可见性和额度。网关未运行时，插件可安全地执行一次 `x-adapter start`；该自动启动依赖 `x-adapter capabilities` 与 `start --no-orphan-recovery`，`0.1.2` 及更早版本会被拒绝。完整说明见 [`../magpie-x-adapter/README.md`](../magpie-x-adapter/README.md)。

## 接入 Claude Code 与 Codex

参见 [`docs/cc-codex-setup.md`](docs/cc-codex-setup.md)。

## 常用配置

配置、缓存、日志、运行时文件和凭据默认保存在 `~/.x-adapter/`。

| 变量                           | 用途                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `X_ADAPTER_PORT`               | 修改监听端口，默认为 `10100`。                         |
| `X_ADAPTER_DATA_DIR`           | 修改数据根目录，默认为 `~/.x-adapter`。                |
| `X_ADAPTER_DEFAULT_MODEL`      | 修改默认模型。                                         |
| `X_ADAPTER_CLIENT_TOKEN`       | 为本机客户端请求启用可选的 Bearer 鉴权。               |
| `X_ADAPTER_NO_ORPHAN_RECOVERY` | 启动时只报告现有 daemon lock 冲突，不终止 lock owner。 |

完整环境变量说明见 [`docs/operations.md`](docs/operations.md)。

## 安全提示

- 不要提交或输出 Trae token、Trae 官方客户端 `storage.json`、豆包 Cookie 或认证文件内容。
- `X_ADAPTER_CLIENT_TOKEN` 只保护本机 data-plane，不能替代 provider 登录。
- 豆包工作的客户端工具桥接是实验能力。它依赖豆包工作的私有个人 Connector、`runtime_type: 2` 和 `/tool_local/*` 接口，不是公开或受支持的 API。首次使用前，用户必须显式执行 `x-adapter doubao login --create-bridge` 并确认创建 `X Adapter Bridge`；普通请求不会静默创建连接器。工具声明、调用和结果上传仅在当前 daemon 进程内续接，且必须使用稳定的 `x-session-id`、Responses `previous_response_id` 或等价显式会话标识。当前桥接只支持串行客户端工具调用，不支持并行调用。升级豆包工作后，该私有协议可能失效。

## 更新

```bash
x-adapter update
```

## 更多文档

- [完整 CLI、HTTP API、后台服务与排障](docs/operations.md)
- [Pi 接入](docs/pi-provider-setup.md)
- [Claude Code 与 Codex 接入](docs/cc-codex-setup.md)
- [技术设计](docs/tech.md)
- [验证说明](docs/verification.md)

## Changelog

<!-- npm-release:start -->

### Unreleased

#### Added

- 新增供共享客户端使用的 `x-adapter capabilities` 与 `x-adapter start --no-orphan-recovery`。调用方可要求启动只报告 daemon lock 冲突，不终止仍在运行的 lock owner。`@mlzwl/magpie-x-adapter` 的自动启动依赖这两个能力，因此本版本必须先于该插件发布。
- 新增独立的 Magpie provider 插件 `@mlzwl/magpie-x-adapter` 接入说明。

### [0.1.0] - 2026-10-14

#### Added

- 提供仅支持 Trae 与豆包工作的本地模型网关，以及 OpenAI Chat Completions、Responses 和 Anthropic Messages 兼容接口。
- 在单一 `trae` provider 内提供相互隔离的 Global/CN realm、浏览器 OAuth、realm 独立凭据与模型目录，公开模型 ID 为 `trae-global-*` 和 `trae-cn-*`。
- 提供模型发现、精确 provider/realm 路由、Pi extension、Claude Code/Codex 接入，以及 macOS launchd 和 Linux systemd 用户服务管理。
- Trae Global SOLO 模型接入 `solo_work_lite` 工作池：提示词模拟的工具调用（`<toolcall>` 协议注入与流式解析、工具结果多轮回喂）、SOLO 身份 token 独立保存并自动刷新。
- Global 模型目录支持 `/models` 权威源与本机 Trae 客户端 preset 双源合并；OAuth 登录复用已导入设备身份，规避账号设备数量上限。
- 将配置、缓存、日志、运行时文件和 provider 凭据统一保存到 `~/.x-adapter`，并支持通过 `X_ADAPTER_*` 环境变量覆盖。

#### Security

- 默认仅监听 loopback，隔离 Trae Global、Trae CN 与豆包工作凭据，并对 OAuth callback、上游 host、本机 HTTP 请求、日志脱敏和 daemon 生命周期执行 fail-closed 校验。
- Trae 浏览器 OAuth 使用 PKCE S256、一次性 loopback callback、P-256 设备证明、realm 内 refresh single-flight 和原子凭据保存；官方凭据导入要求显式命令、精确 realm、匹配 P-256 密钥并拒绝隐式覆盖。

#### Experimental

- Trae Global 已验证个人账号浏览器授权与 loopback callback；独立新设备 token exchange 被上游设备数量上限拒绝。Global/CN 官方客户端凭据与完整绑定设备身份的只读导入、Global SG/CN 模型目录，以及两个 realm 的最小 Chat Completions 均已在本机真实验证；Global DeviceProof refresh 另在官方客户端完全退出后完成一次真实 E2E，确认 token family 轮换、刷新后模型发现与短聊天可用。Trae Global SOLO 链路（`trae-global-gpt-5.2` 等）经 `solo_work_lite` 池真实验证，模型精确遵从 `<toolcall>` 工具协议；每次 SOLO 调用消耗真实额度（单次约 1.7 万 prompt token 系统开销），高频使用会触发账号级限流。CN refresh、长期轮换稳定性、私有接口、共享 token family、服务条款、风控与接口变更风险仍由使用者评估。

### [0.1.2] - 2026-11-03

#### Added

- 新增 `x-adapter trae login --realm global --solo`：面向 SOLO OAuth 客户端的身份授权，为 `solo_work_lite` 池模型提供官方登录入口；复用已导入的 IDE 设备身份（需先执行 `trae import`），凭据存入 solo-token 文件并自动刷新。

### [0.1.1] - 2026-11-03

#### Added

- 豆包工作支持实验性的客户端工具桥接：`x-adapter doubao login --create-bridge` 在交互式确认后创建或复用 `X Adapter Bridge` 个人 Connector，请求使用私有 `runtime_type: 2`、`localConnectors` 与 `/alice/office/tool_local/*` 通道完成工具调用下发、结果上传、同轮续接和迟到结果恢复。普通请求不会静默创建 Connector。
- Trae 上游若同时声明 `display_config.max_mode`、`context_window_tokens.max` 与 `__max` 后端 detail，网关会把一条目录项展开为 Standard 和 `-max` 两个可精确路由的模型。每个变体保留自己的 `model_name`、输入上限、输出上限与总上下文。
- 模型发现三方言统一投影总上下文：OpenAI `metadata.context_window_tokens`、Codex `context_window` / `max_context_window` / `max_output_tokens`、Claude `max_input_tokens` / `max_tokens`。Pi extension 使用总上下文做 context meter，并把输出上限传给 `maxTokens`。

#### Fixed

- 修复 Max 变体同时声明 Standard 公开模型 ID 的路由歧义：两个变体共享同一上游 `config_name`，导致该 ID 的解析结果依赖数组顺序。
- 修复变体行丢失 `display_config` 与 `quota_info` 的 quota 回退链、忽略 entry 级 `default_reasoning_level`，以及按后端变体而非最终 ID 后缀追加 ` / Max` 显示名。

#### Security

- 客户端工具参数改用 Ajv 2020 严格模式校验，覆盖 `$ref`、`const`、`pattern`、数值与数组边界、`format`。未知关键字与 `$async` schema 在编译期以 `invalid_input` 拒绝，不触发异步校验。
- 豆包桥接将 `missing_doubao_bridge`、`doubao_bridge_disabled`、`doubao_tool_turn_expired`、`tool_output_mismatch`、`upstream_tool_choice_not_satisfied` 映射为稳定的 HTTP 与 SSE 错误；活动工具轮次只存在于当前 daemon 内存，并受绝对存活上限约束。

<!-- npm-release:end -->
