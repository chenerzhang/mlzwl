# lark-pi-bridge 完整使用说明

本文面向使用和维护 `@mlzwl/lark-pi-bridge` 的开发者，说明如何把飞书/Lark 中的私聊、群聊、话题和云文档评论连接到本机 Pi coding agent，并通过 CLI、Web 控制面或用户级 service 管理运行状态。

`lark-pi-bridge` 是本地 coding-agent 控制面，不是模型网关。它负责飞书入口、scope/session、工作目录、权限和 Pi 子进程；模型由所选 Pi 配置来源连接。新 profile 默认以 Bridge 管理面只读方式共享用户 `~/.pi/agent`，也可切换到 profile-local 配置；这里的“只读”只描述 Bridge 不写用户 Pi 配置，并不把默认 `full` 工具权限降为 read-only。它不会启动、安装或修改 `x-connect`。

## 1. 能力总览

| 模块                | 已提供能力                                                                               | 关键边界                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 飞书私聊            | 文本问答、连续 session、图片、slash command、流式卡片回复                                | personal 模式下发送者必须在用户或管理员 allowlist                                                |
| 普通群聊            | 真实 `@机器人` 后触发、群级 session、图片、slash command                                 | personal 模式下群须在 chat allowlist；普通文本里的 `@名称` 不等于结构化 mention                  |
| 话题群              | 按 `chat + thread` 隔离 session，在话题内回复                                            | 不同话题不会共享 session；命令也只影响当前话题                                                   |
| 云文档评论          | 处理被 `@` 的评论、引用文本、评论内连续 session 和控制命令                               | 应用必须另有目标文档的数据权限；固定使用 profile 默认 workspace；不支持评论图片或 workspace 命令 |
| 本地 workspace 开发 | 默认 workspace、命名 workspace、按聊天切换目录、read-only/full 权限                      | workspace 必须是已存在的绝对目录；read-only 不是 OS sandbox                                      |
| Pi transport        | 新 profile 默认 RPC、连接池、`steer`、`follow-up` 与 RPC 图片；可显式改用 spawn-per-turn | RPC 失败后仅在能证明 prompt 尚未被接受时才回退，不能保证每种故障都自动重试                       |
| Web 控制面          | profile 查看/激活、Pi scope、workspace、权限、transport、model、doctor、前台状态         | 只监听 `127.0.0.1`；user scope 模型只读；不接收密钥、不执行真实模型 turn、不安装 service         |
| CLI 管理            | 注册、初始化、检查、模型、profile、workspace、前台进程和持久 service                     | 真实注册、真实 credential 检查和 `run` 会产生外部交互，不能放进普通 CI                           |
| 用户级 service      | macOS launchd、Linux systemd user、Windows 当前用户 Task Scheduler                       | macOS 已真实验证；Linux/Windows 当前为实现与自动代理验证                                         |

当前不提供 Meeting ingress，也不把 `read-only` 宣称为容器、虚拟机或操作系统级隔离。

## 2. 核心概念

**Profile。** 一个 profile 绑定一个飞书/Lark 应用、入口 allowlist、默认和命名 workspace、访问权限、Pi transport、Pi 配置来源，以及始终独立的 session 数据。默认数据目录为 `~/.lark-pi-bridge`，也可用全局参数 `--home <path>` 指定其他目录。

**Workspace。** workspace 是 Pi 执行工具时的本地工作目录。每个 profile 有命名 alias registry，并可用 `defaultAlias` 指向其中一个 alias；简单本地配置也可使用与其互斥的 `defaultPath`。聊天中只展示和选择 alias，绝不展示或接受任意本地路径。配置在每条消息、评论及 workspace 命令前从磁盘重读，不使用文件 watcher。

**Scope。** scope 决定命令、workspace、权限和 session 的作用范围。私聊和普通群按 chat 隔离，话题按 `chat + thread` 隔离，文档评论按目标文档与 comment 隔离。

**Session。** 普通消息会自动恢复当前 scope、canonical workspace 和权限策略对应的 Pi session。`/new` 会归档当前 session；下一条普通消息创建新 session。`/resume` 只检查当前上下文是否存在可恢复 session，不接受 session ID 参数，也不把已归档 session 重新激活。默认自动保留 active session 90 天、archived 和 catalog 无引用的 orphan session 各 7 天；按 catalog `updatedAt` 与文件 mtime 的较新值计算。

**Access mode。** `read-only` 只向 Pi 开放 `read,grep,find,ls`；`full` 使用 Pi 的默认工具集合。scope 只能在 profile 的 `maxAccess` 上限内选择。

