# x-adapter 运行手册

## 能力状态与风险

豆包工作沿用现有登录与数据面。Trae Global/CN 为实验性接入：截至 2026-10-15，Global 个人账号已确认浏览器授权与 loopback callback，但独立新设备的首次 token exchange 被上游设备数量上限拒绝。Global/CN 官方客户端当前凭据和完整绑定设备身份已完成本机只读解析与隔离导入；Global SG/CN 模型目录和两个 realm 的最小 Chat Completions 均已真实返回。Global DeviceProof refresh 已在官方客户端完全退出后完成一次受控 E2E，确认 access/refresh token 轮换及刷新后的模型目录和短聊天；CN refresh 与长期轮换稳定性仍未验证。

Trae 接口不是公开稳定 API，可能随官方客户端、账号区域或服务策略变化；使用前请自行确认服务条款、账号权限、额度、风控与封号风险。x-adapter 不提供账号池、跨账号轮换、跨 realm fallback、签到、积分或账单功能。

## CLI

```bash
x-adapter start [--port <port>]
x-adapter status
x-adapter stop
x-adapter models [--json] [--all]
x-adapter models refresh
x-adapter models hide
x-adapter provider hide
x-adapter <trae|doubao> models [--json] [--all]
x-adapter trae login --realm <global|cn>
x-adapter trae import --realm <global|cn> [--storage <path>] [--force]
x-adapter trae refresh --realm <global|cn>
x-adapter doubao login [--chrome <path>] [--timeout-ms <ms>] [--no-save] [--verbose]
x-adapter doubao refresh
x-adapter update
x-adapter install-service [--output <path>]
x-adapter uninstall-service [--path <path>]
x-adapter version
```

交互终端可在省略 `--realm` 后选择 Trae realm；脚本、管道或其他非交互环境必须显式传入 realm，不会猜测。`start` 启动后台 daemon；`status` 返回版本、PID、地址、运行目录和 provider/realm 状态；`stop` 关闭活动连接后释放 daemon lock。

## 数据目录

统一默认目录是 `~/.x-adapter`：

- `config.json`：模型和 provider 可见性。
- `runtime/`：daemon lock 与 control socket。
- `logs/`：JSONL 与 service 日志。
- `cache/`：provider 模型缓存。
- `trae/global/auth.json`：Trae Global OAuth、设备身份和 token。
- `trae/cn/auth.json`：Trae CN OAuth、设备身份和 token。
- `trae/cache/<realm>/`：按 realm/账号/host/产品版本隔离的 Trae 模型缓存。
- `doubao-work/`：豆包工作 Cookie 配置。

凭据目录和文件分别使用 `0700` 与 `0600`。Trae auth 文件含 access/refresh token 与设备私钥，等同长期账号凭据；不要输出、提交、共享或同步到不受信任位置。除非用户显式执行 `trae import`，x-adapter 不读取官方客户端账号存储。导入时只读打开指定 realm 的 `storage.json`，解密并复制当前 token、machine/device ID 和匹配 P-256 密钥；不会写回官方客户端文件，也不会导入其他 storage 字段。

## Provider 登录

### Trae Global / CN

```bash
# 推荐：从已经登录的官方客户端导入
x-adapter trae import --realm global
x-adapter trae import --realm cn

# 官方存储不在默认位置时
x-adapter trae import --realm global --storage '/path/to/storage.json'

# 仅在确认可占用新设备名额时使用独立 OAuth
x-adapter trae login --realm global
x-adapter trae login --realm cn

x-adapter trae refresh --realm global
x-adapter trae refresh --realm cn
```

`trae import` 是显式、只读的客户端凭据复制：要求存储中恰好一个 `iCubeAuthInfo://icube-dc:<deviceId>`，校验其 P-256 公私钥匹配、realm 信号和 auth host allowlist，再原子保存到目标 realm。已有 `auth.json` 默认拒绝覆盖；确认要替换时才传 `--force`。导入后的 x-adapter 与官方客户端共享 token family 和服务端设备身份：任一端 refresh 可能轮换 refresh token，导致另一端持有旧 token；官方客户端退出、重置或重装也可能使导入凭据失效。不要让两端并发刷新，凭据失效时应重新导入官方客户端的最新状态。

`trae login` 为每个 realm 启动独立浏览器 OAuth：随机 state/trace、PKCE S256、仅监听 `127.0.0.1` 的限时一次性 callback，并将轮换 token 和 P-256 设备密钥原子保存到该 realm 的 `auth.json`。Global 当前协议以 callback 回传的随机 `loginTraceID` 绑定会话；官方 callback 不回传 state，只有其主动携带 state 时才额外校验。登录、account API 与数据 host 使用代码内独立 allowlist；callback `host` 只参与登录来源校验和区域判断，不直接成为 token 或数据请求目标。

