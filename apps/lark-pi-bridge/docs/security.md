# 安全说明

本文定义 `@mlzwl/lark-pi-bridge` 的长期信任边界。具体组件和数据流见 [`tech.md`](tech.md)，验证声明见 [`verification.md`](verification.md)。

## 1. 信任模型

Bridge、Pi 和 Pi 工具都以当前操作系统用户权限运行。Pi project trust 不等于 sandbox；即使使用 `--no-approve`，工具仍可访问该用户可访问的本地资源。

`read-only` 只映射为 Pi 工具 allowlist：

```text
read,grep,find,ls
```

它不是容器、VM、文件系统隔离或强制访问控制。需要强隔离时，应使用独立系统账号、容器、VM 或宿主 OS policy。

## 2. 入口授权

personal profile 按用户、管理员和群 allowlist fail-closed；team profile 是显式放宽入口。群聊默认还要求真实结构化 mention，字面文本 `@名称` 不等价。`mentionOptionalChats` 只能是 `allowedChats` 的子集，且只适用于 personal profile；存在按群例外时，SDK 层会让已授权群的未 mention 消息进入 Bridge，再由 Bridge 按 chat ID fail-closed 过滤，不能把 SDK 的全局 mention 开关当作最终授权边界。

`allowedChats` 是群级授权，不是群成员白名单：被允许群中的当前或未来成员只要满足 mention 策略，就可能触发机器人。免 `@` 群中的所有普通消息均可能成为模型输入，并共享群 scope/session，因此应只对低噪音、成员稳定且明确同意机器处理消息的群开启。群成员变化后应重新审查 allowlist 和免 `@` 例外。平台仍必须向应用投递普通群消息；Bridge 配置不能绕过飞书权限和事件可见性。

文档评论除 API scope 外，还需要目标文档单独授予应用数据权限。评论 scope 与聊天 scope 隔离，并固定使用按次读取的 profile 默认 workspace；不能从评论切换或修改 workspace。聊天中的 workspace 回复只展示 alias，不展示绝对路径。只有 profile `admins` 可从飞书修改默认 alias；未配置管理员时只能本机修改。

同一 OS 用户的相同 App ID 使用 `~/.lark-pi-bridge/runtime/app-locks` 下的固定用户级共享锁，并以 App ID 的 SHA-256 命名；跨 profile、进程和自定义 `--home` 都会互斥。

## 3. Pi 进程边界

两种 transport 都固定使用：

```text
--no-approve
```

Pi packages、extensions、skills、prompt templates、context files 与其他资源会按有效 `PI_CODING_AGENT_DIR` 的原生语义正常加载。`user` scope 使用跨平台 `homedir()/.pi/agent`，因此共享该用户的配置与认证；Bridge CLI/Web 不写这些用户资源，也不传 profile model。用户主动通过 `/pi` 执行的受信任扩展可按其自身语义更新 session/state，这不等于 Bridge 管理面修改用户配置。`profile` scope 使用独立目录。无论 scope 如何，session 目录与 Bridge system prompt 始终 profile-local。Pi 子进程只继承路径、临时目录、locale、必要 Windows shell 变量和非机密 bridge 定位变量；不会继承完整 `process.env`。

飞书 App Secret、常见 provider key、Cookie/JWT、npm token、云凭据和其他宿主 secret 不会自动传入 Pi。用户 prompt 走 stdin 或 RPC command，不进入 argv。

## 4. Transport 与重放边界

新 profile 由 `init` 默认写入 `rpc`，可显式选择 `spawn-per-turn`；再次初始化既有 profile 会保留原 transport，不会被动切换。RPC 只改变 bridge 到本机 Pi 的控制层，不改变 Pi 到 provider 的 HTTP 数据面。

长驻 RPC child 按 scope、canonical cwd、policy fingerprint、model 和 session identity 隔离，pool 有容量、idle TTL、idle-only LRU 和 busy fail-closed 边界。

