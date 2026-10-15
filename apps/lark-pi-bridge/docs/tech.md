# 技术架构与实现契约

本文是 `@mlzwl/lark-pi-bridge` 的当前架构文档，描述稳定组件边界、请求链路、状态归属和维护约束。阶段性验证结果见 [`verification.md`](verification.md)，具体安全控制见 [`security.md`](security.md)，重大设计取舍见两份 ADR。

## 1. 系统定位

`lark-pi-bridge` 是运行在用户本机的飞书/Lark coding-agent 控制面：

- 北向连接飞书/Lark Channel，接收私聊、群聊、话题和云文档评论；
- 南向只调用本机 Pi CLI；
- Pi 再按 profile 的 user/profile 配置来源连接模型 provider；
- CLI、Web console 和用户级 service 负责本地管理。

它不是模型网关，也不依赖、导入或管理其他 workspace app。用户可以把任意兼容服务（包括自行部署的 `x-connect`）配置成 Pi 的 OpenAI-compatible endpoint，但这只是外部数据面选择。

```text
Feishu / Lark
    │  messages, comments, images
    ▼
@larksuite/channel
    │
    ▼
src/bot/channel.ts
    ├─ access policy / scope identity
    ├─ workspace + access + timeout settings
    ├─ session catalog
    ├─ attachment store
    └─ RunExecutor
          │
          ▼
    AgentAdapter
      ├─ spawn-per-turn: pi --mode json
      └─ rpc: pi --mode rpc + bounded pool
          │
          ▼
    profile-local Pi
          │  provider HTTP protocol
          ▼
    configured model endpoint

Pi events ──► strict translator ──► AgentEvent ──► card/text reply ──► Feishu / Lark
```

## 2. 组件边界

| 组件         | 主要模块                                               | 职责                                                                            |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| CLI          | `src/cli/index.ts`, `src/cli/doctor.ts`                | 初始化、注册、profile/workspace/model 管理、刷新、更新、前台运行和 service 管理 |
| 应用注册     | `src/registration/app-registration.ts`                 | 调用 `registerApp()`，声明最小 addons，以 opaque URL 驱动二维码确认             |
| 配置         | `src/config/*`                                         | schema v3、私有凭据引用、模型配置、非机密 DTO、原子 mutation                    |
| 飞书入口     | `src/bot/channel.ts`                                   | 建立 Channel、连接看门狗、入口授权、scope 计算、命令分流、评论和附件接入        |
| 策略         | `src/policy/*`, `src/commands/*`                       | workspace 解析、access 上限、policy fingerprint、slash command                  |
| 会话状态     | `src/session/*`                                        | scope 设置和 Pi session catalog 的并发安全持久化                                |
| 运行编排     | `src/runtime/*`                                        | scope 互斥、并发、控制、timeout、私有 runtime control 与整代 reload             |
| Pi transport | `src/agent/pi/*`                                       | JSON/RPC argv、协议解码、事件翻译、连接池、图片编码和安全 fallback              |
| 回复         | `src/card/*`                                           | 将 `AgentEvent` 渲染为流式 Markdown 或文本终态                                  |
| 附件         | `src/media/attachments.ts`                             | 图片下载、类型/大小校验、run-owned 私有落盘和清理                               |
| 本地控制面   | `src/web/*`                                            | loopback-only、非机密的浏览器管理 API 与内嵌页面                                |
| 生命周期     | `src/daemon/*`, `src/update/*`, `src/runtime/locks.ts` | 前台 PID/锁、三平台用户级 service ownership/回滚及安全自更新                    |

`src/index.ts` 只导出可复用的运行时类型和受支持模块；生产入口由 `src/cli/index.ts` 驱动。

## 3. 消息执行链路

### 3.1 入口与 scope

Channel SDK 先做事件归一化和去重，bridge 再按 profile 执行 fail-closed 授权与按群 mention 策略。默认仍由 SDK 直接拒绝未 mention 群消息；只要配置了 `mentionOptionalChats`，SDK 的全局 `requireMention` 必须关闭以接收候选事件，Bridge 随后只放行真实 mention 或 chat ID 位于该例外集的消息。例外集必须是 personal profile `allowedChats` 的子集：