Global 根据登录/账号返回的可靠区域信号固定到 SG 或 US account API 与数据面；网络失败不会触发 SG、US、CN 之间的探测或切换。CN 始终使用 CN realm；当前 CN 数据 host 来自公开参考实现交叉证据但不是 Trae 品牌域名，已通过精确 allowlist 限制，尚未由真实账号验证。旧的单 token 配置不兼容，也不会被解释为新 OAuth token。

### 豆包工作

```bash
x-adapter doubao login
x-adapter doubao refresh
```

登录会启动隔离的 Chrome/Chromium profile，确认页面已登录后，只保存目标域和 API 路径适用的 Cookie。也可显式设置 `X_ADAPTER_DOUBAO_COOKIE` 与 `X_ADAPTER_DOUBAO_COMMON_QUERY`。

## 模型与路由

模型 ID 必须带 provider/realm 前缀：

- Trae Global：`trae-global-<upstream-id>`
- Trae CN：`trae-cn-<upstream-id>`
- 豆包工作：`doubao-work-<model>`

Trae 模型只来自当前账号的实时目录或仍有效的同身份缓存，不使用静态列表伪造可用性。Global 与 CN 目录、状态和缓存独立；无实时目录且无有效缓存时，该 realm 不可用。`GET /v1/providers` 的 Trae 状态包含两个 realm 各自的 `configured`、`available`、`modelCount`、`fromCache` 与有界错误。

`models hide` 和 `provider hide` 只影响模型列表，不阻止已知 ID 的精确调用。不会在 Global、CN、模型或豆包工作之间自动 fallback。

## HTTP API

```text
GET  /health
GET  /v1/providers
GET  /v1/models
GET  /v1/models/:id
POST /v1/chat/completions
POST /v1/responses
POST /responses
POST /v1/messages
POST /v1/messages/count_tokens
```

仅允许 loopback 客户端。请求必须使用 JSON Content-Type；可用 `X_ADAPTER_CLIENT_TOKEN` 启用本机 Bearer 鉴权。

Trae 支持其模型目录绑定的普通 function tools；hosted web search 返回 `unsupported_hosted_search`。豆包工作只支持已验证的纯文本路径：普通请求附带的可选工具目录可以被剥离；强制工具选择、真实 tool call/result 或 hosted search 会明确失败。

Trae 聊天不会执行通用网络/HTTP 自动重试。仅当响应尚未开始且上游明确返回 401/403 时，才会在同一 realm 强制 refresh 并最多重放一次；配额、429、timeout、取消、普通错误或已开始的 SSE 都不会触发重放或 fallback。

当前真实诊断确认 `llm_utils_chat` 的 `output.response` 是短增量，不是累计快照；但 Global/CN 上游均忽略请求级 `max_tokens`，可能一直生成到模型目录声明的输出上限。x-adapter 因而把请求 `max_tokens` 作为保守的内容增量事件上限，同时默认最多向客户端暴露 1 MiB 的 text/reasoning/tool-call 序列化输出；命中任一边界时立即取消上游。Chat Completions 返回 `finish_reason=length`，Responses 返回 `status=incomplete` / `reason=max_output_tokens`，Anthropic 返回 `stop_reason=max_tokens`。事件数和字节数都不是 token 计数，不能把该兜底理解为精确 `max_tokens` 语义，也不能保证取消前的上游计费；仍应使用客户端取消与 `X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS` 限制持续时间。

## 主要环境变量

