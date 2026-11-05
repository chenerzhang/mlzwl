# x-adapter 验证

## 自动验证

```bash
pnpm --filter @mlzwl/x-adapter typecheck
pnpm --filter @mlzwl/x-adapter lint
pnpm --filter @mlzwl/x-adapter format:check
pnpm --filter @mlzwl/x-adapter test
pnpm --filter @mlzwl/x-adapter verify
pnpm verify
pnpm --filter @mlzwl/x-adapter pack:dry-run
git diff --check
```

测试会先以 TypeScript 输出构建测试版本，按单线程运行现有测试，再构建只包含 `dist/bin/index.js` 与 `dist/pi/index.js` 的发布 bundle，并验证 CLI version 与 Pi extension 默认导出。

## 离线覆盖

- daemon start/status/stop、锁、control socket 和活动连接清理。
- Trae Global/CN host allowlist、SG/US/CN 固定路由、PKCE 授权 URL、loopback callback、必需 trace/可选 state 校验、一次性消费与超时关闭。
- Trae realm 独立凭据路径、`0700`/`0600` 权限、原子保存、P-256 `DeviceProof`、refresh token 轮换和 realm 内 single-flight。
- 官方客户端 storage 的 AES 解密/完整性校验、realm/host 校验、唯一设备身份、P-256 公私钥匹配、拒绝隐式覆盖/旧 refresh token 回滚、损坏本地凭据显式恢复和 Global/CN 导入隔离。
- Trae batch 模型目录、逐 function 降级、稳定缓存身份、realm 模型前缀、模型/function 绑定、图片能力元数据保留，以及一个 realm 失败的隔离边界。
- Trae Standard/Max 后端展开：`__dev`/`__max` detail 识别、`max_mode` + `context_window_tokens.max` + `__max` 三信号齐备才新增 `-max` 变体、缺失任一信号时只暴露 Standard、只有 `__max` detail 时自身投影为 Max、每个变体独立保存输入/输出/总上下文与推理强度，以及两个变体的精确路由（`-max` ID 解析到 `__max` `model_name`）。
- 模型发现三方言的总上下文投影（OpenAI `metadata.context_window_tokens`、Codex `context_window`/`max_output_tokens`、Claude `max_input_tokens`/`max_tokens`），以及 Pi extension 把 `max_output_tokens` 传为 `maxTokens`。
- OpenAI/Codex/Claude 三类模型发现的输入模态声明、Pi 图片能力读取、纯文本模型在三种协议上的图片 fail-closed 校验，以及图片模型的 canonical 图片保留。
- Trae `/api/agent/v3/llm_utils_chat` headers/body、reasoning/text/tool-call/usage SSE、显式终态、请求/配置输出事件和 UTF-8 字节边界、命中边界后的上游取消与 `done(length)`、401/403 最多 refresh/replay 一次、普通错误不自动重试、function mismatch 的有限纠正和 hosted search 明确失败。
- 豆包工作登录判定、Cookie 域/路径与权限、模型目录、请求构造、会话串行、SSE 终态、可重置空闲看门狗与服务端工具活动日志。
- 豆包工具桥接：Connector 查找/创建边界、`runtime_type: 2` 请求体、`connector.call` 路由、Ajv 严格 schema 校验（含 `$ref`/`const`/`pattern`/`format`/数值与数组边界）、未知关键字与 `$async` schema 的 `invalid_input` 拒绝、`tool_choice: none` 不编译被禁用 schema、末尾连续 tool 结果的提取与外部 `call_id` 拒绝、串行约束下第二个并发调用的上游错误结果、工具结果上传的一次瞬时重试与 401 不重试、显式中止看门狗，以及 `missing_doubao_bridge`/`doubao_bridge_disabled`/`doubao_tool_turn_expired`/`upstream_tool_choice_not_satisfied` 的 HTTP 与流式映射。
- 豆包模型目录的 `local_runtime` 声明，以及非豆包 provider 复用 `unsupported_tools` 时不继承该声明。
- Pi extension 的 `/x-adapter` 参数拆分与 CLI 代理、模型图片能力读取，以及 `/x-adapter-doubao` 的直接切换、摘要后切换、投影复检、认证预检和工具调用 fail-closed 路径。
- SOLO work 链路：`/models` 目录解析与同名去重、vscdb preset 解析与双源合并（碰撞前置 `solo_agent_remote`、源标注、不原地修改 IDE 条目）、SOLO 客户端伪装 headers、最小 body 构造、`<toolcall>` 协议注入与流式解析（跨增量切割、围栏容忍、相邻重放去重、坏块降级）、工具结果 transcript、usage/done/error 事件映射、双源全部不可用时退化为 IDE 目录，以及 SOLO token 的加载与自动刷新。
- Responses history 的 provider 隔离、LRU、TTL、record/replay、总字节限制和图片工具结果顺序。
- Chat、Responses 与 Anthropic 的 canonical 转换、流式 item 顺序、工具调用映射与资源限制。
- launchd / systemd 模板和卸载流程。
- token、Cookie、JWT、认证 headers 与嵌套字段的日志脱敏和轮转。

