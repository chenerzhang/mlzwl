# magpie-x-adapter

`@mlzwl/magpie-x-adapter` 是 [Magpie](https://usemagpie.ai/) 的 provider 插件。它把本机 `x-adapter` 网关的模型接到 Magpie，让 Claude Code、Codex、OpenCode、pi 等 Agent 通过 Magpie 使用同一个本机网关。

- 只连接 loopback 地址，默认 `http://127.0.0.1:10100/v1`。
- 不读取、不保存任何上游凭据。Trae 与豆包工作的登录仍由 `x-adapter` 自己管理。
- 只提供一个 provider `x-adapter`，模型名是 `x-adapter/<公开模型 ID>`。

## 前置条件

1. 安装并登录 `x-adapter`。插件自动启动网关依赖 `x-adapter capabilities` 与 `x-adapter start --no-orphan-recovery`，因此 **`@mlzwl/x-adapter` 必须不低于 `0.1.3`**。`0.1.2` 及更早版本没有这两个能力，插件会拒绝自动启动：

   ```bash
   npm i -g @mlzwl/x-adapter@latest
   x-adapter capabilities   # 必须输出 JSON，且 noOrphanRecovery 为 true
   x-adapter trae import --realm global  # 或登录你实际使用的 Trae realm
   x-adapter doubao login                # 需要豆包工作时执行
   ```

   若 `x-adapter capabilities` 只打印 usage 并以非零状态退出，说明 CLI 版本过旧。旧版 CLI 下插件不会代为启动网关，只会提示升级；此时可先手动执行 `x-adapter start`，再用 `X_ADAPTER_BASE_URL` 指向已运行的网关。

2. 安装 Magpie，并确认 `magpie ls` 能列出本机 Agent。

## 安装

包发布在公共 npm registry：

```bash
magpie plugin add @mlzwl/magpie-x-adapter
```

也可以在 Magpie 的「设置 → 插件」里输入同一个包名安装。

## 登录

```bash
magpie plugin login x-adapter
```

这一步不需要粘贴任何 key。插件先检查本机网关。没有运行时，它执行一次 `x-adapter start`。网关就绪后，插件请求受保护的模型接口验证本机 token。token 错误时登录失败，不会保存账号。启用 token 的网关要求登录进程设置相同的 `X_ADAPTER_CLIENT_TOKEN`。

登录成功后，Magpie 保存本机 token。后续模型发现和聊天优先使用账号中保存的 token，不要求每次启动 Magpie 都重新设置该变量。这个 token 不是 Trae 或豆包工作的上游凭据。若网关 token 已更换，请用新值重新登录。

登录只把 HTTP 401/403 判为 token 错误。x-adapter 在处理 `/v1/` 路由前先校验 token，因此其余状态码说明 token 已通过；上游 5xx、模型目录暂不可用或响应格式异常都不会阻止登录，只会让模型列表刷新报错。

没有可用上游 provider 时，插件仍可验证本机 token 并完成登录。此时模型发现会报告上游不可用；请先完成 x-adapter 的上游登录。

## 使用

模型名形如 `x-adapter/trae-global-<upstream-id>`。

```bash
magpie models | grep x-adapter/
magpie claude x-adapter/trae-global-<upstream-id>
```

图形界面里在「Agent」页打开模型选择器，搜索 `x-adapter/` 即可。

## 配置

| 变量                     | 说明                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `X_ADAPTER_BASE_URL`     | 网关地址，默认 `http://127.0.0.1:10100`。只接受 loopback 的 http(s) 地址，不接受 URL 用户名或密码；设置但非法时插件加载失败，不会改用默认地址。 |
| `X_ADAPTER_CLIENT_TOKEN` | 可选的本机 data-plane token。只有当 `x-adapter` daemon 用同一个值启动时才生效。                                                                 |

## 已知限制

- 插件不会停止网关。Magpie 与其他客户端共用同一个 `x-adapter` daemon；需要停止时执行 `x-adapter stop`。
- 插件只在 HTTP loopback 网关地址上没有任何进程应答（连接被拒绝）时才执行 `x-adapter start`。HTTPS 地址只用于连接用户自己启动的本机代理，插件不会代为启动。自动启动要求 CLI 支持 `x-adapter capabilities` 与 `start --no-orphan-recovery`（`@mlzwl/x-adapter` >= `0.1.3`）；旧版 CLI 会被拒绝，请升级 x-adapter 或先手动启动网关。如果该地址上有进程但不像健康网关，或者同一数据目录已有另一个 daemon 持有 lock，插件也会拒绝启动并显示原因。
- 模型列表刷新失败时，插件报错而不是清空列表；Magpie 会保留上一次的模型并显示失败原因。
- 插件启动网关时不覆盖 `X_ADAPTER_DATA_DIR`，因此与你自己运行的 x-adapter 共用同一份数据和登录。一个数据目录只允许一个 daemon：若你在默认 `10100` 已有 daemon，再把 `X_ADAPTER_BASE_URL` 指到别的端口，插件会拒绝启动并提示你先用 `x-adapter status` 确认实际端口，或先停止再换端口。
- 模型目录缓存 30 秒。不同插件实例和不同 token 不共用缓存。刷新失败时 Magpie 保留上一次的列表并显示原因。
- 选择器里的展示名带 provider 前缀（`Trae` / `Doubao Work`），可以区分两个 provider。但若客户端直接读 `/v1/models` 的 OpenAI 方言，`metadata.display_name` 是上游原始值、不带前缀；要区分 provider 请按公开模型 ID 前缀（`trae-` / `doubao-`）判断，不要按展示名判断。
- 自动启动的 CLI 子进程最多运行 30 秒。超时后插件仅结束本次 CLI 子进程，不停止共享 daemon。随后仍有独立的 30 秒 health 等待期限。启动失败后，同一插件实例冷却 60 秒再允许重试。
- 插件拒绝 URL 中的用户名和密码。错误信息不回显原始 URL、请求正文、网关响应正文或 CLI 输出。

## 文档

技术实现、协议边界与验证方式见 [docs/tech.md](docs/tech.md)。

## Changelog

<!-- npm-release:start -->

### [0.1.1] - 2026-11-09

#### Fixed

- 修复模型选择器中缺少 provider 前缀的问题，兼容新版与旧版 x-adapter；不再在展示名追加负载，避免截断。
- 兼容旧版网关返回的字符串形式推理档位，避免 Magpie 丢失推理强度选项。

### [0.1.0] - 2026-11-04

#### Added

- 首个版本。以 OpenCode 插件格式向 Magpie 提供唯一的 `x-adapter` provider，模型名使用 `x-adapter/<公开模型 ID>`。
- 登录时检查本机网关，未运行则执行一次 `x-adapter start`；插件自身不停止网关。
- 透传 Magpie 的会话标识给 x-adapter，使豆包工作的工具桥接能在多轮之间接续。

#### Fixed

- 模型发现和聊天统一使用已保存的账号 token；不同 token 和插件实例不共用模型缓存。
- 登录验证受保护的模型接口，拒绝错误 token。登录只把 HTTP 401/403 判为 token 错误；上游 5xx、目录不可用或格式异常不再阻止登录。
- 自动启动 CLI 增加 30 秒超时和子进程清理，失败后可在冷却期结束时重试。
- 请求取消保持为 `AbortError`，不再被转换成普通网关错误。
- 本机 token 按原值使用，不再 trim；`X_ADAPTER_CLIENT_TOKEN` 中带前后空格时与 daemon 逐字节一致。

#### Security

- 拒绝 URL 用户名和密码，不向错误信息复制原始 URL、响应正文或 CLI 输出。

#### Requirements

- 自动启动网关需要 `@mlzwl/x-adapter` >= `0.1.3`（提供 `capabilities` 与 `start --no-orphan-recovery`）。

<!-- npm-release:end -->
