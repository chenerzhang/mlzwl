# x-adapter 维护约定

所有代码代理必须使用中文与用户交流和回答。

## 项目定位

`apps/x-adapter` 发布为 `@mlzwl/x-adapter`，CLI bin、Pi provider ID 与服务名均为 `x-adapter`。它只支持 Trae 与豆包工作两个 provider；Trae 对外保持单一 provider，内部为相互隔离的 `global` / `cn` realm。

核心契约：

- 默认监听 `127.0.0.1:10010`，默认数据目录为 `~/.x-adapter`；配置、缓存、日志、运行时文件和 provider 凭据必须位于该目录或用户显式配置的替代路径。
- 公开模型 ID 使用 `trae-global-*`、`trae-cn-*` 与 `doubao-work-*`；数据面按公开 ID 精确派发，不允许跨 realm、跨模型或跨 provider fallback。
- `GET /v1/models` 聚合成功发现且用户可见的模型；Trae Global、Trae CN 或豆包工作任一失败不得阻塞其他边界。
- Trae Global、Trae CN 与豆包工作凭据严格隔离。客户端 Authorization 不得作为上游凭据转发。
- Trae OAuth 只接受代码内 allowlist 的 HTTPS host，callback 只监听 `127.0.0.1`。仅当用户明确授权时，显式 `trae import` 可只读解密本机官方客户端 `storage.json`，将目标 realm 的 token、machine/device ID 和匹配 P-256 密钥复制到 x-adapter；不得写回官方存储，且不得跨 realm 导入。
- Trae hosted search 当前必须明确返回 `unsupported_hosted_search`；不得用本地或第三方搜索冒充上游原生能力。
- 默认只允许 loopback bind；HTTP data-plane 保持 Host、Origin、`sec-fetch-site`、JSON Content-Type 与 body size 校验。
- 不记录、输出或提交真实 token、Cookie、JWT、设备私钥、完整 callback query、auth 文件内容或其他凭据；真实导入验证仅可使用仓库 `.tmp/` 下的隔离数据目录并保持 `0700`/`0600`。
- Trae 新接入在真实账号 smoke 完成前必须标记为实验性，离线 mock 通过不得描述为真实上游可用。

## 结构

- `src/daemon/`：HTTP daemon 与生命周期。
- `src/models/`：公开模型 ID、registry 与发现响应。
- `src/providers/trae/`、`src/providers/doubao/`：仅有的 provider adapter。
- `src/providers/trae/auth/`：双 realm OAuth、设备身份、refresh 与凭据持久化。
- `src/protocol/`：Canonical Request / Result、OpenAI / Anthropic / Responses、SSE。
- `src/pi/`：Pi extension 与 `/x-adapter` command。
- `src/security/`：本地安全边界。
- `src/service/`：launchd/systemd 用户服务模板。
- `src/state/`：Responses history。
- `src/tools/`：公共 npm 更新检查与安装。

## README 与文档边界

- `README.md` 面向最终用户，只保留安装、Global/CN 登录、启动、模型选择、请求示例、常用配置、安全提示、更新、客户端接入和 Changelog。
- README Changelog 使用 `<!-- npm-release:start -->` / `<!-- npm-release:end -->` 区间，正式版本按新到旧排列；每次发布必须根据源码、测试和公开文档证据更新对应版本条目。
- 安全边界、依赖限制、完整配置、OAuth/realm、架构、协议、开发与验证细节放在 `docs/`。
- README 与 `docs/` 是本包唯一文档来源，所有用户与维护文档都在仓库内维护。
- 修改 CLI、默认配置、公开接口、认证、Pi、service、更新或模型 ID 时，同步更新 README 与相关 `docs/`。

## 验证

```bash
pnpm --filter @mlzwl/x-adapter typecheck
pnpm --filter @mlzwl/x-adapter lint
pnpm --filter @mlzwl/x-adapter format:check
pnpm --filter @mlzwl/x-adapter test
pnpm --filter @mlzwl/x-adapter verify
pnpm --filter @mlzwl/x-adapter pack:dry-run
```

自动测试必须使用临时目录、mock fetch、模拟 callback 和非真实 token，不得读取默认真实凭据或访问真实 provider。真实 Trae / 豆包工作登录与上游 smoke 只在用户明确授权且本机凭据、网络可用时执行；验证结束后必须停止并清理由验证启动的 daemon。