**Pi 配置来源。** `user` 使用 `~/.pi/agent` 中的 settings、认证、extensions、skills、prompts 与 packages，新 profile 默认如此；Bridge 管理面不修改这些用户资源，也不传 profile model。`profile` 使用 `profiles/<profile>/pi-agent` 的独立配置，可由 `model-config` 管理。两种模式的 session 目录与 Bridge prompt 均始终 profile-local。

**Transport。** 新 profile 由 `init` 默认写入 `rpc`，维护有容量和空闲 TTL 的长驻 Pi 子进程，适合连续对话、运行中控制、Pi 命令和图片对象传输。可显式选择 `spawn-per-turn`，让每个请求启动一个 `pi --mode json` 子进程并在结束后退出；上下文仍通过 Pi session 恢复。再次 `init` 既有 profile 会保留原 transport。

## 3. 从零开始：把飞书连接到一个本地 workspace

### 3.1 安装 CLI

要求 Node.js `>=22.19.0`。Pi 和可选的 `lark-cli` 从公共 npm 安装；bridge 已配置为发布到公共 npm，但当前尚未完成首次公开发布。先安装 Pi；如果要使用推荐的 `init --register` 扫码注册，再安装 `lark-cli`：

```bash
npm install --global @earendil-works/pi-coding-agent@latest

# 仅 init --register 需要；手工导入 App ID/App Secret 时可跳过
npm install --global @larksuite/cli@latest
```

首次公开发布完成后，可直接全局安装 bridge；安装公开包不需要登录：

```bash
npm install --global @mlzwl/lark-pi-bridge@latest
```

若 npm 返回 `E404`，表示首次公开发布尚未完成；可先使用下方源码开发方式。

检查所有需要的命令都来自当前 Node 环境：

```bash
node --version
pi --version
lark-cli version # 未安装可选 lark-cli 时跳过
lark-pi-bridge --version
lark-pi-bridge --help
```

若使用 nvm、fnm 等 Node 版本管理器，全局 CLI 通常安装在当前 Node 版本下；切换 Node 后可能需要重新安装，持久 service 也应重新执行 `service install`，以记录新的绝对 Node/CLI/Pi 路径。

在 monorepo 中开发时，不需要全局安装 bridge。先安装 workspace 依赖并构建，再为当前终端设置别名：

```bash
cd /absolute/path/to/mlzwl
pnpm install
pnpm --filter @mlzwl/lark-pi-bridge build
alias lark-pi-bridge='node /absolute/path/to/mlzwl/apps/lark-pi-bridge/dist/cli.js'
lark-pi-bridge --help
```

### 3.2 注册应用并绑定默认 workspace

推荐使用官方 device-code 注册。以下命令会产生真实平台操作，并要求用户在浏览器或飞书中确认：

```bash
lark-pi-bridge init \
  --register --create-only \
  --profile default \
  --workspace /Users/example/code/my-project \
  --workspace-alias api=/Users/example/code/my-project/services/api \
  --access full \
  --max-access full
```

默认在终端显示 ASCII 二维码。若要增量更新一个明确的已有应用，改用：

```bash
lark-pi-bridge init \
  --register --existing-app cli_xxx \
  --profile default \
  --workspace /Users/example/code/my-project
```

也可手工导入 App ID 和只允许当前用户读取的 App Secret 文件：

```bash
lark-pi-bridge init \
  --profile default \
  --app-id cli_xxx \
  --app-secret-file /Users/example/.config/lark-pi-bridge/app-secret \
  --allow-user ou_xxx \
  --workspace /Users/example/code/my-project
```

不要把 App Secret 直接放进命令行、仓库、聊天或日志。初始化完成后，secret 会保存到 profile-local `0600` 文件，普通配置只保留相对引用。`init --workspace` 会建立 direct default；推荐随后用 `workspace set` 注册命名 alias 并执行 `workspace default set <alias>`。

### 3.3 配置模型

默认 `user` scope 会跟随本机 Pi 的 defaultProvider/defaultModel/defaultThinkingLevel。只有需要独立配置时，先运行 `lark-pi-bridge profile pi-config-scope set profile --profile default`。下面示例连接一个 profile-local OpenAI Responses 兼容服务：

```bash
lark-pi-bridge model-config \
  --profile default \
  --provider local \
  --model coding-model \
  --base-url http://127.0.0.1:10010/v1 \
  --api openai-responses \
  --input text \
  --api-key-file /Users/example/.config/lark-pi-bridge/provider-key
```

`--input` 默认是 `text`。只有确认 endpoint 和具体模型支持图片时，才使用：

```bash
lark-pi-bridge model-config \
  --profile default \
  --provider local \
  --model vision-model \
  --base-url http://127.0.0.1:10010/v1 \
  --api openai-responses \
  --input text,image
```