同一 prompt 只有在 bridge 能证明 Pi 尚未接受时才可 fallback：

- child 创建或握手在写 prompt 前失败；
- Pi 明确返回 `prompt success:false`。

一旦写入开始，write error、response timeout、UI 失败、malformed/未知协议、child death 或断连都属于接受状态不确定，禁止重放，以避免代码操作重复执行。显式 `/pi` 命令不回退到 spawn-per-turn。

RPC stdout 单记录、每次 pooled run 的累计输出、command payload、pending commands、stderr 和 event inbox 都有独立上限。单记录边界需容纳 Pi 官方 `agent_end.messages` 在工具密集型 run 中形成的多 MiB 权威事件；累计 stdout 预算在 `agent_settled` 后按 run 重置，不会因安全复用 child 而永久耗尽。官方 `extension_ui_request` 与 `ui_prompt_start/ui_prompt_end` 先经严格 sideband schema 分流，不进入 translator/inbox；未知 UI method、重复 request ID、畸形字段和越界仍 fail-closed。普通未知/错配 response、非法事件顺序、模型运行缺少 `agent_settled`、未结束工具和 terminal 后普通事件均 fail-closed，并回收 child。

阻塞 UI 使用 Bridge 随机一次性 token，服务端绑定 run、scope、原始 open ID、method、合法选项和期限；action value 不含 Pi request ID、prompt、路径或完整内容。群/话题/评论只私发操作者，错误 actor、伪造、重放、超时、发送失败、中断和 teardown 都取消，confirm 不默认同意。每 run 和全局 pending 有上限。`notify/status/widget` 仅作有界私密展示；`setTitle` 明确忽略，`set_editor_text` 不自动提交。完整 UI 内容和用户输入不进入日志、fingerprint、Web API 或 catalog。

## 5. 凭据与注册

- `init --register` 调用 `@larksuite/channel.registerApp()` 的官方 device-code 流程，需要用户在浏览器/飞书中确认；
- 注册 URL 被视为 opaque string，bridge 不解析或持久化其中内容；
- `lark-cli` 只作为二维码渲染器，bridge 不读取 `~/.lark-cli/config.json` 或 Keychain；
- ASCII 二维码默认只在当前终端显示；显式 PNG 位于 profile 私有 runtime，创建即为 `0600`，注册结束后删除；
- 新 profile 的 App Secret 原子写入 `profiles/<profile>/app-secret`，普通 `config.json` 只保存 bridge-home-relative 引用；
- 运行时拒绝 profile 外路径、symlink、非普通文件、空文件及 group/others 可访问的 secret 文件；

Provider key 可从私有文件导入 profile-local Pi `auth.json`；不进入 bridge argv、普通配置、日志或 `models.json`。

## 6. 协议与能力探测

Pi 兼容性不能只按版本号判断。`validate` / `run` 会：

1. 检查最低版本和实际 CLI flags；
2. 创建临时 `PI_CODING_AGENT_DIR`；
3. 启动只监听随机 `127.0.0.1` 端口的 OpenAI-compatible mock；
4. 用非真实 key 验证 `session` 和最终 `agent_settled`；
5. RPC profile 额外写入临时合成 extension，验证 `get_state`、`get_available_models`、`set_model`、`get_available_thinking_levels`、`set_thinking_level`、`get_commands`、启动期 `setStatus`、阻塞 `confirm` 的取消响应、稳定 session identity，以及最终 `agent_settled` 事件流。

Probe 不读取默认 Pi auth、不连接真实 provider，并移除可能在 Node 启动时触发额外文件读取的 `SSL_CERT_FILE`、`SSL_CERT_DIR` 和 `NODE_EXTRA_CA_CERTS`。

