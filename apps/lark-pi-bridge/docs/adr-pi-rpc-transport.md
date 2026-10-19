# ADR：Pi RPC transport

## 状态

Accepted，2026-09-21；默认值决策于 2026-10-08 修订。

## 背景

Bridge 需要在 spawn-per-turn `pi --mode json` 之外支持长驻 Pi，但该选择只能改变 bridge 与本机 Pi 子进程之间的控制协议；Pi 到 provider 的 HTTP 数据面不变。公共 0.1.0 将 RPC 作为 `init` 创建新 profile 的默认值，同时保留 spawn-per-turn 供显式选择。再次初始化既有 profile 不会被动切换 transport。

Pi 官方 RPC 契约提供长驻子进程、`prompt`/`steer`/`follow_up`/`abort`、图片 `ImageContent[]` 和 `agent_settled` 终态。兼容性始终以所选 binary 的实际 capability probe 为准，不固定 Pi minor。

## 决策

### 1. transport 配置

- profile `preferences.transport` 只接受 `spawn-per-turn` 或 `rpc`。
- `init` 创建新 profile 时默认写入 `rpc`；显式 `--transport spawn-per-turn` 可覆盖。再次 `init` 既有 profile 时，未传该参数必须保留原 transport。
- Web 不隐式改变 transport；CLI 提供显式 transport status/set。

### 2. 不直接复用当前官方 `RpcClient`

wire protocol 和公开类型以 Pi 官方 `rpc.md`、`rpc-commands.md`、`json.md`、`rpc-extension-ui.md` 与 `rpc-types` 为准，但当前版本的官方 `RpcClient` 不直接用于生产 bridge，原因是它：

- 固定用 `node <cliPath>`，不能直接执行用户明确选择的 Pi binary；
- 合并继承完整 `process.env`，不符合 profile-local auth 与环境 allowlist；
- 忽略 malformed stdout record，stderr 与生命周期诊断缺少本项目要求的边界；
- command timeout/child exit 后没有暴露足以证明 prompt 是否已接受的状态，无法实现安全 fallback。

bridge 实现一个小型、协议收窄的 typed RPC connection。若未来官方 client 同时支持显式 binary、受限环境、严格有界 JSONL、可证明的 prompt acceptance 和可控进程终止，可另行 ADR 切换。

### 3. 固定子进程边界

RPC 子进程沿用 spawn-per-turn 的安全参数和环境：

- 显式 Pi binary；
- user/profile scope 解析出的有效 `PI_CODING_AGENT_DIR`，以及始终 profile-local 的 session dir；
- 普通 route 使用 `--no-approve`；handoff route 使用用户 `PI_CODING_AGENT_DIR`、source cwd、full tools 与 `--approve`；一次性原生 `--fork` 固定由 spawn-per-turn adapter 完成并提交 catalog，后续 turn 才可按 configured transport 由 RPC 恢复该 catalog session；
- `read-only` 固定为 `--tools read,grep,find,ls`；
- bridge system prompt 使用 profile-local `0600` 文件；
- 用户文本只进入 RPC stdin，不进入 argv；
- POSIX 子进程使用 `0077` umask；
- stderr、JSONL 单行、连接累计输出、待处理 command、事件队列和写入 payload 均有界。

RPC mode 不发 JSON session header。connection 在任何 prompt 前用 `get_state` 完成握手、获得并核对 session ID；adapter 为 bridge 合成一次 `system` event。Bridge 也使用官方 model/thinking state/list/set commands 实现无模型 turn 的会话控制，并对响应字段做严格有界投影。

### 4. pool identity 与生命周期

稳定 pool key 为 profile + scope + canonical cwd + 既有 policy/resource fingerprint + model/thinking 启动覆盖，明确不纳入 session ID。每次 acquire 都用 `get_state` 将 child session 与 catalog 核对；不一致即销毁并重建。一个 key 同时最多一个 active consumer；RunExecutor 继续拒绝同 scope 的普通并发消息和 model/thinking 控制。

