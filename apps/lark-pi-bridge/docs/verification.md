# 验证与声明边界

本文定义 `@mlzwl/lark-pi-bridge` 的长期验证入口，以及哪些结论可以由自动测试或真实 E2E 支撑。它不是一次性交付清单；具体测试数量、候选包 hash 和临时测试对象不在这里固化。

## 1. 状态口径

能力状态必须区分：

1. **实现 + 自动验证**：代码存在，并由 unit/process/integration、无凭据 smoke、build 或 pack 覆盖；
2. **实现 + 真实验证**：在用户明确授权的隔离对象上通过真实飞书和/或真实模型流量；
3. **实现、待真实验证**：本地契约存在，但没有对应真实平台证据；
4. **范围外**：当前产品不实现，也不应从其他测试结果外推。

任何自动测试通过都不能替代飞书权限、真实模型、目标操作系统或 service manager 的实际环境验证。

## 2. 确定性门禁

以下命令必须保持确定性：不注册/连接真实飞书，不发送真实模型 prompt，不读取用户默认 Pi/Lark 凭据，不安装持久 service。

```bash
pnpm --filter @mlzwl/lark-pi-bridge verify
pnpm --filter @mlzwl/lark-pi-bridge smoke:local
pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
pnpm verify
```

- `verify`：TypeScript、ESLint、Prettier 和全部 Vitest；
- `smoke:local`：临时 home、fake Pi、随机 loopback mock、CLI/profile/secret/model/transport contract，包括新 `init` 默认 RPC、显式切换 spawn-per-turn 和再次 `init` 保留既有 transport；CLI help 单测另行锁定默认 home 为 `~/.lark-pi-bridge`；
- `config refresh`：运行中覆盖 idle/busy/整代替换/回滚与私有 Secret/model/auth 文件变化；未运行时使用 有效 Pi 配置来源和隔离 Pi capability probe，只报告下次启动生效；
- `pack:dry-run`：通过 `prepack` 从干净 `dist` 构建并审计发布文件边界；
- root `verify`：确认新增 package 没有破坏 monorepo 其他 app。

`probe:pi-json` 是显式诊断命令：它使用临时 `PI_CODING_AGENT_DIR`、非真实 key 和进程内 loopback mock 验证当前 PATH Pi 的 JSON 事件协议，不访问外部 provider。RPC profile 的 `validate` 还运行隔离 RPC probe：在临时 Pi 目录写入合成 extension，验证 `get_commands`、启动期 `setStatus`、blocking `confirm` 的安全取消，并用 `127.0.0.1` mock 验证模型 turn 最终 `agent_settled`；不会读取用户默认 Pi auth/extensions 或真实 provider。

## 3. 自动测试覆盖

### 3.1 Unit

至少覆盖：

- schema v3 的严格解析、显式 `piConfigScope`、权限/transport/model 保留和未知 schema 拒绝；
- workspace canonicalization、default get/set、删除保护、不可用标记、按次读取、policy fingerprint、session catalog 和 scope settings；
- Pi argv、受限环境、最低版本与所需 CLI flags；
- 严格 LF JSONL：malformed、非法 UTF-8、空行、未终止、单行/单 run 累计越界、工具密集型多 MiB `agent_end` 与 pooled run 预算重置；
- 事件 translator：未知/非法顺序/未结束工具/缺少 `agent_settled`/terminal 后记录；
- 应用注册参数、最小 addons、opaque URL、私有 QR 和 App Secret；
- 附件数量/大小/MIME/magic-byte/权限/清理；
- logger 脱敏和第三方 HTTP 对象不遍历；
- 飞书文本/Markdown `content` 的 140,000/28,000-byte 保守边界、Unicode/JSON escaping、代码 fence 闭合重开、表格按行拆分和表头重复；
- Web loopback、Host、Origin/Referer、fetch-site、session/CSRF、body 和 request ID；
- runtime control 的认证、进程/长连接健康状态区分、无 runtime/no-change、active/starting 拒绝、整代重建、RPC dispose 与失败恢复；
- 飞书 Channel 的 20 秒低开销看门狗、pong/握手/REST timeout、2 分钟不可恢复边界，以及跨进程封顶指数退避；
- update 的固定 registry、exact latest、无降级、结构化 argv、安装失败边界和 service 状态恢复；
- CLI help 层级和未知命令非零语义；
- launchd/systemd/Windows definition、ownership、enabled/running 独立状态解析和回滚。

### 3.2 Process

使用 fake Pi 验证：

- prompt 走 stdin、固定安全 flags、环境剥离和 POSIX `0077` umask；
- `agent_settled` 正常完成与未恢复 error/aborted；
- 非零退出、协议失败、SIGTERM/SIGKILL 和无 orphan child；
- RPC handshake、session synth/resume、command correlation、event inbox bounds、工具密集型多 MiB `agent_end` 和长驻 child 多轮累计预算隔离；
- 九种 Extension UI method 的严格 schema、response/UI/agent event 三路分流、`ui_prompt_start/end` 生命周期、无 handler 取消、重复 ID/未知/畸形/越界 fail-closed；
- 一次性卡片 token 的 actor 绑定、伪造/重放拒绝、群聊私发、confirm 往返与停止/teardown 取消；
- `/pi commands` 投影、跨来源重名稳定去重、extension/prompt/skill allowlist、原始命令不包装、unknown/TUI 内建拒绝、handled quiet-period 无模型 turn、延迟独立模型流与 spawn 明确不支持；
- pool reuse、TTL、LRU、busy/full、child death、dispose；
- `/steer`、`/follow-up`、`abort`；
- 只有 prompt 明确未接受时 fallback，写入后不确定失败绝不重放；
- RPC 图片 base64、私有文件重开和 symlink/类型/大小拒绝。