HTTP endpoint 只允许 loopback；远程 endpoint 必须使用 HTTPS。Bridge 不负责启动对应模型服务。

### 3.4 校验并启动

```bash
# 不连接飞书、不调用真实 provider；使用本机 loopback mock 验证 Pi 协议
lark-pi-bridge validate --profile default

# 只检查配置中 provider endpoint 的 TCP 可达性
lark-pi-bridge doctor --profile default --check-provider

# 前台连接真实飞书
lark-pi-bridge run --profile default
```

`doctor --check-credentials` 会执行一次真实模型 turn，应只在明确允许真实流量时使用。

### 3.5 在飞书中定位并开发本地 workspace

先在本机注册命名 alias，再显式设置 profile 默认 alias：

```bash
lark-pi-bridge workspace set shop-web /Users/example/code/shop/web --profile default
lark-pi-bridge workspace set shop-api /Users/example/code/shop/api --profile default
lark-pi-bridge workspace default set shop-web --profile default
lark-pi-bridge workspace default get --profile default
lark-pi-bridge workspace list --profile default
```

然后在目标私聊、群或话题中发送：

```text
/workspace current
/workspace use shop-web
/status
/access read-only
请先阅读 package.json 和 src 目录，说明登录页的数据流，不要修改文件。
```

确认分析无误且 profile 的 `maxAccess` 允许 `full` 后，可切换为修改模式：

```text
/access full
请修复登录按钮重复提交问题，沿用 workspace 现有测试习惯；完成后运行相关测试并总结改动。
```

切换到另一个 workspace，或重新跟随默认值：

```text
/workspace use shop-api
请定位订单创建接口并说明参数校验链路。
/workspace use default
```

`/workspace use default` 清除当前 scope 的显式覆盖，此后持续跟随 profile 默认 alias。切换后，后续消息使用目标 canonical cwd 和独立 session identity；alias 路径变化会形成新 identity，切回原路径可恢复原 identity 对应的 session。alias 被删除、默认缺失或目录不可用都会明确失败，不会回退到其他目录。

## 4. 聊天模块

### 4.1 私聊

personal profile 默认拒绝未授权用户。扫码注册返回用户身份时，会自动把扫码用户加入 DM allowlist；手工初始化则应通过 `--allow-user` 或 `--admin` 配置。

私聊中的普通文本会进入当前 chat scope。只要 workspace 和权限策略没有变化，后续消息会自动恢复同一 Pi session。例如：

```text
请阅读这个 workspace 的构建脚本，告诉我本地验证入口。
```

下一条可以直接追问：

```text
刚才提到的 verify 和 smoke 有什么区别？
```

### 4.2 普通群聊

personal profile 下，群需要先进入 `allowedChats`；默认还要求真实的结构化 `@机器人`。仅输入字面文本 `@Pi` 不能代替飞书 mention。

可为某个已授权群增加免 `@` 例外；其他群继续要求 mention：

```bash
lark-pi-bridge profile mention-optional add oc_xxx --profile default
lark-pi-bridge config refresh --profile default
```

查看或撤销：

```bash
lark-pi-bridge profile mention-optional list --profile default
lark-pi-bridge profile mention-optional remove oc_xxx --profile default
lark-pi-bridge config refresh --profile default
```

本地 Web 控制台也可从已授权群下拉框中设置。免 `@` 只支持 personal profile，目标 chat ID 必须已在 `allowedChats`；开启后该群全部普通消息都可能触发 Pi，群内成员共享同一 scope/session。应用还必须具有 `im:message.group_msg` 并能收到普通群消息；对既有应用可在本机执行 `lark-pi-bridge init --register --existing-app <App ID>` 走人工扫码增量授权。若平台只投递群 `@` 消息，本地例外无法绕过平台授权。

群聊示例：

```text
@Pi 请检查当前 workspace 最近一次修改涉及哪些模块，只做只读分析。
```

普通群拥有独立于私聊的 session。群中的所有可触发成员共享该群 scope，因此不要在不适合共享上下文的群里配置机器人。

### 4.3 话题群

话题按 `chatId + threadId` 隔离。请在具体话题内 `@机器人` 并继续回复该话题；机器人也会在对应 thread 中回复。

例如，话题 A 可以定位前端 workspace，话题 B 可以定位后端 workspace：

```text
# 话题 A
@Pi /workspace use shop-web
@Pi 请分析登录页。

# 话题 B
@Pi /workspace use shop-api
@Pi 请分析订单接口。
```

两个话题的 workspace 设置、access、timeout 和 Pi session 彼此独立。

### 4.4 图片

