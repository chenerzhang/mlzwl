# lark-pi-bridge 维护约定

本文件适用于 `apps/lark-pi-bridge/**`，补充仓库根目录 `AGENTS.md`。

## 产品与安全边界

- 本包是独立的 Pi coding-agent 飞书/Lark bridge，不是模型网关。
- Bridge 必须保持独立，不得依赖其他 workspace app，也不得复用其他 app 的 daemon、配置、状态、锁或日志。
- 新 profile 由 `init` 默认写入 `rpc`，可显式选择 `spawn-per-turn`；再次初始化既有 profile 必须保留原 transport。RPC fallback 只能重放可证明尚未被 Pi 接受的 prompt。
- `agent_settled` 是普通模型运行的唯一正常完成边界；`agent_end` 不是终态。Pi 官方 `agent_end.messages` 在工具密集型 run 中可形成多 MiB 单条 JSONL；单条边界必须有界但足以接受这类权威事件，累计 stdout 预算必须按 pooled run 隔离，不能跨长驻 child 生命周期永久累加。RPC extension command 被 Pi 明确返回 `handled` 后，Bridge 会保留一个有界 quiet period 观察延迟启动的独立流；观察期持续 idle 且没有普通事件时，才可作为无模型 turn 正常完成，并销毁而不回池复用该 child。未知、malformed、越界、非法顺序、未结束工具和 terminal 后普通协议记录必须 fail-closed。
- RPC 的 `extension_ui_request`/`extension_ui_response` 是独立 sideband，不得进入普通 `PiJsonTranslator` 或 agent event queue。select/confirm/input/editor 必须经绑定原始操作者的一次性私密交互响应；无法确认时只允许取消，绝不默认同意。
- 只允许通过 `/pi commands` 发现和通过 `/pi /<command> [args]` 执行当前 `get_commands` 返回的 extension/prompt/skill command；未知裸 slash、TUI 内建登录/配置命令继续拒绝，Pi 原始命令不得套 Bridge prompt wrapper。
- 普通同-scope run 并发互斥；并发普通 prompt 必须明确提示已有活动运行以及 `/stop`、`/steer`、`/follow-up`，不能误报成 Pi 启动失败；这些控制命令必须直接走活动运行控制路径，不能排在普通 run 队列后。
- 群聊默认要求真实 mention；按群免 `@` 例外只能用于 personal profile、必须是 `allowedChats` 子集，并在 Bridge handler 中按 chat ID fail-closed 执行。SDK 全局 mention gate 仅可在存在例外时关闭，不能因此让其他已授权群的未 mention 消息进入 Pi。
- 飞书官方限制为文本请求体 150 KB、富文本/卡片请求体 30 KB；Bridge 分别使用序列化 `content` 不超过 140,000/28,000 bytes 的保守边界。超长 Markdown 回复必须结构感知拆分，优先保留段落/行，代码 fence 闭合重开，表格按行拆分并重复表头，不能静默截断。该边界不得替代或降低本机 Pi RPC 为合法多 MiB `agent_end.messages` 保留的独立 JSONL 上限。
- `read-only` 只能映射为 `read,grep,find,ls`，文档中不得把它描述为 OS sandbox。
- schema v3 的 `piConfigScope=user` 使用 `homedir()/.pi/agent` 作为 Bridge 管理面只读配置来源，并按 Pi 原生语义加载认证、packages、extensions、skills、prompt templates 等资源；`profile` 使用独立配置。session 与 Bridge prompt 永远 profile-local；任何 CLI/Web 都不得写用户 Pi 目录。用户显式触发的 Pi 扩展自身行为不等同于 Bridge 管理面写配置。
- 新 profile 权限默认 `full/full`，但仍须明确说明 full 使用运行用户权限、不是 OS sandbox。
- Meeting ingress 当前不在产品范围。除非产品范围另行批准，不得添加 Meeting addon、scope、event、API、CLI、Web、service 或测试入口。
- Web 控制面必须保持 loopback-only，并继续执行 Host、Origin/Referer、fetch-site、session cookie、CSRF、JSON body size 和一次性 request ID 校验；不得显示或接收 App Secret、provider key、auth 文件、日志、二维码或注册链接。
- 普通 build/test/verify/smoke 不得触发真实飞书注册或连接、真实模型调用、真实公共 npm 查询/安装、外部部署或持久 service 安装；update 必须通过注入 runner、临时 home 和确定性 service inventory 测试。

## 用户文档同步

- 本地完整用户手册是 `docs/user-guide.md`，按私聊、群聊、话题、云文档评论、slash command、workspace、Web 控制面、CLI 和持久 service 分章维护；统一使用 workspace 术语，不再使用 project 指代该配置概念。
- `docs/tech.md` 是权威架构文档；重大设计取舍分别记录在 `docs/adr-local-control-plane.md` 和 `docs/adr-pi-rpc-transport.md`。不要再创建阶段性实施计划、完成清单或与这两份文档重复的架构/运维文档。
- README 的“完整使用手册”部分必须链接 GitHub 中的 `docs/user-guide.md`。发布和维护流程不得依赖或同步仓库外文档，所有用户文档以 README 与仓库 `docs/` 为准。
- 后续任何新增、删除或改变用户可见能力时，必须在同一个变更中同步更新：
  1. `docs/user-guide.md`；
  2. `README.md` 中相关摘要或入口；
  3. `docs/tech.md`、`docs/security.md`、`docs/verification.md` 中受影响的架构契约、安全边界或验证边界。
- 需要同步的用户可见变化包括但不限于：聊天或评论入口、slash command、scope/session 语义、workspace 定位方式、权限与 transport、模型/图片能力、Web 字段和操作、CLI 参数、service 生命周期、平台支持、错误提示及安全限制。
- 不得把 App ID、chat/message/comment/session ID、真实本地用户名路径、App Secret、provider key、Cookie/JWT、认证文件内容或短效授权 URL 写入公开用户手册。

## 实现与测试

- 保持 TypeScript strict、NodeNext/ESM 和内部 `.js` 引用。
- 协议、命令、scope、附件、Web 或 service 行为变化应优先补充现有 `tests/unit`、`tests/process` 或 `tests/integration`，不要把真实 E2E 藏进自动测试。
- 改动后至少运行：

```bash
pnpm --filter @mlzwl/lark-pi-bridge verify
pnpm --filter @mlzwl/lark-pi-bridge smoke:local
pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
```

- 涉及 root 配置、workspace 依赖或公共文档时，再运行 `pnpm verify`。
- 启动前台 bridge、浏览器 helper、mock、Pi child 或 service 的验证结束后必须清理进程、PID、锁、media、runtime 和临时日志。
- Linux/Windows 若只有注入 runner 测试，文档必须写“实现 + 代理验证”，不能声称真实平台 E2E。

## 发布文件边界

发布包只应包含运行 bundle、类型声明、README、LICENSE、THIRD_PARTY_NOTICES 和 package metadata。`docs/`、测试、`.tmp/`、本地 session、日志、media、runtime、二维码和候选 tarball 不得进入发布包。