| 变量                                              | 默认值 / 说明                                   |
| ------------------------------------------------- | ----------------------------------------------- |
| `X_ADAPTER_HOST`                                  | `127.0.0.1`。                                   |
| `X_ADAPTER_PORT`                                  | `10100`。                                       |
| `X_ADAPTER_DATA_DIR`                              | `~/.x-adapter`。                                |
| `X_ADAPTER_RUNTIME_DIR`                           | `<data>/runtime`。                              |
| `X_ADAPTER_LOG_FILE`                              | `<data>/logs/x-adapter.jsonl`。                 |
| `X_ADAPTER_CONFIG_PATH`                           | `<data>/config.json`。                          |
| `X_ADAPTER_DEFAULT_MODEL`                         | `doubao-work-auto`。                            |
| `X_ADAPTER_CLIENT_TOKEN`                          | 可选本机 data-plane token。                     |
| `X_ADAPTER_TRAE_DATA_DIR`                         | `<data>/trae`。                                 |
| `X_ADAPTER_TRAE_AUTH_TIMEOUT_MS`                  | 浏览器登录和 OAuth 请求时限，默认 `120000`。    |
| `X_ADAPTER_TRAE_REFRESH_SKEW_MS`                  | 提前刷新窗口，默认 `300000`。                   |
| `X_ADAPTER_TRAE_MODEL_TIMEOUT_MS`                 | 模型目录请求时限，默认 `30000`。                |
| `X_ADAPTER_TRAE_MODEL_CACHE_TTL_MS`               | 模型缓存有效期，默认 `60000`。                  |
| `X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS`             | 单次聊天总时限，默认 `600000`。                 |
| `X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS`      | 首个上游 SSE 事件时限，默认 `120000`。          |
| `X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS`             | 上游 SSE 空闲时限，默认 `90000`。               |
| `X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS`           | 可选更严格的内容增量事件上限。                  |
| `X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES`            | 序列化输出字节上限，默认 `1048576`。            |
| `X_ADAPTER_TRAE_GLOBAL_PRODUCT_PATH`              | 可选 Global 官方公开 `product.json` 路径。      |
| `X_ADAPTER_TRAE_CN_PRODUCT_PATH`                  | 可选 CN 官方公开 `product.json` 路径。          |
| `X_ADAPTER_TRAE_<REALM>_APP_VERSION`              | realm 产品版本显式覆盖。                        |
| `X_ADAPTER_TRAE_<REALM>_PLUGIN_VERSION`           | realm 插件/build 版本显式覆盖。                 |
| `X_ADAPTER_TRAE_<REALM>_VERSION_CODE`             | realm 版本代码显式覆盖。                        |
| `X_ADAPTER_TRAE_<REALM>_{WEB,AUTH,DATA}_BASE_URL` | 仅接受内置 allowlist 中 HTTPS host 的高级覆盖。 |
| `X_ADAPTER_DOUBAO_DATA_DIR`                       | `<data>/doubao-work`。                          |
| `X_ADAPTER_DOUBAO_CONFIG_PATH`                    | `<doubao-data>/config.json`。                   |
| `X_ADAPTER_DOUBAO_COOKIE`                         | 显式豆包工作 Cookie。                           |
| `X_ADAPTER_AUTO_START`                            | Pi extension 是否自动启动 daemon。              |
| `X_ADAPTER_AUTO_INSTALL`                          | Pi extension 是否从公共 npm 自动安装 CLI。      |
| `PI_OFFLINE=1`                                    | 禁止 Pi extension 网络与生命周期动作。          |

`<REALM>` 为 `GLOBAL` 或 `CN`。realm 产品身份优先级为显式环境变量、已安装官方客户端的公开 `product.json`、包内保守 fallback。常规启动只读取公开 manifest 的 app/plugin/version-code、quality 和 Trae client ID；仅显式 `trae import` 会读取账号 storage。

## Service 与更新

```bash
x-adapter install-service
x-adapter uninstall-service
x-adapter update
```

macOS 使用用户级 launchd，Linux 使用用户级 systemd。`update` 从 `https://registry.npmjs.org` 检查并安装 `@mlzwl/x-adapter@latest`；如果 daemon 原先运行，会使用新安装的 CLI 重启。

## 排障

- `all_providers_unavailable`：Trae 两个 realm 与豆包工作均没有可用目录；分别检查登录和 realm 状态。
- `missing_trae_credentials`：优先对目标 realm 执行 `x-adapter trae import --realm global|cn`，或使用独立 OAuth 登录。
- `trae_credentials_exist`：目标 realm 已有凭据；核对账号后使用 `trae import ... --force` 才会替换。
- `trae_official_credentials_unchanged`：官方客户端与 x-adapter 仍持有同一个 refresh token；若刚由 x-adapter 刷新失败，必须先让官方客户端刷新/重新登录并产生更新凭据，再导入，不能用旧 token 覆盖。
- `invalid_trae_official_storage` / `invalid_trae_official_credentials` / `invalid_trae_official_device`：官方存储无法安全解码、缺少 token，或设备密钥不匹配；先启动并登录相应官方客户端，不要手工拼装凭据。
- `trae_official_realm_mismatch`：指定 storage 与目标 realm 不一致；不要跨 Global/CN 导入。
- `expired_trae_credentials`：refresh token 失效或设备证明被拒绝；若来自官方客户端，先重新导入其最新凭据；否则重新登录该 realm。
- `trae_device_limit_reached`：账号已达到 Trae 登录设备数量上限；先在 Trae 的账号/设备管理中下线不再使用的设备，再重新登录。x-adapter 不会自动下线设备。
- `insecure_trae_credentials`：凭据目录或文件权限对 group/other 开放；修复为目录 `0700`、文件 `0600` 后重试，或重新登录该 realm。
- `invalid_trae_host`：高级 host 覆盖或登录响应不在 allowlist；不要放宽校验，先核对公开协议证据。
- `unsupported_hosted_search`：Trae 当前没有经验证的原生 hosted-search 协议。
- `missing_doubao_credentials`：执行 `x-adapter doubao login`。
- `invalid_doubao_credentials`：Cookie 失效，重新登录；不会隐式重放请求。
- `unsupported_tools`：豆包请求包含强制工具调用或真实工具历史。
- `previous_response_unavailable`：本地 Responses history 已过期、被淘汰或 provider 不匹配；新建会话。
