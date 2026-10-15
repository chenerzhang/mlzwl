# Claude Code 与 Codex 接入

## Codex

将 provider 指向本机 Responses API：

```toml
[model_providers.x-adapter]
name = "x-adapter"
base_url = "http://127.0.0.1:10010/v1"
wire_api = "responses"
env_key = "X_ADAPTER_CLIENT_TOKEN"
```

模型使用公开 ID，例如：

```toml
model_provider = "x-adapter"
model = "trae-global-<upstream-id>"
```

若未启用本机鉴权，可给 `X_ADAPTER_CLIENT_TOKEN` 配任意非空占位值；它不会被转发为上游凭据。

## Claude Code

将 Anthropic base URL 指向：

```text
http://127.0.0.1:10010
```

网关支持：

```text
POST /v1/messages
POST /v1/messages/count_tokens
```

Claude 模型发现返回包装后的公开模型 ID，Messages 路由会安全解包后按 Trae Global、Trae CN 或豆包工作精确派发，不会跨 realm fallback。

## 验证

```bash
curl -sS http://127.0.0.1:10010/health
curl -sS -H 'user-agent: codex-cli' http://127.0.0.1:10010/v1/models
curl -sS -H 'user-agent: claude-cli' http://127.0.0.1:10010/v1/models
```

如配置了 `X_ADAPTER_CLIENT_TOKEN`，增加：

```bash
-H "authorization: Bearer $X_ADAPTER_CLIENT_TOKEN"
```

豆包工作仍只支持纯文本能力；客户端强制工具调用会返回明确错误，不会静默改路由到 Trae。Trae Global/CN 当前为实验性能力；官方客户端凭据/设备身份导入、Global SG/CN 模型目录、两个 realm 的最小非流式聊天、Global 流式输出边界/客户端取消，以及一次 Global DeviceProof refresh 已完成本机验证。CN refresh、工具调用和 reasoning 仍需分别验证。真实使用前请阅读运行手册中关于共享 token family 与设备身份的风险说明。