- pool 有固定最大容量、idle TTL 和 LRU 淘汰；只淘汰 idle connection；全部 busy 时 fail-closed。
- pool identity 包含 scope、cwd、policy fingerprint、model/thinking、handoff source 与 approve/access policy，但不包含 session ID；每次 acquire 都必须以 RPC `get_state` 核对 catalog session；`/new`、workspace/access identity 变化或 session 不匹配会关闭旧 connection 并新建/恢复正确 session。
- child death 立即使 connection 不可复用并解除 pending waiter；已被替换 child 的退出回调不得删除当前 entry。
- profile disconnect、daemon shutdown、adapter replacement、TTL/LRU、协议错误和 stop hard-timeout 都必须回收 child。
- `waitForExit()` 对 RPC 表示本次 turn 已 settled，不表示长驻 child 已退出。

### 5. prompt acceptance 与 fallback

RPC fallback 只能在 bridge **确定 prompt 未被 Pi 接受**时把同一 prompt 交给 spawn-per-turn。handoff fork 和 handoff 后续 turn 不扩大 replay：fork 绝不跨 transport fallback，source identity 不确定时也只允许用户重试：

- RPC child/握手在写 prompt 前失败：确定未接受，可 fallback；
- `prompt` response 明确 `success:false`：官方契约说明为接受前拒绝，可 fallback；
- prompt write 已开始后发生 write error、response timeout、Extension UI 失败、malformed protocol、未知 response、child death 或连接丢失：接受状态不确定，禁止 replay；
- `success:true` 的 `started`/`queued`/`handled` 均视为已接受，后续任何失败都禁止 replay。

禁止为了可用性把“不确定”降级成“未接受”。fallback 事件只记录 transport 和分类，不记录 prompt、图片或凭据。

### 6. event 与终态

- 继续使用现有严格 translator；RPC 先注入经握手确认的 session ID。
- `agent_end` 始终非终态；普通模型运行只有 `agent_settled` 可产生正常完成。Pi 明确返回 `handled` 后，Bridge 经过有界 quiet period 重复确认 idle 且没有独立 event 流，才把 extension command 作为无模型 turn；Pi 1.0.2 无法证明观察期之后永远不会启动 fire-and-forget 独立工作，因此此时销毁而不回池复用 child。
- `extension_ui_request` 和 `ui_prompt_start/end` 是独立 sideband，先于 translator/event inbox 分流；全部九种官方 method 严格校验，blocking response 直接写 stdin，不进入普通 command pending map。
- adapter 在 connection 创建时安装 handler；启动期 fire-and-forget 安全忽略、无 active run 的 dialog 安全取消。active run 经 Lark 无关 interaction port 映射为操作者私密卡片，一次性 token 绑定 run/scope/actor/method/option/expiry；stop、pool 回收和 teardown 取消 pending。
- 未恢复的 `message_end(error/aborted)` 在 `agent_settled` 后保持失败/中断。
- malformed/未知/非法顺序/terminal 后 record、unfinished tool、缺失 `agent_settled` 均 fail-closed，并销毁 connection。
- stop/timeout 使用 `abort`，但 bridge 的 stop reason 覆盖正常 settled 呈现；abort 未在 grace 内完成时终止 child。

### 7. model / thinking

`/model`、`/thinking` 与增强后的 `/status` 只支持 RPC；handoff 状态中的目录字段仅投影 source cwd 的 basename，无 basename 时显示固定“已验证”，不投影 session 文件名或绝对 cwd。Bridge 通过 `get_state`、`get_available_models`、`set_model`、`get_available_thinking_levels` 和 `set_thinking_level` 控制当前 scope 的 idle Pi session；不向模型发送 prompt。只向飞书投影 provider、model ID、有界名称、reasoning 能力和 thinking level，不回显 endpoint、cost 或认证状态细节。