- 私聊和普通群：scope 为 `chatId`;
- 话题：scope 为 `chatId:threadId`；
- 文档评论：scope 为 `comment:<fileToken>:<commentId>`。

`/stop`、`/steer` 和 `/follow-up` 在普通提交前分流，以便控制活跃运行；其他本地命令不会启动模型 turn。`/workspace` 命令由 bridge 本地处理。RPC 的 `/model`、`/thinking` 和增强后的 `/status` 在同一 scope/global 互斥边界内获取对应 idle child，以严格投影后的 `get_state`、`get_available_models`、`set_model`、`get_available_thinking_levels` 和 `set_thinking_level` 实现；不会向模型发送 prompt。`/pi commands` 通过当前 scope 的 RPC child 查询 `get_commands`，只投影名称、extension/prompt/skill 来源和有界描述；`/pi /<command>` 先用同一结果做 allowlist，再把 `/pi ` 后的原始命令直接交给 Pi，不经过 `buildBridgeUserPrompt()`。任何未知或 malformed slash command、TUI 内建命令都被拒绝。普通请求和 Pi command discovery 都受同一 scope/global 并发限制。

### 3.2 执行身份

一次可恢复运行由以下信息共同约束：

```text
profile + scopeId + canonical cwd + access policy fingerprint
```

`SessionCatalog` 只在该身份完全匹配时返回活动 Pi session。每次消息、评论和 workspace 命令都重读 schema v3 的 alias registry/default 与 scope settings；不使用 watcher。scope override 优先于 `defaultAlias`，`defaultPath` 用于简单本地默认目录，三者不会静默 fallback。alias 删除、默认缺失或目录失效均明确失败。canonical cwd 或 access 改变会生成新 fingerprint；切回原 canonical cwd 可恢复原 identity 的 session。

RPC pool key 进一步包含 model 与 thinking level。Pi child 的实际 session ID 通过 `get_state` 与 catalog 逐次核对，不匹配时销毁旧连接，而不是把 prompt 发送给错误 session。会话内模型和思考级别选择写入私有 `scope-settings.json`，用于 Bridge 重启或 child 重建后的启动覆盖；恢复已有 session 时不再重复传 profile 默认 model，以免覆盖 session 已记录的模型。`/new`、workspace 或 access 改变会清除该覆盖，使新 identity/session 回到 Pi/profile 默认选择。

### 3.3 附件

图片先由 `AttachmentStore` 下载到 `media/<run-id>/`：

1. 限制数量和单文件大小；
2. 同时校验规范化 MIME 与 PNG/JPEG/GIF/WebP magic bytes；
3. 使用 `0700` run 目录和 `0600` 文件；
4. spawn-per-turn 传入受控本地文件参数；
5. RPC 重新以 `O_NOFOLLOW` 打开并复核 inode、大小和类型，再转成有界 base64 image object；
6. 运行完成、失败或中断后删除整个 run 目录。

### 3.4 事件与回复

两个 transport 都产生统一的 `AgentEvent`。严格 translator 维护工具调用和消息生命周期；普通模型运行只有 Pi 的最终 `agent_settled` 可以产生正常 `done`，`agent_end` 只是中间事件。Pi 对 extension command 返回 `disposition=handled` 只表示该输入已被消费，不证明扩展没有启动独立工作；Bridge 会在一个有界 quiet period 内重复确认 `get_state` 仍 idle 且普通 event inbox 为空，才把它作为无模型 turn 正常完成。若独立模型流在观察期内启动，则继续等待最终 `agent_settled`。Pi 1.0.2 仍无法证明观察期之后永远不会启动 fire-and-forget 工作，因此无模型完成会销毁而不是回池复用该 child；更晚的工作随 child 关闭而终止，不会泄漏到下一次 run。

