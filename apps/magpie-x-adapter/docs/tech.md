# magpie-x-adapter 技术设计

> 状态：当前实现说明
> 相关入口：[README](../README.md)、[x-adapter 技术设计](../../x-adapter/docs/tech.md)

## 1. 目标与非目标

`@mlzwl/magpie-x-adapter` 是 Magpie 的 provider 插件，把本机 `x-adapter` 网关接入 Magpie 的模型选择器与路由。

```text
Claude Code / Codex / OpenCode / pi
                 │  Anthropic Messages
                 ▼
        Magpie 本地网关
                 │  插件 loader 的 fetch
                 ▼
      http://127.0.0.1:10100/v1
                 │
                 ▼
        x-adapter daemon
```

目标：

- 一个包、一个 provider `x-adapter`，模型名 `x-adapter/<公开模型 ID>`；
- 复用 x-adapter 已有的上游登录、精确路由与协议转换，插件不保存任何上游凭据；
- 不接管 x-adapter 的生命周期，只允许在登录或已登录后的模型刷新时补启动一次。

非目标：

- 不复制 x-adapter 的 provider 分类（Trae 与豆包工作不作为独立 Magpie provider）；
- 不实现 Magpie 的中间件、工具或页面；
- 除安全补启动一次 `x-adapter` CLI 外，不执行其他文件或终端操作。

## 2. 为什么必须是独立包

Magpie 判定插件类型的顺序是：包 manifest 带 `pi` 字段、带 `pi-package` 关键字、依赖里有 `@earendil-works/pi-coding-agent`，或入口文件导入 pi，都会走 pi 的加载器。走 pi 加载器后 Magpie 只读取扩展注册的 provider，完全不加载 OpenCode 的 `main`。

`apps/x-adapter` 的 `package.json` 有 `pi.extensions`，因此整包必然走 pi 路由。把 OpenCode 入口放进它的 `dist/` 不会生效，实测结果就是只出现 pi 注册的 provider。

独立包保持干净的 manifest，Magpie 走 OpenCode 路由，同时 `apps/x-adapter` 的发布产物契约（`dist/` 只有 `bin/index.js` 与 `pi/index.js`）不受影响。

构建脚本 `scripts/build-magpie-plugin.mjs` 与校验脚本 `scripts/check-magpie-plugin.mjs` 都会拒绝带 pi 标记的 manifest，防止后续改动把插件悄悄切回 pi 路由。

## 3. 模块结构

| 文件               | 职责                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| `src/index.ts`     | 组装 hooks：`config`、`auth`、`chat.headers`、`provider.models`；定义受限的 `fetch`。 |
| `src/discovery.ts` | 解析 `GET /v1/models` 的 Codex 方言响应，投影为 Magpie 的 Model 形状。                |
| `src/daemon.ts`    | loopback 地址校验、health 探测、一次性 `x-adapter start`、client token。              |
| `src/types.ts`     | 本插件用到的 OpenCode v1 插件接口子集。                                               |
| `src/lock.ts`      | 只读检查共享 daemon 的 runtime lock。                                                 |

## 4. 契约

### 4.1 地址解析

`X_ADAPTER_BASE_URL` 未设置时使用 `http://127.0.0.1:10100`。设置但非法（非 URL、非 loopback、带自定义 path、带用户名或密码）时直接抛错，由 Magpie 显示为插件加载失败。HTTP 直连要求 health 返回的端口与目标端口一致。HTTPS loopback 可指向用户自管的反向代理，因此只校验 health 返回的是 loopback daemon，不要求后端 HTTP 端口等于代理端口。

不做静默回退：回退会把本该指向隔离端口的请求送到默认端口上真实运行的网关，恰好破坏隔离边界。工厂在加载时固定网关地址和环境 token。登录、模型发现与聊天使用同一个地址，不随后续环境变量变化而静默切换。

### 4.2 provider 声明

```ts
config.provider['x-adapter'] ??= {
  name: 'x-adapter',
  npm: '@ai-sdk/anthropic',
  api: `${base}/v1`,
  models: {},
};
```

`npm` 决定 Magpie 交给插件 `fetch` 的请求格式。Anthropic Messages 由 x-adapter 的 `/v1/messages` 直接承接，是唯一不需要额外转换的路径。`??=` 保证用户在 `plugins.json` 里改过的 provider 配置不被覆盖。

### 4.3 登录

`auth.methods` 只有一个 `api` 方法，带 `keyless: true` 和 `authorize`：

