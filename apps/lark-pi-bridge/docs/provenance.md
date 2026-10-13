# 来源与本地改写

## 受控来源

### `zarazhangrui/lark-coding-agent-bridge`

- Repository: <https://github.com/zarazhangrui/lark-coding-agent-bridge>
- Reviewed commit: `589868119ce9a0a860aaf4936b5f9bac14e72681`
- License: MIT

该上游用于产品边界、Lark Channel 接入方式、scope/session 风险和平台命令语义调研。本 package 是 Pi-only 本地实现：未把上游 package 作为依赖，未 cherry-pick 上游 Pi PR，也未保留 Claude/Codex runtime。

package 根目录的 `LICENSE` 保留 MIT 许可文本；发布包同时包含 `THIRD_PARTY_NOTICES.md` 记录来源和独立依赖说明。不要删除这两个发布文件，也不要依赖 bundle 注释替代它们。

### Pi coding agent

Pi 由用户独立安装，不进入本 package 的 runtime dependencies。Bridge 的 JSON/RPC wire contract 以所选 Pi 版本的官方文档、公开 types 和实际 capability probe 为准，不按固定 minor 白名单放行。

### `lark-cli` 与 `@larksuite/channel`

扫码注册流程参考官方 device-code app registration；运行时直接调用 `@larksuite/channel.registerApp()`。`lark-cli auth qrcode` 只作为公开二维码渲染接口，bridge 不复制其源码，也不读取其配置或 Keychain。

`@larksuite/channel` 是锁定版本的 runtime dependency。对其 API 的支持范围以本项目的 contract tests 和明确的真实 E2E 为准，不能从依赖的完整导出表面推定。

## 上游能力映射

| 能力域                | 本地处理                                                      | 本地模块                                              |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| Channel/profile/scope | Pi-only 重写                                                  | `src/bot/channel.ts`, `src/config/*`, `src/session/*` |
| Claude/Codex adapter  | 删除，不含运行时代码或用户配置                                | 无                                                    |
| Pi JSON/RPC 历史 PR   | 仅作生命周期风险参考；wire 以 Pi 官方契约为准                 | `src/agent/pi/*`, `docs/adr-pi-rpc-transport.md`      |
| 卡片与回复            | SDK Markdown stream + 结构感知 Markdown continuation/fallback | `src/card/*`                                          |
| 注册与本地 Web        | 官方 device-code 注册；loopback-only 安全控制面               | `src/registration/*`, `src/web/*`                     |
| Media                 | 受限图片下载、MIME/magic-byte 校验、run-owned 私有落盘        | `src/media/attachments.ts`                            |
| Daemon/service        | 参考平台命令语义，重做 ownership、回滚和 runner 注入          | `src/daemon/*`                                        |

## 关键本地改写

1. 固定 `agentKind: 'pi'`，删除 Claude/Codex adapter 和相关配置表面；
2. 只提供 `read-only` 与 `full`，明确不把工具 allowlist 宣称为 OS sandbox；
3. 每个 profile 的 session 和 media 独立；`PI_CODING_AGENT_DIR` 可选择只读用户源或独立 profile 源，Pi 子环境采用 allowlist；
4. 只有 `agent_settled` 是 JSON/RPC 正常完成边界；
5. Pi preflight 检查实际 flags 和隔离 loopback 协议，而不是依赖 minor 版本；
6. App Secret 写入 profile-local 私有文件，注册 URL 保持 opaque；
7. Web 固定 loopback，只暴露非机密 DTO；service definition 带 ownership marker 和失败回滚；
8. RPC 使用本地严格 connection，而不是当前官方 `RpcClient`，以保证显式 binary、受限环境、framing、容量和 prompt acceptance 边界；
9. 自动 test/verify/smoke 不连接真实飞书/provider，不执行注册或持久 service 安装；
10. Meeting 未纳入产品范围。
