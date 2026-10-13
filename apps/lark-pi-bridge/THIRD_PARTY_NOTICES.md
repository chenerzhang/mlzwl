# Third-party notices

## `zarazhangrui/lark-coding-agent-bridge`

本 package 的产品边界、Lark channel 接入思路和部分早期调研来自：

- Repository: <https://github.com/zarazhangrui/lark-coding-agent-bridge>
- Reviewed source commit: `589868119ce9a0a860aaf4936b5f9bac14e72681`
- License: MIT

本 package 已重新实现为 Pi-only bridge；未包含 Claude/Codex adapter、其协议 translator 或上游 Web UI 源文件。保留本 notice 以记录受控来源与上游 MIT 归属。

## Pi coding agent

Pi CLI 由用户在本机单独安装和配置；本 package 不将其作为运行时依赖打包。

- Package: `@earendil-works/pi-coding-agent`
- License: MIT（以安装版本为准）

## `@larksuite/channel`

该 package 运行时使用 `@larksuite/channel` 连接飞书/Lark。其许可证和发行内容以 lockfile 所固定版本为准。