- `keyless` 让 Magpie 不显示 key 输入框；
- `authorize` 调 `ensureDaemon`，必要时安全启动一次网关；
- health 就绪后，插件用本机 token 请求受保护的 `/v1/models`，不只依赖免认证的 `/health`；
- HTTP 401 或 403 表示认证失败，不保存账号；
- HTTP 3xx 表示本插件拒绝跟随的重定向，因此不算已验证网关，也不保存账号；
- 其余状态码（含 200、5xx 与其它 4xx）都说明 token 已通过校验。x-adapter 在每个 `/v1/` 请求上先执行客户端 token 校验再路由，所以上游故障或目录格式异常属于模型发现问题，不属于登录问题；
- 成功返回的 `key` 是工厂加载时的 `X_ADAPTER_CLIENT_TOKEN` 或占位值 `dummy-token`。Magpie 保存它用于本机 data-plane 校验。

启动或认证失败时 `authorize` 返回 `{ type: 'failed', error }`，Magpie 把原因显示给用户，不写入任何账号。模型发现和聊天都优先使用保存的 `auth.key`，为空时才回退到工厂的环境 token。网关 token 轮换后，用户需要重新登录。

本机 token 按原值使用，不做 `trim()`：daemon 用 `env()` 逐字节读取该值，插件与它必须一致。

### 4.4 请求

`auth.loader` 返回 `baseURL`、`apiKey`、`headers` 和自定义 `fetch`。`fetch` 的约束：

1. 解析传入 URL，拒绝用户名、密码、origin 不等于网关 origin 或路径不以 `/v1/` 开头的请求，返回本地 400；
2. 读取 `x-api-key`（`@ai-sdk/anthropic` 会写这个头），转换为 `Authorization: Bearer`，并删除 `x-api-key`；
3. `redirect: 'manual'`，不跟随重定向，避免凭据被带到其他主机。health 探测和模型发现也使用相同的手动重定向策略。
4. 调用方的 `AbortSignal` 取消保持为 `AbortError`，不转换成普通网关错误；只有真正的网络失败才改写为固定文案，并把原始错误放进 `cause`。

第 2 步是必要的：x-adapter 只把 `Authorization` 当本机 token，不把它当上游凭据；它也不会读 `x-api-key`。

### 4.5 模型列表

`provider.models` 调 `ensureDaemon`，再请求 `GET /v1/models`，带 `User-Agent: codex-cli` 取 Codex 方言：

- `context_window` → `limit.context`，`max_output_tokens` → `limit.output`；
- `model_load_percent` → 展示名后缀。`0` 是合法值（表示无负载），必须保留；`context_window` 与 `max_output_tokens` 则必须是正数，缺失或 0 时用默认值；
- `supported_reasoning_levels[].effort` → `variants` 的键，即 Magpie 里可选的推理档位；
- `input_modalities` → `capabilities.input`，只有 x-adapter 明确声明时才开启 `image`；
- `display_name` 加上 `· Model load: N%` 作为展示名，与 Pi 侧一致，不改变模型 ID。

列表缓存位于每个插件工厂的闭包中，固定对应一个网关。缓存仅保留最近一次 token 对应的目录，存活 30 秒。不同 token 不会命中同一缓存；不同工厂不共用缓存。失败与合法空目录必须区分：

| 上游结果                         | 插件行为   | Magpie 表现          |
| -------------------------------- | ---------- | -------------------- |
| HTTP 200，`models` 为非空数组    | 返回列表   | 显示这些模型         |
| HTTP 200，`models: []`           | 返回空列表 | 清空选择器           |
| HTTP 503（无可用 provider）      | 抛错       | 保留旧列表并显示原因 |
| HTTP 200 但无 `models` 数组      | 抛错       | 保留旧列表并显示原因 |
| 启动失败 / 探测为 `unresponsive` | 抛错       | 保留旧列表并显示原因 |

`models: []` 是合法答案：用户隐藏全部模型或 provider 时 x-adapter 仍返回 200，只有所有 provider 都不可用时才返回 503。若把空数组合并进故障，用户隐藏了全部模型后 Magpie 仍会显示旧列表。

抛错而不是返回 Magpie 传入的 `provider.models`，是因为 Magpie 判定「回退」的条件是：返回原对象 **且** 自己确实发过请求 **且** 请求失败。若插件在失败冷却期内直接拒绝而不发请求，原样返回会被当成「成功但为空」的目录，从而清空选择器。抛出错误走 Magpie 的 `catch` 分支，那里无条件设置 `fellBack`，保留上一次的列表并显示原因。

### 4.6 会话标识

`chat.headers` 把 Magpie 的 `input.sessionID` 写入 `x-session-id`。x-adapter 用它作为豆包工作工具桥接的会话键：同一段对话的多轮落在同一个上游 turn 上。

