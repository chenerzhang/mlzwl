# mlzwl

个人项目 monorepo，使用 pnpm workspace 管理。

## Packages

- [`@mlzwl/lark-pi-bridge`](apps/lark-pi-bridge)：把飞书/Lark 消息桥接到本机 Pi coding agent。

## 开发

要求 Node.js `>=22.19.0` 和 pnpm `11.24.0`。

```bash
pnpm install
pnpm build
pnpm verify
```

单独验证 bridge：

```bash
pnpm --filter @mlzwl/lark-pi-bridge verify
pnpm --filter @mlzwl/lark-pi-bridge smoke:local
pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
```
