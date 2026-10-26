# @mlzwl/x-adapter

`@mlzwl/x-adapter` 是面向 Trae 与豆包工作的本地模型网关，提供 OpenAI-compatible、Anthropic Messages 和 Pi 接入。

> Trae Global/CN 接入目前为实验性能力：可从本机已登录的官方客户端只读导入 token 与绑定设备身份；独立 Global 浏览器 OAuth 的 callback 已验证，但新设备 token exchange 曾被账号设备数量上限拒绝。Global SG/CN 模型目录与 Chat Completions 链路已使用导入凭据真实验证；Global DeviceProof refresh 也已在官方客户端完全退出后完成一次受控 E2E，并确认 access/refresh token 均发生轮换。当前 `llm_utils_chat` 上游会忽略请求级 `max_tokens`；网关会按请求输出事件数与默认 1 MiB 输出字节上限主动取消，并分别投影为 Chat Completions `finish_reason=length`、Responses `status=incomplete`、Anthropic `stop_reason=max_tokens`，但这不是精确 token 计数。Trae 使用未公开接口，可能受服务条款、风控、额度限制或接口变更影响；请仅使用你有权访问的账号与额度。

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

# 可选：创建独立 OAuth 登录（可能占用新的设备名额）
x-adapter trae login --realm global
x-adapter trae login --realm cn
x-adapter doubao login
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

Global、CN 与豆包工作之间不会自动 fallback。默认模型为 `doubao-work-auto`，可通过 `X_ADAPTER_DEFAULT_MODEL` 修改。模型发现会同时声明每个模型的文本/图片输入能力；能力来自 Trae 目录元数据与少量实测覆盖，未声明能力的模型按纯文本处理。

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

自定义地址、本机鉴权、关闭自动启动/安装及离线模式见 [`docs/pi-provider-setup.md`](docs/pi-provider-setup.md)。

## 接入 Claude Code 与 Codex

参见 [`docs/cc-codex-setup.md`](docs/cc-codex-setup.md)。

## 常用配置

配置、缓存、日志、运行时文件和凭据默认保存在 `~/.x-adapter/`。

| 变量                      | 用途                                     |
| ------------------------- | ---------------------------------------- |
| `X_ADAPTER_PORT`          | 修改监听端口，默认为 `10100`。           |
| `X_ADAPTER_DATA_DIR`      | 修改数据根目录，默认为 `~/.x-adapter`。  |
| `X_ADAPTER_DEFAULT_MODEL` | 修改默认模型。                           |
| `X_ADAPTER_CLIENT_TOKEN`  | 为本机客户端请求启用可选的 Bearer 鉴权。 |

完整环境变量说明见 [`docs/operations.md`](docs/operations.md)。

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

### [0.1.0] - 2026-10-14

#### Added

- 提供仅支持 Trae 与豆包工作的本地模型网关，以及 OpenAI Chat Completions、Responses 和 Anthropic Messages 兼容接口。
- 在单一 `trae` provider 内提供相互隔离的 Global/CN realm、浏览器 OAuth、realm 独立凭据与模型目录，公开模型 ID 为 `trae-global-*` 和 `trae-cn-*`。
- 提供模型发现、精确 provider/realm 路由、Pi extension、Claude Code/Codex 接入，以及 macOS launchd 和 Linux systemd 用户服务管理。
- 将配置、缓存、日志、运行时文件和 provider 凭据统一保存到 `~/.x-adapter`，并支持通过 `X_ADAPTER_*` 环境变量覆盖。

#### Security

- 默认仅监听 loopback，隔离 Trae Global、Trae CN 与豆包工作凭据，并对 OAuth callback、上游 host、本机 HTTP 请求、日志脱敏和 daemon 生命周期执行 fail-closed 校验。
- Trae 浏览器 OAuth 使用 PKCE S256、一次性 loopback callback、P-256 设备证明、realm 内 refresh single-flight 和原子凭据保存；官方凭据导入要求显式命令、精确 realm、匹配 P-256 密钥并拒绝隐式覆盖。

#### Experimental

- Trae Global 已验证个人账号浏览器授权与 loopback callback；独立新设备 token exchange 被上游设备数量上限拒绝。Global/CN 官方客户端凭据与完整绑定设备身份的只读导入、Global SG/CN 模型目录，以及两个 realm 的最小 Chat Completions 均已在本机真实验证；Global DeviceProof refresh 另在官方客户端完全退出后完成一次真实 E2E，确认 token family 轮换、刷新后模型发现与短聊天可用。CN refresh、长期轮换稳定性、私有接口、共享 token family、服务条款、风控与接口变更风险仍由使用者评估。

<!-- npm-release:end -->