## 5. 生命周期边界

- 插件可以启动直连的 HTTP 网关：`authorize` 和 `provider.models` 都会调 `ensureDaemon`。同一时间只跑一个启动流程；启动失败的结果记住 60 秒，避免 Magpie 每次刷新模型都重复拉 CLI。HTTPS loopback 地址只作为用户自管代理使用，连接拒绝时插件不会错误启动一个 HTTP daemon。
- 自动启动 CLI 子进程有独立的 30 秒期限。超时后只向本次创建的 CLI pid 发送 SIGKILL，关闭其输出流，并报告固定错误。插件不按 lock 查找进程，也不终止 CLI 创建的 detached daemon。CLI 成功退出后，另有最多 30 秒的 health 轮询期限。
- 启动失败会释放该工厂的 `inflight`。60 秒失败冷却结束后可重试。不同工厂的启动与冷却状态不互相阻塞。
- 插件不停止网关。`x-adapter` daemon 被 Pi、Claude Code、Codex 等客户端共用，插件无法判断其他客户端是否仍在用。
- 启动走 `x-adapter start`，因此 lock、runtime、日志目录仍由 x-adapter 自己管理，插件不写这些文件。
- 插件设置 `X_ADAPTER_HOST`、`X_ADAPTER_PORT` 和 `X_ADAPTER_NO_ORPHAN_RECOVERY=1`，不覆盖 `X_ADAPTER_DATA_DIR`。因此在 Magpie 里启动的 daemon 与用户自己的 x-adapter 共用同一份 `~/.x-adapter` 数据、登录和额度。

### 5.1 不杀已有 daemon 的三道防线

`x-adapter start` 的孤儿恢复会把「lock 被活着的 daemon 持有、control socket 750ms 内不可达」判定为孤儿并 SIGTERM 该 daemon。插件有三道防线，但它们的安全强度不同：前两道减少误触发，第三道才是真正的安全边界。

1. **端口探测**（`probeGateway`）。只有连接被明确拒绝（Node 的 `cause.code === 'ECONNREFUSED'`，或 Bun 的 `code === 'ConnectionRefused'`）才算 `absent`。超时、代理失败、异常状态码、非 x-adapter 的 `/health` 应答一律算 `unresponsive`，插件拒绝启动。
2. **lock 检查**（`assertNoLiveLockOwner`）。启动前读取数据目录的 `x-adapter.lock`，只要有活着的 pid 持有它就报冲突。路径解析必须与 CLI 逐字节一致（见 5.4），否则会读到 CLI 不写的目录。这一层只是提前发现，**不是安全保证**：检查与执行之间存在竞态，另一个进程可以在检查后取得 lock。
3. **CLI 能力探测**（`cliSupportsNoOrphanRecovery`）。启动前先执行 `x-adapter capabilities`，确认 CLI 报告 `noOrphanRecovery: true` 与 `startNoOrphanRecoveryFlag: true`，再以 `x-adapter start --no-orphan-recovery` 启动，并同时设置 `X_ADAPTER_NO_ORPHAN_RECOVERY=1`。CLI 缺少该能力时插件**拒绝自动启动**，提示用户升级或自行启动网关。

该能力从 `@mlzwl/x-adapter@0.1.3` 开始提供。`0.1.2` 及更早版本执行 `capabilities` 只会打印 usage 并以非零退出，因此插件对这些版本一律拒绝自动启动。发布顺序必须先发 x-adapter，再发插件；否则插件文档里的安装步骤会指向一个无法自动启动的 CLI。

只有第 3 道是安全边界：旧版 CLI 会忽略环境变量并可能终止活着的 daemon，因此仅靠第 2 道的提前检查不足以保证不干扰已有网关。

### 5.2 端口与数据目录的耦合

`x-adapter` 的 daemon lock 按数据目录加锁，不按端口。同一数据目录下：

- 已有 daemon 在服务该端口：`start` 返回 `already_running`，插件直接复用。
- 已有 daemon 在服务**另一个**端口：`start` 也返回 `already_running`，但插件等待的端口永远不会有应答。插件因此检查 `start` 输出里的 `daemon.port`，与目标端口不一致时报错，而不是等到 30 秒超时。
- 已有 daemon 但 control socket 不可达：第 5.1 节的 lock 检查拦截。

### 5.3 探测错误形状

Magpie 在 Bun 上运行插件，错误形状与 Node 不同。实测 Bun 1.3.14：

