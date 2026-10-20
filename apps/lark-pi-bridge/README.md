# lark-pi-bridge

`@mlzwl/lark-pi-bridge` 将飞书/Lark 的消息桥接到本机 [Pi coding agent](https://github.com/badlogic/pi-mono)。它是独立的 control-plane app，不是模型网关，也不依赖其他 workspace app。新 profile 由 `init` 默认使用长驻 `rpc`，支持连接复用、`/steer`、`/follow-up`、Pi 命令与 RPC 图片传输；也可显式选择每次请求一个 Pi 子进程的 `spawn-per-turn`。

## 完整使用手册

按私聊、群聊、话题、云文档评论、slash command、workspace、Web 控制面、CLI 和持久 service 分章说明的完整手册：

- [GitHub 源文档](https://github.com/chenerzhang/mlzwl/blob/master/apps/lark-pi-bridge/docs/user-guide.md)

发布包不包含仓库的 `docs/` 目录，因此安装后的完整手册请使用 GitHub 源文档；README 保留安装、配置和安全要点。所有用户文档均在本仓库维护。

## 前提

- Node.js `>=22.19.0`
- PATH 中已安装 Pi（最低版本 `0.85.1`）；bridge 会检查实际 CLI 参数，并通过仅监听 `127.0.0.1` 的隔离 mock model 验证 `session` / `agent_settled` JSON 协议，不固定 Pi minor 版本。
- 使用 `init --register` 扫码注册时需要安装 `lark-cli`。手工导入 App ID/App Secret 时不需要它。Bridge 不读取或复用 `lark-cli` 的配置/Keychain；`lark-cli` 仅用于把官方注册 URL 原样生成二维码。

## 安装与本地配置

`@mlzwl/lark-pi-bridge` 已配置为发布到公共 npm registry，但当前尚未完成首次公开发布。先安装 Pi；如需扫码注册，再安装 `lark-cli`：

```bash
npm install --global @earendil-works/pi-coding-agent@latest

# 仅 init --register 需要
npm install --global @larksuite/cli@latest
```

首次公开发布完成后，可直接从公共 npm registry 全局安装 bridge；安装公开包不需要登录：

```bash
npm install --global @mlzwl/lark-pi-bridge@latest
```

若 npm 返回 `E404`，表示首次公开发布尚未完成；可先使用源码开发方式，见 GitHub 仓库根目录 README。

检查安装结果：

```bash
node --version
pi --version
lark-cli version # 未安装可选 lark-cli 时跳过
lark-pi-bridge --version
lark-pi-bridge --help
```

默认数据目录是 `~/.lark-pi-bridge`。推荐通过官方 device-code 流程创建或选择应用，不需要手工粘贴 App ID/App Secret：

```bash
# 发起真实平台注册；命令会显示原始链接和由 lark-cli 生成的终端二维码，
# 并等待你在浏览器/飞书中确认。下面只展示命令，不会被 test/verify/smoke 自动执行。
lark-pi-bridge init --register --profile default \
  --workspace /absolute/path/to/project \
  --workspace-alias api=/absolute/path/to/api-project

# 更安全：只允许创建新应用，避免修改已有应用配置
lark-pi-bridge init --register --create-only --profile default \
  --workspace /absolute/path/to/project

# 明确更新已有应用：确认页会展示增量权限/事件变更
lark-pi-bridge init --register --existing-app cli_xxx --profile default \
  --workspace /absolute/path/to/project
```

默认 `--qr-format ascii` 会在当前终端直接展示二维码；人工 CLI 如需文件，可显式用 `--qr-format png`，bridge 会输出私有临时 PNG 路径并在注册结束后删除。注册确认会请求 bridge 实际使用的私聊、群 @、按群免 `@` 所需普通群消息、资源、CardKit、评论和 Wiki node 最小能力。其中免 `@` 需要 `im:message.group_msg`；下载收到消息中的图片需要只读消息权限 `im:message:readonly`，`im:resource` 单独不足以调用消息资源下载接口。个人模式会把扫码用户的 `open_id` 自动加入 DM allowlist。若注册结果没有返回扫码用户身份，则仍需显式传 `--allow-user`、`--admin` 或 `--allow-chat`，否则保持 fail-closed。

仍可手工导入凭据，但 App Secret 只能从本地文件读取，不能放进 argv：

```bash
lark-pi-bridge init --profile default --app-id cli_xxx \
  --app-secret-file ~/.config/lark-pi-bridge/app-secret \
  --allow-user ou_xxx --workspace /absolute/path/to/project
```

新 profile 的普通 `config.json` 只保存 bridge-home-relative `secretFile` 引用；secret 会原子写入 `profiles/<profile>/app-secret`，权限为 `0600`。运行时拒绝指向 profile 外、符号链接或权限过宽的 secret 文件。再次 `init` 既有 profile 时，未显式传入的模型、transport、workspace、allowlist 与 permissions 会保留，适合只更新应用权限或凭据。不要将真实 App Secret、Pi/provider token、Cookie 或 JWT 提交到仓库、聊天消息或日志。

新 profile 默认 `piConfigScope=user`：Pi 通过用户目录 `~/.pi/agent` 读取 settings、认证、extensions、skills、prompts 与 packages；Bridge 管理面只读使用这些资源，不修改其内容，也不传入 profile 的 model 覆盖。`profile` scope 则继续使用 `profiles/<profile>/pi-agent` 作为独立 `PI_CODING_AGENT_DIR`，并允许 `model-config` 管理 profile-local endpoint/model。两种 scope 下，session 目录和 Bridge system prompt 都始终保存在 profile-local `pi-agent/` 内。Bridge 不启动或配置 `x-connect`。默认 `validate` 不连接真实 provider；`doctor --check-provider` 与显式 `doctor --check-credentials` 分别检查 endpoint 可达性和真实模型。

配置形态示例（schema v3）：

```json
{
  "schemaVersion": 3,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "schemaVersion": 3,
      "agentKind": "pi",
      "mode": "personal",
      "accounts": {
        "app": {
          "id": "cli_xxx",
          "secretFile": "profiles/default/app-secret",
          "tenant": "feishu"
        }
      },
      "access": {
        "allowedUsers": ["ou_xxx"],
        "allowedChats": [],
        "admins": ["ou_xxx"],
        "requireMentionInGroup": true
      },
      "workspaces": {
        "defaultAlias": "main",
        "named": {
          "main": "/absolute/path/to/project",
          "api": "/absolute/path/to/api-project"
        }
      },
      "permissions": { "defaultAccess": "full", "maxAccess": "full" },
      "preferences": {
        "piConfigScope": "user",
        "transport": "rpc",
        "sessionRetention": {
          "enabled": true,
          "activeDays": 90,
          "archivedDays": 7,
          "orphanDays": 7
        }
      }
    }
  }
}
```

## CLI

```bash
# 不连接飞书或真实模型：检查配置、Node、当前 Pi CLI 与隔离回环 JSON 协议
lark-pi-bridge validate --profile default
# 可选：显式选择不在 PATH 中的 Pi binary
lark-pi-bridge validate --profile default --pi-bin /absolute/path/to/pi

# 仅 profile scope 可配置 profile-local provider/model；HTTP 只允许 loopback
lark-pi-bridge model-config --profile default \
  --provider local --model my-model \
  --base-url http://127.0.0.1:12345/v1 --api openai-responses \
  --input text
# 只有 endpoint/model 已确认接受图片时才改为：--input text,image
lark-pi-bridge model-status --profile default

# 分层诊断；默认不访问 provider，以下选项逐级产生网络/真实模型调用
lark-pi-bridge doctor --profile default
lark-pi-bridge doctor --profile default --check-provider
lark-pi-bridge doctor --profile default --check-credentials

# 查看/激活 profile，以及管理经 realpath 校验的 workspace alias
lark-pi-bridge profile list
lark-pi-bridge profile status default
lark-pi-bridge profile activate default
lark-pi-bridge profile pi-config-scope get --profile default
lark-pi-bridge profile pi-config-scope set user --profile default
# 查看或显式切换 transport；新 profile 默认 rpc
lark-pi-bridge profile transport --profile default
lark-pi-bridge profile transport rpc --profile default
lark-pi-bridge profile transport spawn-per-turn --profile default
# session 默认 active 保留 90 天，archived/orphan 保留 7 天；修改后刷新 runtime
lark-pi-bridge profile session-retention get --profile default
lark-pi-bridge profile session-retention set --profile default \
  --active-days 90 --archived-days 7 --orphan-days 7
# 默认 dry-run；--apply 要求对应 profile runtime 已停止
lark-pi-bridge sessions prune --profile default
lark-pi-bridge sessions prune --profile default --apply
# 为 allowedChats 中的单个群开启/撤销免 @ 触发；修改后刷新 runtime
lark-pi-bridge profile mention-optional list --profile default
lark-pi-bridge profile mention-optional add oc_xxx --profile default
lark-pi-bridge profile mention-optional remove oc_xxx --profile default
lark-pi-bridge config refresh --profile default
lark-pi-bridge workspace list --profile default
lark-pi-bridge workspace set project /absolute/path/to/project --profile default
lark-pi-bridge workspace default set project --profile default
lark-pi-bridge workspace default get --profile default
lark-pi-bridge workspace remove old-project --profile default

# 非 workspace 配置改动后刷新空闲 runtime
lark-pi-bridge config refresh --profile default

# 首次公开发布后的后续版本可一体化自更新；固定使用公共 npm latest，并恢复 owned service 状态
lark-pi-bridge update

# 仅监听 127.0.0.1 的本地 Web 控制台；页面不接收密钥或执行真实模型检查
lark-pi-bridge web --port 10019

# 前台启动真实飞书连接
lark-pi-bridge run --profile default

# 查询本地进程及现有飞书长连接健康状态，或停止本地前台运行
lark-pi-bridge status --profile default
lark-pi-bridge stop --profile default

# 管理当前用户的持久 service；install 要求明确的绝对 Pi binary 路径
lark-pi-bridge service install --profile default --pi-bin /absolute/path/to/pi
lark-pi-bridge service bootstrap --profile default
lark-pi-bridge service start --profile default
lark-pi-bridge service status --profile default
lark-pi-bridge service stop --profile default
lark-pi-bridge service restart --profile default
lark-pi-bridge service disable --profile default
lark-pi-bridge service enable --profile default
lark-pi-bridge service recover --profile default
lark-pi-bridge service uninstall --profile default

# 仅生成不安装、不加载的 macOS inert manifest
lark-pi-bridge service-manifest --profile default
```

可通过 `--home <path>` 指定独立数据目录。除 `init` 默认 profile 为 `default` 外，所有省略 `--profile` 的 profile 命令都使用 active profile。handoff 的 `/status` 只显示 source cwd 的目录 basename；根目录等无 basename 情况显示固定“已验证”，不显示 session 文件名或绝对路径。机器人优先流式回复；飞书官方限制文本请求体最大 150 KB、富文本/卡片请求体最大 30 KB，Bridge 分别按序列化 `content` 不超过 140,000/28,000 bytes 的保守边界发送。长 Markdown 会自动拆分，代码块在分片边界闭合/重开，表格按行拆分并重复表头；这些出站边界不会替代本机 Pi RPC 的独立协议上限。Lark 消息中支持 `/handoff <exact-session-id>|off`、`/new`、`/resume`、`/status`、`/stop`、`/timeout <分钟>`、`/workspace` 命令族和 `/access read-only|full`；同一话题已有普通运行时会明确提示等待或使用活动控制，不会误报为 Pi 启动失败。RPC transport 还支持 `/model [current|list|use <provider>/<model>]`、`/thinking [current|list|<level>]`，用于查看或切换当前聊天 scope 的 Pi session 模型与思考级别；`/status` 会同时显示 session、模型和思考级别。已有 session 的选择会在 Bridge 重启或 RPC child 重建后恢复；切换前须先发送普通消息创建 session。`/new`、workspace 或 access 切换会清除选择，让新 session 重新使用 Pi/profile 默认值。RPC 还支持只作用于当前活跃运行的 `/steer <指令>` 与 `/follow-up <指令>`（也支持 `/followup`），以及 `/pi commands` 查看当前 Pi 公开的 extension/prompt/skill command、`/pi /<command> [args]` 原样执行其中一条命令。personal profile 可通过 `profile mention-optional add <oc_chat_id>` 为已授权的单个群设置免 `@` 例外，其他群仍要求真实 mention；修改后需执行 `config refresh`。Pi 扩展的 select/confirm/input/editor 会通过绑定发起人的一次性飞书卡片交互处理；群聊、话题和评论场景将交互私发操作者。所有未知 slash command、未由 `get_commands` 公开的 Pi 命令和 TUI 内建登录/配置命令都由 bridge 拒绝。workspace registry/default 会在每条消息、评论和 workspace 命令前从磁盘重读；其他运行配置通过 `config refresh` 在无 active/starting run 时整代重建。文档评论固定使用 profile 默认 workspace，不允许切换。

## 平台说明

普通 Bridge 功能可在支持的平台使用；Windows 因 Node 缺少与 `O_NOFOLLOW` 等价的可靠文件语义，`/handoff` 会安全拒绝（fail-closed），不影响普通消息与管理能力。

## 安全提示

- 新 profile 默认 `user` scope 与 `full/full`。`user` scope 直接共享用户 Pi 的配置、认证、packages、extensions、skills、prompt templates 和其他原生资源，但 Bridge CLI/Web 管理面不写 `~/.pi/agent`；用户主动执行公开 Pi 扩展命令时，扩展自身的受信任行为仍按 Pi 语义运行。`profile` scope 使用独立配置目录。两种 scope 的 session 与 Bridge prompt 始终 profile-local。
- `validate` 的协议探测使用新建临时 Pi profile、非真实 key 和进程内 `127.0.0.1` 随机端口 mock；不会读取默认 Pi auth，也不会访问 provider。为避免自定义 CA 变量在进程启动前触发文件读取，probe 还会移除 `SSL_CERT_FILE`、`SSL_CERT_DIR` 与 `NODE_EXTRA_CA_CERTS`。
- 普通运行两种 transport 都固定使用 `--no-approve`。显式 `/handoff` 是唯一例外：Bridge 先在用户默认 sessions、用户 settings 可推导的 sessionDir 与当前 profile sessions 这些有界可信 roots 中精确定位完整 ID，再用 Pi 原生 `--fork` 创建不同 ID 的 profile-local fork；source 不续写、不修改、不同步。handoff 固定 source cwd、用户 Pi config、完整工具和 `--approve`，会绕过 workspace 与 profile access 上限，因此可执行项目资源及运行用户有权访问的 OS 资源。
- RPC 只改变 bridge 与本机 Pi 的控制协议，Pi 到所选 provider（包括用户自行配置的 `x-connect`）仍使用原有模型 HTTP 数据面。
- RPC Extension UI 是与普通 agent event 隔离的 sideband：严格校验 Pi 官方九种请求；阻塞交互使用随机一次性 token 并绑定 run/scope/原始 open ID，发送失败、超时、中断、断连或关闭一律安全取消，confirm 从不默认同意。`notify/status/widget` 只做有界私密展示，`setTitle` 忽略，`set_editor_text` 只提示建议文本而不自动执行。
- RPC fallback 仅在 prompt 确定尚未被接受（例如握手前失败或 `prompt success:false`）时才允许重放到 spawn-per-turn；写入后超时、断连、子进程退出、UI 故障或 malformed protocol 均禁止重放，以免重复执行。spawn-per-turn 不支持 `/model`、`/thinking`、`/pi` 或阻塞 Extension UI。
- `read-only` 仅把 Pi 工具限制为 `read,grep,find,ls`；它**不是**容器、虚拟机或操作系统 sandbox。`full` 使用运行用户的完整本机权限。handoff 总在新建或当前话题内建立 `chatId:threadId` binding；话题参与者共享上下文与上述权限。`/handoff off` 归档但不删除 fork 并恢复普通路由，handoff 中 `/new` 仅归档当前 fork并保留 handoff 策略，显式 `/workspace use ...` 会退出 handoff。自定义 session root 只有能由用户 Pi settings 推导时才会被搜索。
- Pi 子进程使用受限环境变量 allowlist；bridge 飞书密钥、常见 provider token、npm token 与云凭据不会自动传递。
- 当前支持 DM、普通群 @、topic、被 @ 的文档评论、session 命令、`/stop`、本地 Web 管理面，以及 macOS launchd、Linux systemd user 和 Windows 当前用户 Task Scheduler 管理。Web 只监听 `127.0.0.1`，不会显示或接收 App Secret/provider key，也不会执行真实 credential/model turn；平台注册始终回到本机终端完成。
- 持久 service definition 只写绝对 Node/CLI/Pi 路径、bridge home、profile、受限 PATH 和日志路径；安装时拒绝覆盖不带本 package ownership marker 的定义。Linux/Windows 使用用户级服务，不要求 root。
- 飞书长连接使用每 20 秒一次的低开销状态看门狗（连接正常时仅做内存读取），并启用 pong 超时；重连超过 2 分钟或强制恢复失败时进程退出，由持久 service 拉起。连续连接故障采用持久化的 `5s → 15s → 45s → 2m → 5m` 封顶退避；`status` 同时区分进程存活与 `ready/degraded/failed`，并报告最近连接、重连次数和最近入站时间。
- `config refresh` 使用 profile 私有、认证的本机控制通道；runtime 运行时只在无 active/starting run 时重建 channel、policy 与 adapter，并释放旧 RPC pool；fingerprint 只保存 App Secret 和有效 Pi settings/models/auth/资源元数据的摘要，不泄露内容。runtime 未运行时只做本地验证。
- `update` 只支持可确认的全局 npm ownership，固定查询公共 npm registry，使用结构化 argv、用户级锁和 exact latest；它不隐式降级，也不触碰无 ownership marker 的 service。首次公开发布前该命令无法从公共 registry 解析包；发布后才可用于后续版本更新。
- Meeting ingress 当前不在产品范围内。
- Pi session 默认按最后使用时间保留：active 90 天，`/new` 后的 archived 与 catalog 无引用的 orphan 各 7 天。runtime 启动和此后每日只在无 active/starting/ingress 时关闭空闲 RPC child 后清理；异常、重复 ID、symlink 或无法确认的文件只告警不删除，超过 512 MiB 只告警而不强删未过期 active session。`sessions prune` 默认 dry-run，`--apply` 要求 runtime 已停止。
- 图片使用 run-owned 私有目录；完成/失败/中断后删除，崩溃残留按 24 小时和最多 32 个 run 的界限在启动时清理。RPC 会安全重开并复核文件，再发送有数量/大小上限的 base64 `ImageContent`；spawn-per-turn 继续使用受控 `@file` 参数。自定义模型默认声明为仅文本；只有上游 endpoint/model 已确认支持图片时才使用 `model-config --input text,image`，否则 Pi 会按其模型能力声明省略图片。完整验证边界见[源码仓库验证说明](https://github.com/chenerzhang/mlzwl/blob/master/apps/lark-pi-bridge/docs/verification.md)。

完整使用说明见 [GitHub 源文档](https://github.com/chenerzhang/mlzwl/blob/master/apps/lark-pi-bridge/docs/user-guide.md)。维护者可查阅源码仓库中的[技术架构](https://github.com/chenerzhang/mlzwl/blob/master/apps/lark-pi-bridge/docs/tech.md)、[安全说明](https://github.com/chenerzhang/mlzwl/blob/master/apps/lark-pi-bridge/docs/security.md)、[验证边界](https://github.com/chenerzhang/mlzwl/blob/master/apps/lark-pi-bridge/docs/verification.md)和[来源说明](https://github.com/chenerzhang/mlzwl/blob/master/apps/lark-pi-bridge/docs/provenance.md)；仓库 `docs/` 不进入发布包。

## Changelog

<!-- npm-release:start -->

### [0.1.4] - 2026-10-20

#### Added

- 新增 `/handoff <exact-session-id>` 与 `/handoff off`：使用 Pi 原生 fork 将受信任的本机 session 接力到权威飞书话题，并支持重启恢复、`/new`、workspace、模型、思考级别和 Pi 命令的准确路由。

#### Security

- handoff 仅在有界可信 roots 中精确定位无 symlink 的 session，复核 source 文件身份并只回滚本次 owned fork；topic binding 使用 profile 私有原子状态，聊天与生产日志不暴露本机绝对路径。
- handoff 明确使用用户 Pi 配置、full tools 与 `--approve`，普通路由继续使用 `--no-approve`；RPC session 核对和不确定 prompt 禁止重放边界保持不变。

### [0.1.3] - 2026-10-16

#### Added

- 新增可配置的 Pi session 自动保留策略：active 默认保留 90 天，archived 和 orphan 默认保留 7 天；runtime 会在启动和每日空闲时保守清理。
- 新增 `sessions prune` dry-run/apply CLI，以及 session retention 的 profile 配置命令和存储空间告警。

#### Security

- 清理仅处理可验证的普通 session 文件；异常 header、symlink、重复 ID 和不确定扫描结果会跳过，并通过 catalog 快照匹配及文件身份复核避免并发误删。

### [0.1.2] - 2026-10-16

#### Added

- 支持在飞书聊天和云文档评论中通过 `/model` 与 `/thinking` 查看或切换当前 Pi session 的模型和思考级别，并在 `/status` 中展示当前选择。
- 按聊天 scope 持久化模型与思考级别，在 Bridge 重启或 RPC child 重建后恢复；创建新 session、切换 workspace 或 access 时安全回到 Pi/profile 默认值。

### [0.1.1] - 2026-10-13

#### Changed

- 将 `@larksuite/channel` 更新为公开稳定版本 `0.7.1`，确保通过公共 npm registry 安装时可以完整解析生产依赖。

### [0.1.0] - 2026-10-13

#### Added

- 提供独立的 Pi coding-agent 飞书/Lark bridge，支持私聊、群聊、话题、云文档评论、图片输入、按 scope 隔离的 session、命名 workspace、权限与命令。
- 提供默认长驻 RPC 与可选 spawn-per-turn transport、运行中控制、Pi 命令、Extension UI 私密交互、本地 CLI/Web 控制面，以及 macOS、Linux 和 Windows 用户级 service 管理。
- 提供固定公共 npm registry 的安全自更新，保留 owned service 的启用与运行状态。

#### Security

- 使用 profile 私有凭据和状态、严格有界协议、`agent_settled` 完成边界、loopback-only Web、私有附件生命周期与 fail-closed 入口策略。
- RPC 仅在可证明 prompt 尚未被 Pi 接受时回退，避免不确定故障导致重复执行。

<!-- npm-release:end -->