`streamAgentReply()` 优先驱动 Channel SDK 的 Markdown stream。流式阶段只向 CardKit 写入有界预览，避免累计输出在单元素约束上失败；终态先安装一个结构完整的卡片分片，剩余内容再作为普通 Markdown continuation 顺序发送。飞书官方限制文本请求体最大 150 KB、富文本/卡片请求体最大 30 KB；Bridge 按序列化后的 `content` 字节数分别使用 140,000/28,000-byte 保守边界，而不是按 JavaScript 字符数估算。拆分器优先段落、标题和行边界，在代码块边界闭合/重开 fence，在表格边界重复表头与 separator，极端超长表格行则转成完整的 fenced literal 分片。SDK stream 在 producer 前失败时，会消费完整事件流并使用同一拆分器回退；聊天回复不会由文本 renderer 静默截断，文档评论保留显式的 12,000 字符安全上限。这些边界独立于本机 Pi RPC 的 16 MiB 单条 JSONL 上限。失败、中断、超时和无文本完成均有明确用户终态。同一 scope 已有普通 run 时不排队第二个 prompt，并明确提示使用 `/steer`、`/follow-up` 或 `/stop`，不再把并发冲突误报成 Pi 启动失败。

### 3.5 长连接健康与恢复

Channel 启用 20 秒应用级看门狗和 45 秒 pong 超时。连接健康时看门狗只读取 SDK 内存状态，不发送额外 HTTP；连续三次异常且飞书 HTTP 域名可达时才强制重连。`reconnecting` 超过 2 分钟、SDK 状态进入 `failed` 或强制重连失败均视为不可恢复，错误通过 BridgeChannel failure 传播到 CLI，先清理 channel、Pi child、锁和控制通道，再让进程非零退出并由持久 service 拉起。

进程重启不是紧密循环：`runtime/connection-retry.json` 只记录失败次数和时间，启动前使用 `5s → 15s → 45s → 2m → 5m` 封顶退避；连接稳定 2 分钟后失败级别失效。runtime control 状态同时报告 PID 之外的 `ready/degraded/failed`、WebSocket state、最近连接时间、reconnect attempts 和最近入站时间，不能再以 PID 存活代表消息入口健康。自动恢复不回读或重放断线期间的聊天历史，避免重复执行有副作用的 prompt。

## 4. Pi transport

### 4.1 spawn-per-turn

这是可显式选择的逐轮隔离模式；新 profile 的 `init` 默认使用 RPC。每次普通请求启动一个 `pi --mode json` 子进程：

- prompt 通过 stdin 输入；
- session 通过 profile-local session 目录恢复；
- stdout 使用严格、有界 LF JSONL 解码；
- stop/timeout 先 SIGTERM，超过 grace 再 SIGKILL；
- run 结束后没有空闲 child；
- 不支持 `/model`、`/thinking` 或增强模型状态查询，明确提示改用 RPC。

### 4.2 RPC

RPC 是新 `init` 的默认 transport，也可显式启用或切换。`StrictPiRpcConnection` 负责 command UUID 关联、模型/思考级别 RPC 响应投影、严格记录校验和独立容量上限；JSONL 单记录上限容纳 Pi 官方 `agent_end.messages` 在工具密集型 run 中形成的多 MiB 权威事件，累计 stdout 上限按 pooled run 重置而不是跨 child 生命周期永久累加，event inbox 仍独立有界。`PiRpcPool` 负责连接容量、idle TTL、idle-only LRU、busy 互斥和失效回收。

`extension_ui_request` 与 `ui_prompt_start/ui_prompt_end` 由 connection 在普通 event 之前分流，绝不进入 `PiJsonTranslator` 或 agent inbox。九种官方方法使用独立严格 schema；blocking request 的 `extension_ui_response` 直接写 child stdin，不进入普通 command pending map。Pi adapter 在连接创建时即安装 sideband handler：无 active run 的 dialog 立即取消，启动期 fire-and-forget 安全忽略；active run 通过 Lark 无关的 interaction port 交给 channel broker。broker 用随机一次性 token 绑定 run/scope/actor/method/服务端选项/期限，并限制每 run 4 个、全局 64 个 pending；pool release、stop、invalidate、refresh、disconnect 和 dispose 都清理交互。群聊/话题/评论将完整卡片私发操作者，原 surface 只可显示等待提示。

RPC fallback 由独立 adapter 实施。只有连接创建/握手等 prompt 写入前失败，或 Pi 明确返回 `prompt success:false`，才能把同一普通请求交给 spawn-per-turn。写入开始后的 timeout、断连、UI 错误、协议错误或 child death 都属于接受状态不确定，禁止重放；`/pi` 永不回退到 spawn-per-turn。

详细理由见 [`adr-pi-rpc-transport.md`](adr-pi-rpc-transport.md)。

