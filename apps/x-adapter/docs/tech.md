# x-adapter 技术设计

## 范围

x-adapter 只包含 Trae 与豆包工作两个 provider。包名为 `@mlzwl/x-adapter`，源码目录为 `apps/x-adapter`，CLI、Pi provider 和 service 名为 `x-adapter`。

Trae 对外仍是一个 provider；`global` 与 `cn` 是其内部独立 realm。本实现不包含 Web SOLO Remote 的 `chat_sessions/events`、账号池、账号轮换、签到、积分、账单、usage、本地搜索或猜测性协议 fallback；只提供显式、按 realm 的官方客户端凭据只读导入。

## 架构

```text
client
  └─ loopback HTTP gateway
       ├─ protocol normalization
       │    ├─ Chat Completions
       │    ├─ Responses
       │    └─ Anthropic Messages
       ├─ model registry
       │    ├─ Trae adapter
       │    │    ├─ Global realm
       │    │    └─ CN realm
       │    └─ Doubao Work adapter
       ├─ Responses history
       └─ lifecycle / service / logging
```

`ModelRegistry` 并行发现 provider，Trae adapter 再并行发现两个 realm。失败被限制在对应边界，不阻塞另一个 realm 或豆包工作。公开模型 ID 为 `trae-global-*`、`trae-cn-*` 或 `doubao-work-*`，registry 只接受精确公开 ID。

## 配置、凭据与产品身份

统一数据根目录是 `~/.x-adapter`，可由 `X_ADAPTER_DATA_DIR` 覆盖。runtime、logs、cache、统一配置以及 provider 子目录都从该根目录派生。

Trae 凭据按 realm 存储在 `trae/global/auth.json` 与 `trae/cn/auth.json`，包含 OAuth token、账号非敏感标识、区域、产品元数据、machine/device ID、P-256 密钥和凭据来源。写入使用 `0700` 目录、`0600` 文件/临时文件、file fsync、原子 rename 和 best-effort directory fsync。refresh token 具有轮换语义，refresh 按 realm single-flight。

产品身份优先级：

1. realm 专属 `X_ADAPTER_TRAE_*` 显式配置；
2. 已安装官方客户端的公开 `product.json`；
3. 包内保守 fallback。

常规配置解析只访问官方 `product.json` 的 `appVersion`、`tronBuildVersion`、`traeVersionCode`、`quality` 和 `iCubeApp.authConfig.TRAE`。只有显式 `trae import` 才会只读打开目标 realm 的 `storage.json`。

## Trae 官方凭据导入

导入器支持官方客户端当前使用的两种 AES-128-CBC storage 包装头。密钥材料由每条记录的 32 字节随机量和对应固定 salt 经两轮 SHA-512 派生；解密后必须校验前置 SHA-512 完整性摘要。导入只投影以下字段：access/refresh token、到期时间、用户非敏感标识、allowlisted account host、`telemetry.machineId`、唯一 `iCubeAuthInfo://icube-dc:<deviceId>` 及其中的 P-256 公私钥。

导入在写入前验证：文件大小与读取期间元数据稳定、文档结构、realm 信号、auth host allowlist、唯一设备条目、私钥/公钥均为 P-256 且相互匹配。它从不写回官方 storage；目标 `auth.json` 已存在时默认拒绝覆盖。导入后的两端共享 token family 和服务端设备身份，因此不假设 refresh 可并发或可在错误设备间重绑；x-adapter refresh 只写自己的副本，另一端可能因 token 轮换变旧。

## Trae OAuth

每次登录生成随机 state/trace、PKCE verifier/challenge 和 P-256 设备密钥；callback server 只绑定随机 `127.0.0.1` 端口。官方 Global callback 当前回传并严格匹配随机 `loginTraceID`，但不回传授权 URL 中的 state；因此 trace 是实际会话绑定，state 仅在 callback 主动携带时要求精确匹配。只有精确 `/authorize` 路径、trace、可选 state 和授权内容均有效的 callback 才会被一次性消费；无效探测不能终止合法登录，超时和完成后都会关闭 server。