自动测试只能使用临时目录、mock fetch、模拟 callback 和非真实 token，不得读取默认真实凭据、发起真实登录、调用真实 OAuth/模型/AI 接口或写入 `~/.x-adapter`。

## Trae 验证声明

截至 2026-10-15，本版本已在用户授权下验证 Trae Global 个人账号浏览器授权：确认精确 `/authorize` loopback callback、`loginTraceID` correlation、官方 callback 不回传 state，以及授权码/账号/区域/login host 的字段形状。独立新设备的首次 token exchange 到 SG account API 返回 HTTP 403 / 业务码 `20401`；多个独立公开实现将其定义为账号设备数量上限。

随后对本机官方 Trae Global/CN 安装和 storage 进行了只读验证：

- REA 6.4.0 对两个提取后的 Electron app 目录完成静态分析；Global evidence ID 为 `ev_bdd5bd2004c0702f31ccc4d0c24afb15491481024145fa9bf895fe8bac09dc60`，CN 为 `ev_a10ead96bf9128d9285225411b7e2872fd8c3b789452ba902f4df1d6c7a9332b`。两次分析均为惰性静态语法，application/semantic graph 覆盖为 partial，不能单独证明运行时行为。针对当前 `ai-completion/dist` 的聚焦复查 evidence ID 分别为 Global `ev_39a437208dc8c6e45c1c7845ccc65697212f39dad64a2bb49a5db1d404b63c4c`、CN `ev_ce0a8a52c1bda74006c2109f36aeecc1b8b9c7c8646bacbe06cacd5b3768bba8`；两个 graph 仍为 partial。包内静态字节可观察到官方配置声明 `/api/ide/v2/llm_raw_chat`，但未观察到 `/api/agent/v3/llm_utils_chat` 字面量；这只说明可见静态入口不同，不能单独证明运行时最终路由。
- 真实 Global/CN `storage.json` 均确认存在可解密的 access/refresh token、唯一设备条目、machine ID，以及相互匹配的 P-256 公私钥；未输出任何实际值。
- 使用隔离的 `.tmp/x-adapter-live-official-import` 数据目录成功导入两个 realm，并验证目标目录/文件为 `0700`/`0600`、来源为 `official-client`、realm/region/allowlisted account host 正确。Global/CN token、device ID 与 key 指纹相互隔离；官方两个 edition 共用同一 machine ID，因此 realm 隔离不以 machine ID 必须不同为前提。
- 使用导入凭据真实请求当前固定数据面，Global SG 与 CN 均成功返回模型目录；重复验证时账号可见目录数量发生变化，说明该结果是动态账号状态，不能固化为静态数量。报告只保留当次数量、function 分布和模型 ID 摘要指纹，不保存 token 或上游原始响应。
- 启动隔离 daemon 后，经本地 `/v1/chat/completions` 分别向 Global SG 与 CN 各发送一次最小非流式纯文本请求；两者均返回 HTTP 200、assistant 内容、`finish_reason=stop` 和 usage，证明本地协议到真实上游的基本聊天链路可调用。该 smoke 不验证流式、工具调用、reasoning、所有目录模型或额度稳定性；原始回复已删除，只保留不含模型 ID、正文或凭据的状态摘要。
- 随后直连同一固定数据面做脱敏 SSE 形状诊断：Global/CN 各返回恰好 20,000 个非空 `output.response` 事件，单块 1–9 字节，绝大多数与前块互不为前缀，因此不是累计快照被重复拼接。两端所选当前默认模型都在请求传入 `max_tokens=32` 时生成到 20,000 个事件；这个数量与目录 `max_tokens=20000` 高度一致，但 SSE 事件数不等同于可证明的 token 数。可确认的是本轮 `llm_utils_chat` 没有遵守请求级输出限制，此前约 49–62 KB 的长回复主要来自真实长生成，而非 x-adapter 的前缀重复。诊断只保存长度、关系计数和终态，不保存正文、模型 ID、token 或原始响应。
- 当前官方 Global 包的静态 HTTP client 投影确认 `/api/ide/v2/llm_raw_chat` 请求包含 config/model/session/conversation、request/mode/config/access type、reasoning、provider/biz context、extra info 等字段，但不包含请求级 `max_tokens`。按该字段族与当前账号目录默认模型执行了一次受控 Global probe；返回 HTTP 400 空体、0 个 SSE 事件。探测设置 20 秒、128 事件和 8 KiB 上限，未触发 refresh，未尝试 v1，也未做任何模型/function/realm fallback。这个结果不能证明 endpoint 永久不可用，但结合官方 AhaNet/native transport 证据，足以否定当前独立 HTTP 实现直接切换到 raw-chat。
- 因 raw-chat 未通过，代码继续使用 `llm_utils_chat`，并在 canonical Trae 流中加入本地输出上限：请求 `max_tokens` 限制内容增量事件数，配置可进一步收紧；默认 1 MiB 输出字节上限独立生效。命中边界会取消上游并返回 canonical `finish_reason=length`，再由协议层映射为 Chat Completions `length`、Responses `incomplete/max_output_tokens` 和 Anthropic `max_tokens`。离线测试覆盖流式/非流式共用路径、reader 取消传播、UTF-8 边界、协议终态和超限 tool-call 不泄露；这不是 token 计数，也不是真实额度/计费保证。
- 经单独授权后，以刷新禁用的 guarded fetch 和至多三次生成完成真实输出边界验收：Global 流式与 CN 非流式聚合均在两个内容增量事件后返回 `length`，Global 客户端取消在首个内容事件后返回 `client_abort`。全程共三次 chat、零次 token exchange、零次 raw-chat；只保存事件类型、字节数和终态。
- 随后在确认 Trae Global 官方客户端进程完全退出后执行唯一一次 Global DeviceProof refresh；关闭网络重试，并硬限制为一次 ExchangeToken、一次模型目录请求和一次短聊天。access token 与 refresh token 均发生轮换，新凭据原子写入隔离 `auth.json`；刷新后模型目录返回一个当前可见模型，短聊天返回 usage 并被两个事件的网关上限终止为 `length`。这证明当前 Global SG 导入身份的 refresh、轮换、持久化、模型发现和基础聊天链路可用，但不证明 CN、长期重复轮换或官方客户端持有旧 token 时的恢复行为。
- 2026-10-15（续，接力会话）：验证矩阵确认 `llm_utils_chat` + `solo_agent` 对 native_ide 会话身份不可用（4120 `CAN_NOT_USE_SOLO_MODE`，换 OAuth token 无效），而 Web SOLO remote（`core-normal.trae.ai/api/remote/v1`）用同一 OAuth 凭据 + web 客户端头完全跑通；OAuth 登录复用导入设备身份后不再触发设备上限 20401。SOLO remote 真实调用实测：`gpt-5.2`、`gpt-6-sol`、`kimi-k3` 成功，`gpt-6.1-sol` 会话创建成功但静默无输出，`Dola-Seed-2.0-Code` 返回 4001（仅存在于客户端 preset 目录）；`GET /models` 返回 6 个模型且与可调用集合不重合，因此目录采用 `/models` 权威 + vscdb preset 双源合并。
- 2026-10-16：SOLO remote 接入 x-adapter 后的端到端验收（隔离 daemon、真实凭据、真实上游）：`models refresh` 后 Global 目录共 21 个模型（`/models` 权威 6 + vscdb preset 14 + IDE 1，`metadata.solo_source` 标注来源）；`trae-global-gpt-5.2` 非流式返回 `PI_OK` 与真实 usage（prompt 17149，为 SOLO 系统开销），`trae-global-gpt-6-sol` 流式返回 `PRE`+`SET_OK` 两个增量（thought 差量 + finish summary 补差路径均命中）并以 `completed` 终态结束。
- 2026-10-17（工具调用攻坚）：系统性穷尽 intl 原生工具透传路线——`llm_raw_chat` v1/v2 在 IDE token（chat_v3/solo_agent × fast_apply/gpt-5.2/`gpt-5.2__dollar__dev`）与 SOLO token 下全部 4023 “model is unknown”（intl 网关未给该 appId 配置模型池，与 CN 侧 2001 同源）；SOLO token + `solo_work_lite` 此前测得 4120/2001 的根因是伪装不完整。chat_sessions（solo_agent）链路的前端证据（work.trae.ai `buildSendMessageRequest` 无 tools 字段）与三次真实调用（模型用内置工具自己干活、无视注入协议）确认该链路无外部工具通道。本机残留的 TRAE SOLO 桌面客户端凭据可解密（wangqi233/trae2api 的静态盐 AES 方案）但 refresh token 已被服务端吊销（20101）。
- 2026-10-17（成功配方）：参考 wangqi233/trae2api（双区 trae2api，9 月活跃）复刻完整伪装后实测通过：SOLO token（`en1oxy7wnw8j9n`）+ `coresg-normal` + `llm_utils_chat` + **`solo_work_lite`** + SOLO 客户端头部（83DG/Windows/3.5.51/default）+ 最小 body。真实 `gpt-5.2-2025-12-11` 精确遵从 `<toolcall>{"name":"read_file","params":{...}}</toolcall>` 协议（含参数）。该池为 work 档裸 LLM，无服务端 agent 编排——提示词工具模拟成立的必要条件。上游会重放相同 toolcall 块（实测单块重复 6 次），解析层做相邻去重。网关层端到端（OpenAI tools 进→tool_calls 出）因当日触达账号级限流（3004）待窗口解除后补录；离线测试 149/149 覆盖请求构造、协议注入、流式解析、去重、降级与多轮 transcript。