运行时 JSON/RPC 使用严格有界 LF JSONL。malformed JSON、非法 UTF-8、空行、无终止换行、未知记录、非法顺序、未结束工具、单 run 累计越界和 terminal 后普通记录都 fail-closed。`agent_end` 不是完成边界；普通模型运行只有最终 `agent_settled` 能产生正常完成。Pi 明确返回 `handled` 后，Bridge 会经过有界 quiet period 重复确认 idle 且没有普通事件，才把 command 作为无模型 turn 完成，不伪造 `agent_settled`。Pi 1.0.2 不提供“扩展未来绝不会再启动独立工作”的权威边界，因此该无模型完成会销毁对应 child，而不是将其释放回 pool；更晚启动的 fire-and-forget 工作会随 child 关闭而终止，不能泄漏到后续 run。

## 7. 数据、附件与日志

- 私有目录使用 `0700`，敏感文件使用 `0600`；POSIX Pi 子进程使用 `0077` umask；
- catalog/settings 在跨进程锁内重读、合并并私有原子替换；scope settings 只保存 workspace/access/timeout 及非机密 `provider/model`、thinking level，不保存模型定义、endpoint 或凭据；workspace registry/default 和 scope settings 按 ingress 重读，损坏、alias 删除、默认缺失或目录失效均 fail-closed；
- 模型和 thinking RPC 响应只投影 provider、ID、名称、reasoning 与受支持级别；不把 base URL、cost 或其他模型元数据发送到飞书；
- schema v3 配置必须通过严格校验，未知 schema 会被拒绝；
- session retention 默认 active 90 天、archived/orphan 7 天；只在 runtime 空闲边界关闭 idle RPC child 后执行。扫描不跟随 symlink，只解析有界首行 header；重复 ID、损坏或不确定目录状态均保守跳过。catalog 引用先在锁内按 key/session ID/updatedAt 快照删除，文件随后按 inode/mtime/size 复核再删除；手工 apply 使用 profile lock 拒绝运行中并发。512 MiB 是告警阈值，不会触发强制删除未过期 active session；
- 图片只接受 PNG/JPEG/GIF/WebP，规范化 MIME 必须和 magic bytes 一致；
- 图片按 run 保存在 profile-local 私有目录，完成、失败或中断后删除；崩溃残留按年龄和数量有界清理；
- RPC 以 `O_NOFOLLOW` 重开图片并复核普通文件、inode、大小和类型，再发送有数量/总量上限的 base64 object；路径不进入 RPC prompt；
- 模型输入默认 `text`，只有明确声明 `text,image` 时才允许 Pi 继续发送图片；该声明必须与 endpoint/model 的真实能力一致；
- stderr、tool result 和日志都有限长，并对常见密钥字段和 Bearer 值脱敏；
- 本机 Pi RPC 的多 MiB JSONL 输入边界不等于飞书出站授权；飞书官方限制文本请求体最大 150 KB、富文本/卡片请求体最大 30 KB，Bridge 分别使用序列化 `content` 不超过 140,000/28,000 bytes 的保守边界；长 Markdown 以结构感知方式拆分，代码 fence 与表格边界不会直接截断；
- Channel 使用 bridge 自己的安全 logger，不遍历或序列化第三方 HTTP request/config/response，避免 Authorization header 泄漏。

不要把真实 App ID、App Secret、provider key、Cookie/JWT、认证文件、短效 URL 或用户数据写入测试 fixture、文档、issue、聊天或 commit。

## 8. Web 控制面

Web server 固定绑定 `127.0.0.1`，没有非 loopback bind 参数。浏览器 API 同时要求：

- loopback remote 和 Host；
- 同源 Origin/Referer 与 `sec-fetch-site: same-origin`；
- 随机 HttpOnly/SameSite session cookie；
- 独立 CSRF token；
- mutation 使用 64 KiB 内 JSON 和有 TTL/容量限制的一次性 UUID；
- 响应来自显式 allowlist DTO。

页面不接收或返回 App Secret、provider key、auth 路径、日志、二维码、注册链接或第三方 request 对象，不执行真实 credential/model turn，也不加载外部 CDN。不要通过反向代理、端口转发或 hosts 修改把它暴露给其他机器。