LoginGuidance、Web、登录、account API 与数据 host 分开 allowlist。所有 realm 的 LoginGuidance 都 fail closed；来自响应或 callback 的 host 必须重新校验，不能把用户可控内容直接作为 token 或数据请求目标。callback `host` 仅作为登录服务和区域信号，不会成为 token exchange 或模型/聊天目标。Global 根据可靠 region/host 信号固定 SG/US account API 与数据面；网络错误不会触发跨区域探测。CN 固定 CN account API 与数据面；其模型/聊天 host 为公开参考实现交叉出现但非 Trae 品牌域名的 `trae-api-cn.mchost.guru`，仅因精确 allowlist 才可访问，尚未由真实账号验证。

授权码使用 realm/region 固定 account API 上的 `/trae/api/v3/oauth/ExchangeToken` 与 PKCE 交换，并提交 P-256 设备公钥。refresh 使用同一路径、原设备身份和 ECDSA P-256 `DeviceProof`；签名原文由 method、path、client ID、refresh token、Unix 秒和随机 nonce 构成。首次换证返回 `20401` 时明确报告账号设备数量上限，不把它误判为 PKCE、host 或普通过期错误。401/403 只允许在聊天响应开始前强制 refresh 并重放一次。

## 模型发现与缓存

各 realm 优先请求 `/api/ide/v1/batch_get_detail_param`；无有效 batch 结果时，分别查询：

- `chat_v3`
- `solo_work_lite`
- `solo_agent`
- `solo_agent_lite`

单 function 失败只舍弃该 function；全部失败且无有效缓存时 realm 不可用。模型元数据保存 realm、config name、model name、实际发现的 candidate functions，以及目录 `display_config` 给出的图片输入/工具图片能力，不使用静态目录伪造账号权益。

`display_config.multimodal` 是目录提示而不是绝对契约。网关以它作为默认值，并只为已有实测证据的例外维护最小覆盖；字段缺失时 fail closed 为纯文本。统一发现接口分别输出 OpenAI `metadata.input_modalities`、Codex `input_modalities` / `supports_image_detail_original` 和 Claude `capabilities.image_input.supported`。Pi extension 读取该结论；三种请求协议都会在 adapter 执行前拒绝发给纯文本模型的图片，Responses 在合并 replay history 后再次校验，错误为 HTTP 400 `unsupported_multimodal_content`。豆包工作始终声明为纯文本。

缓存身份由 realm、账号 UID、数据 host、产品版本和 function 集合派生，不含 access token；token 轮换不会制造新缓存。内存和磁盘缓存均按 realm 隔离。

## 聊天协议与 fallback 边界

Trae 数据面使用 `/api/agent/v3/llm_utils_chat` 与 `Cloud-IDE-JWT`。请求以目录绑定的 config/model/function 构造；普通 function tools 继续经过 canonical schema 和稳定名称映射。SSE 映射 reasoning、text、tool-call、usage、progress 和 done；没有显式终态的 EOF 视为失败。

聊天 POST 不使用通用自动重试。仅在以下全部成立时允许尝试下一个 function：

- 错误发生在首个可见 SSE 事件前；
- 上游给出明确 function/agent/mode mismatch 信号；
- 下一项属于同一 realm、同一模型实时发现的 candidate functions。

配额、权益、429、普通 HTTP 错误、timeout、取消或已开始的 SSE 不得触发 function、模型或 realm fallback。Trae hosted search 明确返回 `unsupported_hosted_search`；不接入通用本地搜索执行链。

真实诊断证明 `llm_utils_chat` 不可靠地执行请求级 `max_tokens`。网关因此使用两个独立的本地输出边界：请求 `max_tokens` 限制可见的 text/reasoning/tool-call 增量事件数，`X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS` 可进一步收紧；`X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES` 默认将这些事件的文本或序列化 tool-call 总量限制在 1 MiB。达到上限后取消上游流并合成唯一 `done(length)`，流式和非流式调用都通过同一 canonical generator 获得一致结果；协议出口再分别映射为 Chat Completions `length`、Responses `incomplete/max_output_tokens` 和 Anthropic `max_tokens`。该边界只负责限制本机暴露和聚合的数据量，不把 SSE 事件或 UTF-8 字节伪装成 token，也不承诺取消前的上游计费精度。