以下内容仍未被真实账号确认：

- CN DeviceProof refresh、Global 长期重复轮换，以及官方客户端持有轮换前旧 refresh token 时的恢复行为。
- Global US/USTTP 独立链路和企业账号 host 变体。
- 非品牌 CN 数据 host `trae-api-cn.mchost.guru` 的当前归属与长期稳定性；本轮仅确认当前真实账号链路可用。
- Trae 工具调用、reasoning、字节上限单独命中、套餐/额度行为与其他业务错误码；当前纯文本边界、客户端取消和最小聊天成功，不代表每个返回模型或高级能力都可用。
- Standard/Max 展开的离线覆盖只使用构造 payload；真实账号目录是否同时提供 `max_mode` 与 `__max` detail、Max 后端的实际额度与限流行为仍未验证。
- Trae 上游 `token_usage` 事件是否真的携带 `cache_read_input_tokens` 与 `cache_creation_input_tokens` 尚无本仓真实探针证据：当前实现按该字段形状假设投影，只有离线构造 payload 覆盖协议投影与钳制。SOLO work 链路与豆包工作的缓存字段同样未验证，因此这两条链路不输出缓存字段。
- 豆包工具桥接的私有接口、Connector 生命周期、内置工具映射、并行拒绝、等待恢复与轮次上限均只有离线覆盖；尚未用真实账号完成桥接 E2E。
- SOLO remote 链路的多轮长对话、除 `gpt-5.2`/`gpt-6-sol`/`kimi-k3` 外的 preset 模型、`gpt-6.1-sol` 静默无输出的原因、CN 侧是否存在等价 remote 协议，以及 SOLO 会话的服务端保留时长与额度计费细则。
- 官方客户端升级后的 storage codec、版本、设备身份和请求字段要求。