## 9. Runtime control、Service 与更新

前台 `run` 使用 profile-exclusive lock 和包含 OS 启动时间的私有 PID 文件。`status` / `stop` 只对身份完全匹配的进程生效，避免 PID 复用误杀；`status` 还通过认证控制通道报告现有 WebSocket 健康状态，但不会建立新连接。停止、timeout 和 shutdown 都有 SIGTERM/SIGKILL 清理路径。

飞书长连接健康探测在连接正常时只读取 SDK 内存状态；仅异常时对配置的飞书 HTTPS 域名做有界 HEAD 探测，以区分断网与 WS 卡死。pong 超时、强制重连和 2 分钟恢复期限都不读取消息正文或凭据。不可恢复时清理后非零退出；跨进程退避状态只保存失败次数/时间，使用 0600 profile 私有文件且最长等待 5 分钟，不保存 endpoint、用户、聊天或消息标识。断线期间不扫描历史消息自动补偿，避免重复执行。

`config refresh` 使用 profile 私有认证控制通道：Unix socket/token 为 0600；Windows 仅绑定 `127.0.0.1` 随机端口并写私有 port/token 文件。服务端有 payload 上限、超时和常量时间 token 比较。refresh 会先停止接收新 ingress，并将 ingress 与 prepare 计入 starting；active/starting 非零时拒绝，不会中断任务。成功时整代销毁旧 channel/adapter/RPC pool，新配置启动失败会恢复旧代。App Secret 与有效 Pi 配置目录中的 settings/models/auth、以及 extensions/skills/prompts/packages 等有界资源元数据只以摘要参与变化检测，不进入控制响应；runtime 未运行时只做本地配置与隔离 Pi capability 验证，不连接飞书或真实模型。

持久 service definition 只保存 Node/CLI/Pi 绝对路径、bridge home、profile、受限 PATH 和日志路径，不包含任何 credential 或注册链接。manager 使用结构化 argv，不启 shell，并通过 package marker 建立 ownership；未知 definition/task 不覆盖、不删除。enabled/running 独立恢复。

自更新使用用户级锁，固定访问公共 npm registry，只安装 exact latest，禁止隐式降级；源码、link 或无法确认全局 npm ownership 的布局一律拒绝。只发现和修改带本包 marker 的 service，保留 home/profile/Pi/PATH 和状态。npm 或 service 恢复失败会明确报告，且不执行猜测式包降级。

自动测试使用注入 runner、临时 home 和确定性 inventory，不访问真实 公共 npm registry，不覆盖全局包，不调用宿主 `launchctl`、`systemctl` 或 `schtasks.exe`。

## 10. 命令边界

解析器拦截所有以 `/` 开头的未知或 malformed 命令，不能把它们当作普通模型 prompt。`/pi commands` 仅返回当前 `get_commands` 的名称、extension/prompt/skill 类型和有界描述，不返回 `sourceInfo` 路径；`/pi /<command>` 只执行该 allowlist 中的原始命令，不开放 `/login`、`/config` 或未列出的 TUI/internal command，并继续受 allowlist、workspace、scope、access、并发和 timeout 约束。`/workspace use default` 只清除 scope override；不会选择名为 `default` 的 alias。远端 workspace 输出禁止包含本地绝对路径。

## 11. 飞书权限边界

注册 addons 只覆盖当前已实现路径：

- 私聊、群 @ 与免 `@` 已授权群的普通消息接收、bot 回复；
- `im:message.group_msg` 用于接收普通群消息；Bridge 仍按 `allowedChats` 与 `mentionOptionalChats` 本地 fail-closed 过滤；
- `im:message:readonly` 与 `im:resource`，用于读取收到消息所带的图片资源；
- 群信息、CardKit；
- 文档评论读取/回复和 Wiki node 解析。

`im:resource` 单独不能授权消息资源下载；不应为方便排错扩大成更宽的消息写权限。Meeting 不在当前范围，不声明相关 addon、scope 或 event。
