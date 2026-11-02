# Pi Provider 接入

`@mlzwl/x-adapter` 包含 Pi extension：

```bash
pi install npm:@mlzwl/x-adapter
```

extension 注册 provider `x-adapter`，默认连接 `http://127.0.0.1:10100/v1`，并注册 `/x-adapter` slash command。

## 使用

先在系统终端完成登录：

```bash
x-adapter trae import --realm global
# 如需使用中国区，再执行：x-adapter trae import --realm cn
# 没有可导入的官方客户端登录时，才使用：x-adapter trae login --realm global|cn
# 使用 SOLO 模型（gpt-5.2 等）再执行一次 SOLO 身份授权（复用已导入设备身份）：
x-adapter trae login --realm global --solo
x-adapter doubao login
x-adapter models refresh
```

然后在 Pi 中刷新模型并选择 `x-adapter` 下的 `trae-global-*`、`trae-cn-*` 或 `doubao-work-*` 模型。

```text
trae-global-<upstream-id>
trae-cn-<upstream-id>
doubao-work-auto
```

不要使用裸上游 ID；网关只接受带 provider 前缀的公开 ID。

## 自动启动与安装

extension 会先访问 `/health`。默认 loopback 网关不可用时，它可以调用 `x-adapter start`；CLI 缺失时可以从公共 npm 安装 `@mlzwl/x-adapter@latest`。

```bash
export X_ADAPTER_AUTO_START=0
export X_ADAPTER_AUTO_INSTALL=0
export PI_OFFLINE=1
```

以上变量分别关闭自动启动、自动安装和全部网络/生命周期动作。extension 不会自动执行 provider 登录，也不会读取或输出 provider 凭据。

## 自定义地址与本机鉴权

```bash
export X_ADAPTER_BASE_URL=http://127.0.0.1:10100
export X_ADAPTER_CLIENT_TOKEN='本机随机 token'
export X_ADAPTER_PROVIDER_ID=x-adapter
```

base URL 必须是 loopback HTTP(S) 地址，不能携带自定义路径。`X_ADAPTER_CLIENT_TOKEN` 只用于本机 gateway，不要填 Trae token 或豆包 Cookie。

## Slash command

```text
/x-adapter status
/x-adapter models --all
/x-adapter version
```

登录和交互式隐藏选择应在系统终端运行，因为 Pi command 不伪造 TTY。

### 从工具会话安全切换到豆包

豆包模型的工具轮次由网关的私有 Connector 桥接接管，Pi 侧 `tool_call` / `tool_result` transcript 不能直接沿用旧会话语义。若当前会话只有纯文本，可直接选择豆包；若已经调用过 Pi 工具，请不要用普通 `/model` 强行切换，而应执行：

```text
/x-adapter-doubao
/x-adapter-doubao doubao-work-auto
```

省略模型 ID 时默认使用 `doubao-work-auto`。该命令会等待当前轮结束，用**当前工具型模型**生成一份禁止调用工具的迁移摘要，再追加 retain-none compaction；只有在确认该 compaction 已写入 Pi session 后，才切换到目标豆包模型。摘要失败、尝试调用工具、用户按 Esc 中止、目标模型/认证不可用、compaction 未落盘或 `setModel` 失败时都不会切换。流程进行中也会拦截新的输入，避免摘要与用户消息交错。

这不是无损转换：摘要可能遗漏细节，并额外消耗当前模型的一次请求。retain-none 仅表示后续活动模型上下文从摘要开始，不代表删除审计记录；原始消息、工具调用和工具结果仍保留在 Pi 的 append-only session transcript 中。豆包的工具能力依赖实验性的私有 Connector 桥接，只覆盖本包已确认的工具名与串行调用；它不是通用 coding agent 保证。已经处于异常的“豆包模型 + 工具历史”状态时，应先切回支持工具的模型生成迁移摘要。

## 能力边界

- Trae Global/CN 目前是实验性能力；官方客户端凭据/设备身份导入、Global SG/CN 模型目录、两个 realm 的最小非流式聊天、Global 流式输出边界/客户端取消，以及一次 Global DeviceProof refresh 已完成本机验证。CN refresh、工具调用和 reasoning 仍需分别验证。普通 function tools 保留，hosted web search 返回 `unsupported_hosted_search`，并且不跨 realm fallback。
- extension 从 Codex 模型发现的 `input_modalities` 读取图片能力。只有网关明确声明 `image` 的模型才会让 Pi 保留用户图片和工具返回图片；未声明的模型按纯文本处理。
- extension 从 Codex 模型发现的 `context_window` 与 `max_output_tokens` 读取上下文和输出上限。Trae 若由上游明确提供 Max 后端，Pi 会把它显示为独立的 `-max` 模型，例如 `trae-global-deepseek-v4.1-flash` 是 200K Standard，`trae-global-deepseek-v4.1-flash-max` 是 1M Max。此处 Max 是后端变体，不是 `/thinking` 中的推理强度。
- 豆包工作可通过实验性的私有 Connector 协议调用 Pi 客户端工具。首次使用前，用户必须显式执行 `x-adapter doubao login --create-bridge`，并确认创建 `X Adapter Bridge`；普通请求不会自动创建连接器。工具轮次必须保留 `x-session-id` 或 Responses `previous_response_id`，且活动轮次仅在当前 daemon 进程内保存。当前桥接只支持串行客户端工具调用。图片输入仍在 adapter 执行前返回 `unsupported_multimodal_content`。
- 模型选择器名称会保留目录提供的 `model_load` 百分比；未提供时不会伪造。