## 5. 状态与目录

默认根目录是 `~/.lark-pi-bridge`：

```text
~/.lark-pi-bridge/
├── config.json
├── active-profile
├── runtime/app-locks/                 # 同一 OS 用户、同一 App ID 的共享锁
└── profiles/<profile>/
    ├── app-secret                     # 0600
    ├── sessions.json.catalog.json     # scope/cwd/policy -> Pi session
    ├── scope-settings.json            # workspace/access/timeout/model/thinking
    ├── pi-agent/
    │   ├── models.json
    │   ├── auth.json
    │   └── sessions/
    ├── media/                         # run-owned 临时图片
    ├── logs/                          # service 日志
    └── runtime/                       # profile lock、PID、认证 control socket/port、临时 QR/manifest
```

核心归属规则：

- `config.json` 使用 root/profile schema v3，并要求 `preferences.piConfigScope=user|profile`；workspace 以 `named + defaultAlias` 表示，`defaultPath` 与 `defaultAlias` 互斥；
- `config.json` 保存 profile 和非机密引用，不保存新式 App Secret；
- App Secret 必须位于所选 profile 内，且不能是 symlink 或宽权限文件；
- `user` scope 的 Pi settings/auth/resources 来自只读用户 `~/.pi/agent`，`profile` scope 的模型/auth 来自 profile-local 配置；session 与 Bridge prompt 始终 profile-local；
- catalog 与 scope settings 使用进程内队列、跨进程锁、锁内重读和私有原子替换；
- 相同 App ID 的共享锁位于默认用户级根目录，因而能跨 profile 和自定义 `--home` 互斥。

## 6. 管理面

### 6.1 CLI

CLI 是唯一可创建 profile、发起 device-code 注册、导入凭据、执行真实 credential probe 和安装 service 的入口。`validate` 使用临时 Pi profile 与 loopback mock，只验证本机 Pi 能力，不访问真实 provider。

### 6.2 Web console

Web server 固定监听 `127.0.0.1`。API 只处理 allowlist DTO，并执行 loopback、Host、Origin/Referer、fetch-site、session cookie、CSRF、JSON 大小和一次性 request ID 校验。它不接收 App Secret/provider key，不返回日志、二维码或注册链接，也不执行真实模型 turn。

### 6.3 Runtime refresh

前台 `run` 在 profile 私有 runtime 目录创建 0600 token 与 Unix socket；Windows 使用仅回环随机端口和私有 port 文件。`status` 通过该通道报告 runtime 与 WebSocket 健康状态，不会新建飞书连接；持久 service 的 platform status 仍只代表进程管理器视角。`config refresh` 先 quiesce ingress，并将 ingress/prepare 计入 starting；只有 active/starting 均为 0 才加载最新非 workspace 配置，整代替换 Channel、入口 policy 和 AgentAdapter。fingerprint 还包含 App Secret、scope、有效 Pi 配置目录内 settings/models/auth 的单向摘要和有界资源元数据摘要，因此这些外置文件变化也会触发重建，但不会进入输出。被替换的 generation 会停止运行并 dispose RPC pool；新 generation 启动失败时恢复原配置，恢复也失败则 fail-closed。workspace 字段从 fingerprint 中排除，因为其按次读取。runtime 未运行时，CLI 仅解析 profile、验证 Secret/model 配置并运行隔离 Pi capability probe，随后报告下次启动生效。

### 6.4 Service manager 与 update

`ManagedService` 生成并管理当前用户的 launchd、systemd user 或 Task Scheduler 定义。定义只含绝对运行路径、profile、bridge home、受限 PATH 和日志路径，并用 package marker 建立 ownership；未知定义不会被覆盖或删除。enabled 与 running 是独立维度，updater 可恢复 enabled/stopped、disabled/stopped、enabled/running 与 disabled/running。

`update` 只接受能通过 package metadata、真实路径和全局 npm root 证明 ownership 的布局。它在用户级锁内用结构化 argv 查询固定公共 npm registry 的 latest，禁止降级；需要更新时检查 runtime 空闲，停止原本 running 的 owned service，安装 exact latest，再以新 Node/CLI 路径重写 owned definition 并恢复原状态。无版本变化不重启；安装或 service 恢复失败会报告明确阶段且不猜测降级。