### 3.3 Integration

使用 fake Channel、临时 home 和注入 runner 验证：

- personal/team 入口策略、真实 mention 语义、仅限 `allowedChats` 子集的按群免 `@` 例外和 scope 隔离；
- `/new`、`/resume`、`/status`、`/stop`、`/timeout`、`/access`、`/pi` 与 `/workspace` current/list/use/default；
- 所有未知 slash command 拦截；
- 活动控制命令绕过普通 run 互斥，并发普通 prompt 返回明确的 scope 忙提示而不是 Pi 启动失败；
- 文档评论 scope 与文本回复；
- 同一 App ID 跨 profile/不同 home 的互斥；
- 流式 Markdown 的有界预览/终态 continuation、结构感知 fallback 和明确终态；
- Web console 的默认 alias/unavailable、Pi scope、只读模型状态、refresh-required 说明和本机 runtime refresh；
- user/profile Pi scope 的路径分离、user 模型写入拒绝和新 profile full/full 默认；
- PC Web 在 1280/1440、亮/暗主题下的 CSP、overflow 与 bounding-box 检查；

- workspace/session identity、配置按次读取、scope override 清除、alias 删除/失效及远端路径不泄漏；
- service manager 使用注入 runner，不调用宿主系统工具；
- Channel 生命周期使用 fake connection status/error/reconnecting/reconnected 验证健康投影和不可恢复传播，不连接真实飞书。

## 4. 真实 E2E 基线

初版已在授权的隔离资源上验证以下能力：

- 官方 device-code 注册和既有应用增量更新；
- DM、普通群真实 mention、两个 topic 的 scope/session 隔离；
- 云文档评论、目标文档数据权限和全文评论 fallback；
- session 命令、`/stop`、read-only 工具边界、idle timeout 和前台重启恢复（`/workspace`、schema v3、Pi scope、refresh 与 update 属于自动验证；真实模型仍需单独授权）；
- 错误凭据、401、model-not-found、provider-down 和 malformed SSE 的隔离失败路径；
- macOS launchd 用户级完整 lifecycle；
- RPC child 复用、死亡重建、idle TTL、group/topic 隔离、active abort 和 bridge 重启后的 session 恢复；
- Extension UI 与 `/pi` 的自动验证只覆盖临时 Pi extension、typed fake Channel 和本机隔离 preflight；真实飞书私密卡片交互需单独人工授权验证；
- RPC 图片的真实下载、私有落盘、base64 输入、模型识别、`agent_settled`、飞书回复和终态清理；
- bridge 到 Pi 使用 RPC 时，Pi 到所选 provider 的 HTTP 数据面不变。

这些结论只证明当时明确授权的 app/profile/model/平台路径。后续依赖、Pi、飞书权限或模型变化仍可能要求重新验证。

## 5. 必须单独授权的真实操作

以下操作不得进入普通 test、verify、pre-commit 或 CI：

- `init --register` 或更新真实飞书应用；
- `run` 并连接真实飞书；
- `doctor --check-credentials` 或任何真实模型 turn；
- 创建/修改真实群、文档协作者、权限和事件；
- 安装、启动、修改或卸载真实 launchd/systemd/Task Scheduler service；
- 真实 `lark-pi-bridge update`、公共 npm 查询/全局安装、npm publish、Git tag 或 release 分支操作。

真实 E2E 应事先确定 app/profile、workspace、provider/model、流量预算、可修改资源和清理边界；完成后按 sender/content、session/process 和消息 ID 等证据核验，而不能只看 UI 是否出现回复。

## 6. 不能外推的边界

- Meeting ingress 不在当前产品范围；没有实现、权限或测试；
- Linux systemd 和 Windows Task Scheduler 当前只有实现与注入 runner 的确定性代理验证，不能声称真实平台 E2E；
- 图片的真实模型验收覆盖显式 RPC；spawn-per-turn 图片路径只有自动 contract/process 证据；
- `read-only` 是 Pi 工具 allowlist，不是 OS sandbox；
- macOS 公共 tooling 可能把原本 absent 的 launchd disabled override 留成语义等价的显式 enabled；验证只要求 job/definition 清理和启用语义恢复，不编辑私有 root-owned 数据库；
- API scope 不等于文档数据权限；文档评论必须另行授予目标文档访问权；
- 模型配置中的 `text,image` 是显式能力声明，不代表任意 endpoint/model 自动支持图片。

## 7. 变更后的最小回归

| 变更类型                        | 至少执行                                                          |
| ------------------------------- | ----------------------------------------------------------------- |
| 文档或 package metadata         | `format:check`、`pack:dry-run`、`git diff --check`                |
| 配置/CLI/Web/service/update     | package `verify` + `smoke:local`                                  |
| 协议/transport/session/附件     | package `verify` + `smoke:local` + 对应 process/integration tests |
| workspace/root 配置             | 再加 root `pnpm verify`                                           |
| 用户可见行为                    | 同步 README、`user-guide.md`、`tech.md` 和安全/验证文档           |
| 真实权限/provider/platform 结论 | 自动门禁通过后，另行取得真实 E2E 授权                             |

验证结束必须清理临时 server、fake credential、媒体目录、PID/锁、mock、bridge/Pi child 和已授权 service 状态。