聊天消息支持 PNG、JPEG、GIF、WebP，最多 4 张、每张最多 10 MiB。MIME 与文件 magic bytes 必须一致。附件只在 profile-local 私有 run 目录短暂落盘，运行结束、失败或中断后删除。

图片能否到达模型还取决于模型能力声明。若模型确实支持图片，应先配置 `--input text,image`。RPC 会把复核后的图片转换成有界 base64 image object；spawn-per-turn 使用受控的 Pi `@file` 输入。

示例：

```text
请根据这张报错截图定位可能的前端模块，先不要改代码。
```

文档评论入口当前不接收图片附件。

### 4.5 回复与运行状态

机器人优先使用流式 Markdown 卡片；实时卡片只保留有界预览，结束时先写入一个结构完整的 Markdown 分片，剩余长回复再按顺序发送为后续 Markdown 消息。飞书官方限制文本请求体最大 150 KB、富文本/卡片请求体最大 30 KB；Bridge 计算序列化后的 `content`，分别使用不超过 140,000/28,000 bytes 的保守边界。超过后自动拆分：优先选择段落、标题或完整行边界，代码块会在边界处闭合并在下一条重开，表格只在行间拆分并重复表头。若单个表格行自身已超限，则降级为保留完整内容的代码块分片，不会静默截断。卡片流失败时使用同一拆分规则回退；运行失败、中断、超时和正常但无文本都有明确终态。

这些限制是聊天出站消息边界，与本机 Pi RPC 为容纳官方多 MiB `agent_end.messages` 而保留的有界 JSONL 单记录上限无关。云文档评论使用不同 API，仍保留单条 12,000 字符的有界回复。

同一 scope 同时只允许一个普通 run。忙时不会悄悄排队或合并普通消息，并明确提示“当前话题已有 Pi 运行”；可等待完成，或使用 `/stop`、`/steer`、`/follow-up` 这些可绕过普通提交路径的活动运行控制。

## 5. 聊天 slash command

命令应作为消息主体发送；参数中的 workspace 必须是已配置 alias。

| 命令                             | 作用                                | 是否启动新 Pi turn | 作用范围与说明                                                    |
| -------------------------------- | ----------------------------------- | ------------------ | ----------------------------------------------------------------- |
| `/new`                           | 归档当前上下文对应的 session        | 否                 | 下一条普通消息创建新 session                                      |
| `/resume`                        | 检查当前上下文是否有可恢复 session  | 否                 | 普通消息本来就会自动恢复；不接受 session ID                       |
| `/status`                        | 显示当前 Pi session、模型和思考级别 | 否                 | 尚无 session 时明确提示                                           |
| `/model` / `current`             | 显示当前 session 模型与思考级别     | 否                 | 仅 RPC；不会创建空 session                                        |
| `/model list`                    | 列出当前 Pi 配置可用模型            | 否                 | 仅 RPC；标记当前模型与 thinking 能力                              |
| `/model use <provider>/<model>`  | 切换当前 Pi session 模型            | 否                 | 仅 RPC；须先有 session；按 scope 持久化，模型必须由 Pi 列为可用   |
| `/thinking` / `current`          | 显示当前思考级别                    | 否                 | 仅 RPC；同时显示当前模型                                          |
| `/thinking list`                 | 列出当前模型支持的思考级别          | 否                 | 仅 RPC；标记当前级别                                              |
| `/thinking <level>`              | 切换当前 Pi session 思考级别        | 否                 | 仅 RPC 且须先有 session；级别需当前模型支持                       |
| `/stop`                          | 请求停止当前活动 run                | 否                 | spawn 模式终止 child；RPC 优先发送 `abort`，必要时销毁 child      |
| `/timeout <分钟>`                | 设置 idle timeout                   | 否                 | 允许 1–1440 分钟，按当前 scope 持久化                             |
| `/workspace` / `current`         | 显示当前有效 alias 与来源           | 否                 | 不显示本机绝对路径                                                |
| `/workspace list`                | 稳定列出 alias 与状态               | 否                 | 标记 current/default/unavailable                                  |
| `/workspace use <alias>`         | 显式选择当前 scope workspace        | 否                 | alias 必须存在且目录可用                                          |
| `/workspace use default`         | 清除 scope 覆盖并跟随 profile 默认  | 否                 | 默认缺失或不可用时明确报错                                        |
| `/workspace default get`         | 查看 profile 默认值                 | 否                 | direct default 只说明状态，不显示路径                             |
| `/workspace default set <alias>` | 修改 profile 默认 alias             | 否                 | 仅 `access.admins`；无管理员时只能用本机 CLI                      |
| `/access read-only`              | 将当前 scope 切到只读工具集         | 否                 | 总是受 profile `maxAccess` 约束                                   |
| `/access full`                   | 将当前 scope 切到完整工具集         | 否                 | `maxAccess=read-only` 时明确拒绝                                  |
| `/steer <指令>`                  | 在当前活跃 RPC run 中追加实时引导   | 否                 | 仅 RPC 且当前 scope 有活动 run；不会复制成普通 prompt             |
| `/follow-up <指令>`              | 将后续指令交给当前活跃 RPC run      | 否                 | 仅 RPC；也支持 `/followup` 写法                                   |
| `/pi commands`                   | 列出 Pi 当前公开的可调用命令        | 否                 | 仅 RPC；只显示名称、来源类型和有界描述，不显示资源路径            |
| `/pi /<command> [args]`          | 原样执行一条已公开 Pi 命令          | 视命令而定         | 仅 extension/prompt/skill；继续受当前 scope/workspace/access 约束 |