当前官方包的静态客户端投影明确包含 `/api/ide/v2/llm_raw_chat`，其请求 schema 也并非普通 OpenAI body；它包含 config/model/session/conversation、request/mode/config/access type、reasoning、provider context、biz context 与 extra info 等字段。经授权的 Global 单次受控 probe 使用当前目录模型和该字段族，仍返回 HTTP 400 空体、无 SSE；未 refresh、未探测 v1、未 fallback。结合官方内部 AhaNet/native transport 证据，x-adapter 不把 raw-chat 接入正式聊天链路。

## Provider 隔离

- Trae Global/CN 分别读取自己的凭据、缓存、账号身份和 route metadata。
- 豆包 adapter 只读取目标域 Cookie 和 common query，使用自己的目录、模型目录、会话队列与 SSE parser。
- 本机客户端 Authorization 仅由 gateway 鉴权 middleware 消费，不得转发到 provider。
- 不允许跨 realm、跨模型或跨 provider fallback。

## Canonical 与 HTTP 安全

Chat Completions、Responses 与 Anthropic Messages 转换为 canonical request，由选定 adapter 执行，再投影回调用方协议。

Responses history 记录 provider；跨 provider `previous_response_id` 被拒绝。history 受 session 数、单 session record 数、TTL、总序列化字节数、replay 数和上下文字节预算约束。流式上游必须产生 canonical `done`，自然 EOF 不补成功终态。

- bind host 必须是 loopback。
- middleware 校验 Host、Origin、`sec-fetch-site`、Content-Type 与 body size。
- 可选 `X_ADAPTER_CLIENT_TOKEN` 保护 data-plane。
- 日志仅记录有界结构化诊断；Cookie、JWT、token、设备私钥、完整 callback query、schema literal、prompt、工具参数和工具输出不得写入。

## 生命周期与验证状态

CLI 使用 owner-only runtime lock 和 control socket 管理 daemon。停止与更新先关闭活动 data-plane 连接，再释放 lock。孤儿恢复仅针对命令行已验证为本包 `__daemon__` 的进程。

Pi extension 仅接受 loopback URL，可自动安装公共 npm 包并启动 daemon；不自动执行 provider 登录。

截至 2026-10-15，Trae 双 realm 行为来自公开源码、多来源协议交叉分析、官方安装包的静态 REA 证据、本仓库离线 mock 和经授权的受控真实请求。Global 个人账号验证确认了授权页、精确 `/authorize` loopback callback、`loginTraceID` correlation 和 callback 字段形状；独立新设备的首次 token exchange 返回 HTTP 403 / 业务码 `20401`。随后在本机 Global/CN 官方 `storage.json` 上确认了真实加密凭据、唯一设备条目和匹配 P-256 密钥，完成隔离目录导入，并从固定 Global SG/CN 数据面成功取得账号可见模型目录；重复验证时目录数量会随账号状态变化，因此不固化为静态列表。两个 realm 的最小非流式纯文本请求均成功；输出边界另以 Global 流式、CN 非流式聚合和 Global 客户端取消完成真实验收。Global DeviceProof refresh 在官方客户端完全退出后执行一次，access/refresh token 均发生轮换，隔离凭据原子更新，随后模型发现和一条有界短聊天成功。全程未输出真实凭据或模型 ID，也未保存正文。单次受控 Global `/api/ide/v2/llm_raw_chat` 仍为 HTTP 400 空体、无 SSE，因此没有接入。CN refresh、工具调用、reasoning、Global US/企业 host、长期轮换和全部目录模型仍无完整真实 E2E 证据，该能力继续标记为实验性。
