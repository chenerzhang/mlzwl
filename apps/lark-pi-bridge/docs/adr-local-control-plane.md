# ADR：本地控制面与跨平台 service

状态：已接受（2026-09-21）

## 背景

Bridge 需要提供 Web/CLI 管理面以及 macOS、Linux、Windows 用户级 service，同时不能把真实凭据、短效授权链接或系统安装副作用带入自动验证。

Meeting 当前明确不在产品范围内；本 ADR 不为 Meeting 保留隐藏 API、配置、addon、权限或测试入口。

## 决策

### Web console/onboarding

- 仅监听 `127.0.0.1`，CLI 不提供非 loopback bind 参数。
- 首次 HTML 响应设置随机、进程内、`HttpOnly`、`SameSite=Strict` session cookie；CSRF token 只放在 HTML meta/header，不放 URL。
- 每个 `/api/*` 请求都检查本机 socket、Host、Origin、`sec-fetch-site`、session cookie 和 CSRF header。
- 所有 mutation 只接受 `application/json`，body 上限 64 KiB，并要求一次性 UUID request ID；重复 ID 返回冲突，缓存有 TTL 和数量上限。
- 页面和 API 只返回非机密 profile 视图、workspace、permissions、model endpoint/status、doctor 结果和本地前台状态；不返回 App Secret、provider key、auth 文件内容、日志正文、registration URL、二维码或第三方请求对象。
- Web 注册入口只展示需要在终端执行的 `init --register` 命令与人工确认说明。device-code URL 保持只存在于相应 CLI 进程内，不跨进程缓存或搬到浏览器。
- Web doctor 默认只做结构、App Secret 私有性和 Pi loopback capability probe；可显式做 provider TCP reachability，但 Web 永不执行真实 credential/model turn。
- 页面使用内嵌、带 CSP nonce 的无依赖 HTML/CSS/JS；不加载 CDN，不部署到外部平台。

### CLI 管理面

- 保留 `doctor`、`model-config`、`model-status`、`paths`；新增 profile 安全状态、profile 激活、workspace alias list/set/remove。
- workspace 写入前必须通过 alias、绝对路径、realpath/directory 校验；配置在跨进程锁内重读并原子私有写入。
- profile/status 输出使用显式 allowlist 生成，不序列化原始配置；只报告 `secretConfigured`，不返回 secret 路径或内容。

### Service 管理

- service definition 只包含绝对 Node/CLI/Pi 路径、bridge home、profile、受限 PATH 和日志路径；不包含 App Secret、provider key、Cookie/JWT 或授权 URL。
- macOS 安装位置固定为 `~/Library/LaunchAgents/ai.x-connect.lark-pi-bridge.<profile>.plist`，使用用户 `gui/<uid>` domain。
- Linux 只使用 `systemctl --user` 与 `~/.config/systemd/user/lark-pi-bridge-<profile>.service`，不调用 sudo/root。
- Windows 使用当前用户 Task Scheduler（`schtasks.exe`、`LIMITED`）及用户数据目录中的生成 launcher；参数由结构化 argv/编码值生成，不拼接 shell 输入。
- definition 带 package-owned marker。已有文件缺少 marker 或 identity 不匹配时拒绝覆盖/删除。
- 安装和修复采用快照、私有临时文件、fsync/rename；后续 manager 命令失败时恢复旧 definition，并执行对应 reload。
- 支持 install/start/status/stop/restart/enable/disable/recover/uninstall。stop 不等于 uninstall；uninstall 清理 definition 和 package 创建的 disabled override。
- 自动测试使用注入的 command runner 和临时 home，只验证 definition、argv、状态解析、幂等与回滚，不调用宿主 launchctl/systemctl/schtasks。
- 真实 service E2E 必须使用事先明确授权的 profile/label，并在结束后恢复 disabled override、删除 definition、卸载 job 并清理进程。没有对应平台实测时只能报告确定性代理验证。

### Meeting

- 不实现或调用 `joinMeeting`、`followMyMeeting`；
- 不声明会议 addon、scope 或 event；
- Web、CLI、schema、service 和测试均不出现会议操作；
- 文档将其标为产品延期，不视为完成阻塞项。

## 后果

- Web onboarding 不等同于“浏览器内完成飞书注册”；这是为了不扩大短效授权 URL 与 App Secret 的暴露面。
- Web 不执行真实模型检查；需要真实 credential 诊断时必须显式运行 CLI `doctor --check-credentials`，并计入真实 turn ledger。
- systemd/Windows 的通过状态只能是实现与代理测试，不能写成真实平台 E2E。
- service definition 会包含本机绝对路径，属于本地运行状态，不进入 npm 包或文档示例的真实值。