私有接口可能随时失效，也可能触发条款、风控、额度或封号风险。真实 smoke 必须作为单独阶段，由用户明确授权后进行，不能因离线测试通过而默认执行。

## 经授权后的真实 smoke 清单

1. 使用隔离的 `X_ADAPTER_DATA_DIR`、端口和日志路径启动 daemon。
2. 优先在官方客户端保持登录后，对 Global/CN 执行显式 `trae import`；如需独立 OAuth，再单独确认设备名额影响。
3. 导入后先验证 realm、region、allowlisted host、凭据到期时间和权限，不输出 token 或私钥；仅在单独授权且官方客户端完全退出后执行 refresh。
4. 验证 `/health`、`/v1/providers`、OpenAI/Codex/Claude 三类模型发现及 realm 状态。
5. 对已授权 realm/provider 各执行一条最小纯文本非流式请求；按需验证 SSE 唯一成功终态与 `[DONE]`。
6. 确认请求没有跨 realm、跨模型或跨 provider fallback，401/403 最多重放一次。
7. refresh 另行确认，因为可能轮换官方客户端共享的 token family；官方客户端和 x-adapter 不得并发 refresh。
8. 不保存 prompt、正文、Cookie、JWT、token、设备私钥、callback query 或上游原始响应到日志/报告；隔离 `auth.json` 仅按用户授权暂存。
9. 验证结束后停止 daemon，并按用户选择保留或清理隔离凭据。

豆包工作另需先显式执行 `x-adapter doubao login`（若本机尚无私有配置），然后选用 `doubao-work-*` 模型验证新会话与同一 `session_id` 的连续请求。验证实验工具桥接时，使用专用测试账号执行 `x-adapter doubao login --create-bridge` 并人工确认创建个人 Connector。只声明无副作用的 `noop` 工具。验证调用下发、匹配结果上传、同轮继续生成、强制 tool choice、未知工具、schema 错误、超过 40 秒的等待、取消、断流重连、重复调用、重复结果和迟到结果。测试完成后不得删除或改动用户既有 Connector；如需清理测试 Connector，必须再次获得明确授权。新账号没有 recent conversation 时应仍能登录并用内置目录创建首个会话；已有会话后确认 daemon 使用 Node `fetch`，且动态模型目录保留 CIS `provider_id` / reasoning level。记录 headers 首包与 read chunk 数时只能记录时延和 chunk 数，不得记录响应原文；当前已观察到 Node fetch 可能直到生成完成才返回单个 chunk，而浏览器 fetch 可分块，不能将前者宣传为实时流。

凭据、网络、协议证据或授权不足时必须停止并报告阻塞，不得把 mock 结果描述为真实上游通过。