典型 session 操作：

```text
/status
/new
请重新从 workspace 入口分析，不沿用上一轮结论。
/status
```

典型模型和思考级别控制（RPC）：

```text
/model list
/model use anthropic/claude-sonnet-4
/thinking list
/thinking high
/status
```

模型和思考级别选择属于当前聊天 scope 的既有 Pi session；切换前须先发送普通消息创建 session。Bridge 重启或 RPC child 重建后会恢复；`/new`、`/workspace use ...` 或 `/access ...` 改变 session 身份时会清除选择，新 session 重新采用 Pi/profile 默认值。`/model list` 只列出 Pi 判断当前配置与认证可用的聊天模型，不是全量模型目录。spawn-per-turn 会明确拒绝这些命令，不会模拟 RPC 状态。

典型运行控制：

```text
/timeout 10
/access full
请重构这个模块并运行测试。
```

若任务方向需要即时修正，RPC 模式下可在 run 仍活跃时发送：

```text
/steer 不要修改公共 API，优先做最小修复。
```

如果要停止：

```text
/stop
```

RPC profile 可显式调用用户 Pi 暴露的命令：

```text
/pi commands
/pi /plan 为当前 workspace 制定最小改动计划
/pi /goal 修复测试并给出验证证据
```

Bridge 会在执行前重新查询 Pi 的 `get_commands`；只有其中标记为 extension、prompt template 或 skill 的命令能执行。`/pi ` 后的文本会原样发送给 Pi，不套普通消息的 Bridge XML wrapper。`/login`、`/config` 等未公开 TUI/internal 命令、未知裸 `/xxx`、普通文本和空命令都会被拒绝。spawn-per-turn 不支持 `/pi`，不会静默切换 transport。

Pi 扩展在 RPC 中请求 select、confirm、input 或 editor 时，Bridge 会生成一次性卡片。私聊在当前会话显示；群聊和话题只向原始操作者私发完整交互，原群最多出现等待私聊提示。token 绑定原操作者、run、scope、方法、选项和有效期；错误用户、伪造、重放、超时及超长输入均拒绝。发送失败、`/stop`、断连或 Bridge 关闭时自动取消，confirm 绝不默认同意。notify/status/widget 以有界私密消息显示；setTitle 不处理；set_editor_text 只说明有建议文本，绝不自动提交或执行。Pi 的 TUI-only `custom` 等能力仍按 RPC 官方降级语义处理。

## 6. 云文档评论模块

Bridge 监听被机器人 mention 的云文档评论事件。使用前需同时满足两类授权：

1. 应用拥有评论读取/创建和 Wiki node 解析等 API scope；
2. 目标文档本身已把该应用添加为文档协作者或文档应用。

只有 API scope 而没有目标文档数据权限时，机器人不能读取该文档评论。

### 6.1 使用方式

在文档中选中一段文字并添加评论，然后在评论里真实 `@机器人`：

```text
@Pi 请对照本地 workspace 检查这段接口说明是否与实现一致，并指出文件位置。
```

Bridge 会把评论引用文本与评论回复文本组成输入，并在同一评论下回复。若飞书不允许对全文评论做 thread reply，SDK 会新建顶层全文评论作为 fallback。

每个 comment 是独立 scope。同一 comment 后续被触发时可以延续对应 Pi session，不会与私聊、群聊或其他评论共享 session。

### 6.2 文档评论中的命令

文档评论支持以下独立命令：

- `/new`
- `/resume`
- `/status`
- RPC 的 `/model [current|list|use <provider>/<model>]`
- RPC 的 `/thinking [current|list|<level>]`
- `/stop`
- `/timeout <分钟>`
- `/access read-only|full`
- RPC 活动运行中的 `/steer <指令>`
- RPC 活动运行中的 `/follow-up <指令>` 或 `/followup <指令>`
- RPC 的 `/pi commands` 与 `/pi /<command> [args]`