切换要求当前 scope 已有 session；成功选择写入 profile-local 私有 scope settings，供 Bridge 重启或 child 重建时以 `--model`/`--thinking` 恢复；恢复已有 session 且没有 scope 覆盖时不传 profile 默认 model，避免覆盖 session 自己记录的变化。`/new`、workspace 或 access 变化会清除覆盖。spawn-per-turn 明确拒绝，不用 CLI 文本解析模拟状态。

### 8. steer / follow-up

提供显式 `/steer <text>` 与 `/follow-up <text>`（也支持 `/followup`）控制命令。它们只在当前 scope 有 active RPC run 时直接调用该 run 的 RPC command：

- 不进入 RunExecutor 的普通 submit 路径；
- 不进入 bridge pending queue；
- 不作为普通 prompt 再投递；
- command response 的 disposition 必须被确认后才回复“已排队”；
- spawn-per-turn 或无 active run 返回明确“不支持/无运行”，不伪造成功。

普通并发消息仍 fail-closed，不自动转换成 steer/follow-up。

### 9. 受控 Pi command namespace

`/pi commands` 使用当前 RPC session 的 `get_commands`，只返回 extension、prompt、skill 的有界名称/描述/type，不返回 `sourceInfo`；合法跨来源重名按 Pi 返回顺序稳定保留第一个可调用投影。`/pi /<command> [args]` 必须先命中该 allowlist，再以原始命令调用 `prompt`，不套 Bridge wrapper；未列出的内建/TUI 命令拒绝。handled 后经过有界 quiet period 仍无模型流才正常结束，观察期内自行启动模型流则等待 `agent_settled`。`/pi` 继续受 scope/workspace/access/concurrency/timeout/session 约束，且不允许 fallback 到 spawn-per-turn。

### 10. 图片

公共附件下载、MIME + magic-byte 校验、run-owned `0700`/`0600` 落盘与终态清理由现有 AttachmentStore 负责。RPC adapter 以 `O_NOFOLLOW` 打开并复核普通文件、inode、大小和 magic bytes，再转换为官方 `ImageContent[]`：

```json
{ "type": "image", "data": "<base64>", "mimeType": "image/png" }
```

本地路径不写入 RPC prompt。spawn-per-turn 继续使用经过验证的 `@file` argv contract；最终真实图片只验证 RPC，不据此外推 spawn 图片真实 E2E。

## 验证

至少覆盖：

- profile 默认/显式 transport 与 CLI；
- RPC handshake、session synth/resume、pool reuse、scope/cwd/fingerprint isolation；
- max-size LRU、TTL、全部 busy、child death、stale waiter、dispose/orphan；
- strict LF JSONL、malformed/oversize/unknown/terminal-after-event；
- `agent_end` 非终态、模型 turn 的 `agent_settled` 与 handled 无模型 command；
- Extension UI 九方法、生命周期、schema/容量、sideband 隔离、响应写回、启动期状态、一次性 token/actor/replay/取消；
- `/model`、`/thinking` state/list/set、重建恢复、响应投影与 spawn 不支持；
- `/pi commands` 投影与 extension/prompt/skill allowlist、原始命令、内建拒绝和 spawn 不支持；
- abort/timeout、steer、follow-up 与不重复投递；
- prompt 明确未接受时 fallback，以及 write/timeout/exit 等不确定状态绝不 replay；
- 图片 base64/MIME/私有文件与 symlink 拒绝；
- 受限环境、固定 tools/resources、prompt 不进入 argv。

自动测试只能使用 fake Pi、临时 home 和 loopback mock，不得连接飞书、真实 provider 或持久 service。真实文本或图片 E2E 必须使用明确授权的隔离 profile、模型与预算，并在结束后清理瞬态状态。

## 后果

实现比直接调用官方 client 更小、更严格，但需自行维护 RPC record 校验和 pool。该成本换取了可审计的进程、安全、终态和 no-uncertain-replay 契约。RPC 是 `init` 的产品默认值；spawn-per-turn 继续作为显式隔离模式和严格受限的安全 fallback。