对应设计决策见 [`adr-local-control-plane.md`](adr-local-control-plane.md)。

## 7. 注册、权限与模型配置

`init --register` 直接调用 `@larksuite/channel.registerApp()`。短效 URL 被视为 opaque string；`lark-cli` 只负责二维码渲染，bridge 不读取其配置或 Keychain。注册 addons 只覆盖当前私聊、群 @、普通群消息（供按群免 `@` 策略）、图片、CardKit、评论和 Wiki node 路径；普通群消息到达后仍由 Bridge 按 `allowedChats` 和 `mentionOptionalChats` 双重过滤。Meeting 不在范围内。

`profile` scope 的 profile-local model 配置保存 endpoint、API 类型、模型 ID 和输入能力。模型输入默认只有 `text`；仅在 endpoint 与模型均已确认支持图片时才声明 `text,image`。HTTP endpoint 只允许 loopback，远程 endpoint 必须使用 HTTPS。

Pi 兼容性不依赖固定 minor 白名单。preflight 检查最低版本和所需 CLI flags，并在临时 `PI_CODING_AGENT_DIR` 内用随机 loopback mock 验证实际 JSON 协议；RPC profile 还验证 `get_state`、`prompt`、稳定 session identity 和最终 `agent_settled`。

## 8. 安全与信任边界

- 飞书 App Secret 只在 Channel 边界使用，不进入 Pi argv、prompt 或环境；
- Pi 子进程只继承允许的基础环境和非机密 bridge 定位变量；
- 两种 transport 都禁用 approval；Pi extensions、skills、prompt templates 与 context files 按有效 `PI_CODING_AGENT_DIR` 正常加载；
- `read-only` 只是 Pi 工具 allowlist，不是 OS sandbox；
- Web console 是本机管理面，不应通过代理或端口转发对外暴露；
- 日志只记录限长、脱敏字段，不序列化第三方 HTTP request/config/response；
- Meeting ingress 当前不属于产品范围。

完整威胁边界见 [`security.md`](security.md)。

## 9. 依赖与来源

设计调研固定参考 `zarazhangrui/lark-coding-agent-bridge` commit `589868119ce9a0a860aaf4936b5f9bac14e72681`，但实现是 Pi-only 本地改写，没有把上游 package 作为依赖，也没有 cherry-pick 上游 Pi PR。完整映射见 [`provenance.md`](provenance.md)。

Pi 由用户独立安装，不进入本 package 的 runtime dependencies。`@larksuite/channel` 是飞书/Lark 接入依赖；实际兼容性由锁定版本、自动 contract tests 和明确的真实 E2E 边界共同约束，不能从类型声明外推到未测试表面。

## 10. 维护与演进规则

修改架构时至少检查以下不变量：

1. Bridge 保持独立，不把逻辑或状态并入其他 workspace app；
2. `init` 创建新 profile 时默认写入 `rpc`；再次初始化既有 profile 不得被动改变 transport；
3. `agent_settled` 仍是唯一正常完成边界；
4. session 恢复仍绑定 scope、canonical cwd 和 policy fingerprint；
5. 不扩大 prompt replay 边界；
6. 自动测试不连接真实飞书/provider，也不安装真实 service；
7. workspace 配置保持按次读取；其他运行配置只通过显式 refresh 生效；
8. 未知 slash command 不得进入 Pi；
9. update 固定 registry、结构化 argv、全局 npm ownership 与 owned service 边界；
10. 新的用户可见能力同步 README、用户手册及对应技术/安全/验证文档；
11. 新的重大设计取舍用 ADR 记录，不把实施清单长期留作现行架构文档。

## 11. 文档导航

- [`user-guide.md`](user-guide.md)：完整用户手册；
- [`security.md`](security.md)：信任模型、凭据、日志和网络边界；
- [`verification.md`](verification.md)：确定性门禁和真实 E2E 声明边界；
- [`provenance.md`](provenance.md)：受控上游来源与本地改写；
- [`adr-local-control-plane.md`](adr-local-control-plane.md)：Web/CLI/service 决策；
- [`adr-pi-rpc-transport.md`](adr-pi-rpc-transport.md)：RPC、连接池和 fallback 决策。