命令只有在 bridge 归一化后的评论输入以 slash command 开头且没有其他正文时才会识别。对选中文字创建的评论会同时带入引用文本，因此更适合提交普通分析任务；若要使用纯控制命令，优先新建不引用正文的顶层全文评论。

文档评论**不支持任何 `/workspace` 切换或默认值修改命令**，始终按次读取并使用 profile 默认 workspace；相关命令会返回明确说明。`/pi` 仍使用该 comment scope，但阻塞 UI 会私发原始评论操作者，不把确认内容或输入回显到文档。如果某份文档需要对应另一个本地 workspace，建议创建单独 profile并设置默认 alias。评论入口目前不读取整份云文档正文，只使用事件提供的引用和评论文本。

## 7. 本地 Web 控制面

启动：

```bash
lark-pi-bridge web --port 10019
```

如果不传 `--port`，会选择随机可用端口并在终端打印 URL。服务固定绑定 `127.0.0.1`，不能通过 CLI 改成公网地址。

### 7.1 页面提供的功能

**状态。** 查看 active profile、profile 数量和本地前台 `run` 的 PID 状态；页面不会自动连接飞书。

**Profile。** 查看非机密 profile 信息并切换 active profile。Web 不能创建 profile，首次初始化或注册仍需 CLI。

**Workspace。** 新增/更新命名 alias、设置默认 alias，或删除非默认 alias。路径必须是本机已存在的绝对目录并保存 canonical realpath；页面标记 default/unavailable。Web 没有聊天 scope，不展示伪造的“当前 scope workspace”。

**权限与 transport。** 配置 `defaultAccess`、`maxAccess`，以及 `spawn-per-turn`/`rpc`。保存后页面提示需要 runtime refresh；点击“刷新运行时配置”会调用 profile 私有本机控制通道，仅在无 active/starting run 时整代重建 channel、policy 与 adapter。workspace 配置无需 refresh。

**Pi 配置来源。** 可在 user/profile 间切换；session 与 Bridge prompt 始终 profile-local。user scope 的 Provider / Model 只读展示新 session 将跟随的 Pi 默认 provider/model/thinking，并由后端拒绝写入；profile scope 才显示模型编辑表单。Web 不接收 API key。

**Doctor。** “安全 doctor”检查配置、私有 App Secret 和本机 Pi capability；“检查 provider TCP”额外检查 endpoint 可达性，但仍不执行真实 credential/model turn。

**注册与服务提示。** 页面只给出终端命令说明，不显示注册链接、二维码、日志或 secret，也不安装/启停 service。

### 7.2 Web 安全边界

浏览器 API 会检查 loopback socket、Host、同源 Origin/Referer、`sec-fetch-site`、随机 HttpOnly session cookie、CSRF token、JSON Content-Type、64 KiB body 上限和一次性 request ID。页面使用内嵌静态资源和 CSP nonce，不连接 CDN。

因此，不要通过反向代理、端口转发或修改 hosts 的方式把控制面暴露给其他机器；它设计为本机管理界面。

## 8. CLI 管理能力

### 8.1 Profile 与路径

```bash
lark-pi-bridge profile list
lark-pi-bridge profile status default
lark-pi-bridge profile activate default
lark-pi-bridge profile transport --profile default
lark-pi-bridge profile transport rpc --profile default
lark-pi-bridge profile transport spawn-per-turn --profile default
lark-pi-bridge profile session-retention get --profile default
lark-pi-bridge profile session-retention set --profile default \
  --active-days 90 --archived-days 7 --orphan-days 7
lark-pi-bridge profile mention-optional list --profile default
lark-pi-bridge profile mention-optional add oc_xxx --profile default
lark-pi-bridge profile mention-optional remove oc_xxx --profile default
lark-pi-bridge paths --profile default
```

`profile status` 和 Web 只输出 allowlist DTO，例如 App ID、是否已配置 secret、workspace、权限、transport、session retention 和非机密模型状态；不输出 App Secret、API key 或 auth 文件内容。retention 可用 `--enabled false` 关闭；active 保留期允许 7–3650 天，archived/orphan 允许 1–365 天，修改后执行 `config refresh`。

### 8.2 Session 保留与清理

```bash
# 默认 dry-run，只显示分类计数和空间统计
lark-pi-bridge sessions prune --profile default

# 实际删除；对应 profile runtime 必须已停止
lark-pi-bridge sessions prune --profile default --apply
```

Runtime 启动时执行一次清理，之后每 24 小时在无 active/starting run 和 ingress 时尝试；忙时跳过到下一轮。执行前关闭空闲 RPC child，不停止活动任务。超过 512 MiB 只记录 warning，不为了配额删除未到期 active session。损坏 header、重复 session ID、symlink 或扫描结果不确定时保守跳过；手工 `--apply` 通过 profile lock 拒绝与运行中 runtime 并发。