| 场景         | Node                        | Bun                                    |
| ------------ | --------------------------- | -------------------------------------- |
| 端口无监听   | `cause.code = ECONNREFUSED` | `code = ConnectionRefused`，无 `cause` |
| 域名无法解析 | `cause.code = ENOTFOUND`    | 同样是 `code = ConnectionRefused`      |
| 连接超时     | 无明确 code                 | `name = TimeoutError`, `code = 23`     |

因为 Bun 把 DNS 失败也报成 `ConnectionRefused`，判断只在 loopback 地址上采信该 code——loopback 不存在解析失败，因此不会误判。

### 5.4 runtime 路径解析必须与 CLI 一致

`src/lock.ts` 复刻 CLI 的 `apps/x-adapter/src/config/env.ts`。任一处偏差都会让插件读到一个 CLI 并不使用的 lock 文件，从而使第 5.1 节的 lock 检查失效。必须一致的细节：

| 细节           | CLI 行为                   | 说明                                         |
| -------------- | -------------------------- | -------------------------------------------- |
| 变量为空字符串 | 视为未设置，用默认值       | 不能用 `trim()` 后判断，也不能 `trim()` 取值 |
| 值中的空格     | 原样保留                   | `"/tmp/xc "` 就是带尾随空格的目录            |
| `~`            | 展开为 home                |                                              |
| `~/`           | 展开                       | 按 `path.sep` 判断                           |
| `~user/`       | **不展开**，按字面路径处理 | 只有 `~` 和 `~/` 两种形式                    |

`X_ADAPTER_RUNTIME_DIR` 优先于 `<data>/runtime`。`X_ADAPTER_DATA_DIR` 优先于 `~/.x-adapter`。

集成测试必须同时设置 `X_ADAPTER_DATA_DIR` 与 `X_ADAPTER_PORT`，否则测试用的 daemon 会落进用户真实数据目录。

## 6. 安全边界

- 只接受 loopback 的 http(s) 地址；`X_ADAPTER_BASE_URL` 指向非 loopback 时插件加载失败，不回退到默认地址。
- 不保存上游凭据，不读取 `~/.x-adapter` 下的任何认证文件。
- health、模型发现和聊天转发都不跟随重定向；聊天转发不向非 `/v1/` 路径发请求。
- 地址校验和聊天 URL 拒绝使用固定错误，不回显原始 URL、查询参数或用户信息。
- 网络与 JSON 解析失败转换为固定错误。CLI stderr 只消费、不复制，失败只报告退出码或超时。错误不包含请求体、响应正文、CLI 输出或凭据；部分生命周期提示可包含已校验的 loopback origin、端口和 pid。

## 7. 验证

`pnpm --filter @mlzwl/magpie-x-adapter verify` 执行：

1. `tsc --noEmit`；
2. `eslint src`；
3. `prettier --check`；
4. `scripts/check-magpie-plugin.mjs`：断言 manifest 无 pi 标记、`main` 与 `exports["."]` 指向 `./dist/index.js`、发布到公共 npm、`dist/` 只含 `index.js`、bundle 只导出 `XAdapterPlugin`，并实际调用一次工厂确认 hooks 形状；
5. 同一个现有校验脚本运行隔离行为验证：已保存 token、错误 token 登录拒绝、上游 5xx 不阻止登录、合法空目录、账号与工厂缓存隔离、模型字段映射、会话 header、`AbortError` 透传、token 不 trim、重定向拒绝和 URL 错误脱敏；
6. 用隔离 `.tmp/`、`HOME`、runtime 与仅含假 CLI 的 `PATH` 验证真实 30 秒启动超时、忽略 SIGTERM 的子进程清理、失败冷却、重试和 CLI 输出不回显。此项会增加约 30 秒执行时间，不运行真实 daemon 或 provider。

第 4 步读取 `dist/index.js`，而 `dist/` 不受 Git 跟踪。因此 `test` 脚本先执行 `pnpm build` 再检查：干净检出后直接 `verify` 不会因缺少产物失败，改源码后也不会检查到旧 bundle。`prepack` 也固定执行 `pnpm build`，保证公共 npm 发布脚本从干净检出打包时不会漏掉 `dist/index.js`。

真实 Magpie 程序的联调也必须使用仓库 `.tmp/` 下的独立 `HOME`。自动验证仅连接 loopback mock，不调用真实上游。插件 hook 的会话 header 验证不等同于真实豆包工具桥接的多轮验证。

沙箱测试必须同时设置 `X_ADAPTER_BASE_URL`、`X_ADAPTER_PORT` 与 `X_ADAPTER_DATA_DIR`，指向专用端口和专用数据目录；禁止占用其他客户端正在使用的默认 `10100`，也禁止让测试 daemon 写入 `~/.x-adapter`。