### 8.3 Workspace 与运行时刷新

```bash
lark-pi-bridge workspace list --profile default
lark-pi-bridge workspace set main /absolute/path/to/main-workspace --profile default
lark-pi-bridge workspace set frontend /absolute/path/to/frontend --profile default
lark-pi-bridge workspace default set main --profile default
lark-pi-bridge workspace default get --profile default
lark-pi-bridge workspace remove frontend --profile default

lark-pi-bridge config refresh --profile default
```

alias 只能使用字母、数字、点、下划线和连字符，最长 64 个字符；`default` 是保留控制词，不能注册为 alias。删除当前默认 alias 会被拒绝。`init` 缺省 profile 仍是 `default`；其他带 profile 的命令省略 `--profile` 时使用 active profile。

`config refresh` 只刷新非 workspace 运行配置；runtime 未运行时仅验证 profile、App Secret、profile-local model/Pi 配置并提示下次启动生效，不会连接飞书或真实模型。workspace 本身每次使用前都会从磁盘重读。

### 8.4 模型与诊断

```bash
lark-pi-bridge model-status --profile default
lark-pi-bridge validate --profile default
lark-pi-bridge doctor --profile default
lark-pi-bridge doctor --profile default --check-provider
lark-pi-bridge doctor --profile default --check-credentials
```

`validate` 和默认 `doctor` 不访问真实 provider。`--check-provider` 只做网络可达性检查；`--check-credentials` 才会执行真实模型 turn。

### 8.5 前台进程

```bash
lark-pi-bridge run --profile default
lark-pi-bridge status --profile default
lark-pi-bridge stop --profile default
```

`status` 校验 PID 与 OS 启动时间身份，并通过现有 profile 私有控制通道同时报告 `runtime.health`（`ready/degraded/failed`）、WebSocket `channel.state`、最近连接时间、重连次数和最近入站时间；它不会为诊断新建飞书连接。`stop` 只管理由 `run` 创建的本地前台 PID，避免误伤 PID 复用后的无关进程。不要同时为同一 profile 启动前台和持久 service。

## 9. 持久 service

安装必须显式传入 Pi 的绝对路径：

```bash
PI_BIN="$(command -v pi)"
lark-pi-bridge service install --profile default --pi-bin "$PI_BIN"
lark-pi-bridge service bootstrap --profile default
lark-pi-bridge service status --profile default
```

日常管理：

```bash
lark-pi-bridge service start --profile default
lark-pi-bridge service restart --profile default
lark-pi-bridge service stop --profile default
lark-pi-bridge service disable --profile default
lark-pi-bridge service enable --profile default
lark-pi-bridge service recover --profile default
lark-pi-bridge service uninstall --profile default
```

平台对应关系：

| 平台    | 用户级机制                                                           | 说明                                   |
| ------- | -------------------------------------------------------------------- | -------------------------------------- |
| macOS   | `~/Library/LaunchAgents/ai.x-connect.lark-pi-bridge.<profile>.plist` | 使用当前用户 launchd domain            |
| Linux   | `~/.config/systemd/user/lark-pi-bridge-<profile>.service`            | 只调用 `systemctl --user`，不需要 root |
| Windows | 当前用户 Task Scheduler                                              | 使用受限任务和 profile 私有 launcher   |

Service definition 只包含 Node/CLI/Pi 绝对路径、bridge home、profile、受限 PATH 和日志路径，不包含 App Secret 或模型密钥。管理器拒绝覆盖不带 package ownership marker 的已有定义。

Bridge 每 20 秒读取一次本地 WebSocket 状态；健康连接不会因此额外访问网络。SDK 的 pong 超时与三次异常去抖会先尝试强制重连；重连连续超过 2 分钟或强制恢复失败时，runtime 会退出并交给持久 service 重启。为避免断网期间形成高频进程循环，连续连接失败会跨进程采用 `5 秒、15 秒、45 秒、2 分钟、5 分钟` 的封顶退避；连接稳定 2 分钟后清除旧失败级别。

## 10. 自更新

首次公开发布完成后，后续版本提供唯一入口：

```bash
lark-pi-bridge update
```

它固定查询公共 npm registry 的 `@mlzwl/lark-pi-bridge@latest`，只接受可确认的全局 npm 安装，不支持指定目标版本或隐式降级。需要更新时，会检查 owned runtime 无 active/starting run，保留每个 owned service 的 home、profile、Pi、PATH、enabled/disabled 与 running/stopped 状态；然后安装精确 latest、重建需要更新的 service definition，并恢复原状态。版本无变化时不做无意义重启。

首次公开发布前，公共 registry 不存在该包，`update` 无法解析 latest；此时使用源码开发方式。首次公开安装完成后，后续版本才能直接使用 `lark-pi-bridge update`。更新失败不会自动执行不可靠的包降级；应按结构化阶段结果处理 package 或 service 阻塞。

## 11. 权限、数据与安全建议

- 新 profile 默认 `full/full`；这意味着 Pi 可使用运行用户的完整工具能力，部署前应按实际风险显式降为 `read-only`。
- `read-only` 是 Pi 工具 allowlist，不是 OS sandbox。高风险仓库应在独立系统账号、容器或 VM 中运行。
- `user` scope 共享用户 `~/.pi/agent` 的配置、认证、extensions 与 skills，但 Bridge 管理面只读；`profile` scope 使用独立 `PI_CODING_AGENT_DIR`。两者的 session 和 Bridge prompt 都不会跨 profile 共享。
- Pi 子进程只继承受限环境 allowlist；飞书 secret、常见 provider token、Cookie/JWT、npm token和云凭据不会自动传入。
- App Secret、session catalog、scope settings、模型 auth 和日志保存在 profile 私有目录；敏感文件使用 `0600`，目录使用 `0700`。过期 session 删除会先在 catalog 锁内移除仍与扫描快照一致的引用，再删除经 inode/mtime/size 复核的普通 `.jsonl` 文件；失败最多留下下次可清理的 orphan。
- personal 模式建议只开放必要的用户和群。`allowedChats` 是整个群级授权，不是群成员白名单；群成员变化后应重新审查。
- 同一 OS 用户下，同一 App ID 不能被多个 profile、不同 home 或不同 bridge 进程同时占用。
- RPC 的自动 fallback 只覆盖“可证明 prompt 未被接受”的故障。写入后超时、断连、协议错误或 child death 都不会自动重放，以避免重复改代码。
- 不要在普通 `test`、`verify`、pre-commit 或 CI 中调用 `init --register`、`run`、`doctor --check-credentials` 或 service 安装命令。

## 12. 常见问题

### 群里 `@Pi` 没反应

请确认使用的是飞书真实 mention，而不是纯文本；同时检查 personal profile 的 `allowedChats`、应用可用范围、事件订阅和群消息权限。

### `/workspace use` 提示 alias 不存在或 unavailable

先在本机通过 CLI 或 Web 注册 alias，并确认目标是已存在的绝对目录：

```bash
lark-pi-bridge workspace set workspace /absolute/path/to/workspace --profile default
lark-pi-bridge workspace default set workspace --profile default
```

然后在对应聊天或话题发送 `/workspace use workspace`。文档评论固定使用 profile 默认 workspace。

### `/access full` 被拒绝

当前 profile 的 `maxAccess` 仍是 `read-only`。应由本机管理员在初始化或 Web 控制面中明确提高上限；不要通过修改聊天文本绕过。

### 图片到了 bridge，但模型说看不到

检查模型状态中的 input 是否为 `text,image`，并确认 endpoint 和具体模型确实支持图片。另需确保应用具有 `im:message:readonly` 和 `im:resource`。

### RPC 控制命令不可用

检查 profile transport 是否是 `rpc`，并确认当前 scope 正有活动 run。`/steer` 和 `/follow-up` 不会启动新任务。

### 修改了 Web 配置但运行行为没变化

workspace 会在下一条消息立即生效。transport、模型、入口策略和权限等非 workspace 配置需要运行 `config refresh --profile <name>`，或点击 Web 的“刷新运行时配置”；有 active/starting run 时会拒绝，等运行结束后重试。

### 文档评论没有回复

确认评论中真实 mention 了机器人、发送者符合入口策略、应用具有评论 API scope，并且目标文档已单独授予该应用协作者/文档应用权限。

## 13. 能力边界

当前明确不包括：Meeting ingress、浏览器内注册、Web 密钥录入、Web 真实模型 turn、任意远程 Web bind、OS sandbox、跨 provider fallback，以及由 bridge 自动启动或管理 `x-connect`。

Linux systemd 和 Windows Task Scheduler 已实现并有确定性代理测试，但尚不能表述为对应平台真实 E2E。图片的真实环境验收覆盖显式 RPC 路径；spawn-per-turn 图片链路有自动 contract/process 验证。

更深入的维护资料见：

- [`tech.md`](tech.md)：技术架构、数据流和状态归属；
- [`security.md`](security.md)：信任、凭据、网络和进程边界；
- [`verification.md`](verification.md)：确定性门禁与真实 E2E 声明边界；
- [`provenance.md`](provenance.md)：受控来源和本地改写。
