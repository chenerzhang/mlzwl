# mlzwl

个人项目 monorepo，使用 pnpm workspace 管理。

## Packages

- [`@mlzwl/lark-pi-bridge`](apps/lark-pi-bridge)：把飞书/Lark 消息桥接到本机 Pi coding agent。
- [`@mlzwl/x-adapter`](apps/x-adapter)：Trae 与豆包工作的本地模型网关。

## 开发

要求 Node.js `>=22.19.0` 和 pnpm `11.24.0`。

```bash
pnpm install
pnpm build
pnpm verify
```

单独验证 x-adapter：

```bash
pnpm --filter @mlzwl/x-adapter verify
pnpm --filter @mlzwl/x-adapter pack:dry-run
```

单独验证 bridge：

```bash
pnpm --filter @mlzwl/lark-pi-bridge verify
pnpm --filter @mlzwl/lark-pi-bridge smoke:local
pnpm --filter @mlzwl/lark-pi-bridge pack:dry-run
```

## 本地 npm 发布

维护者将 `.env.example` 复制为 `.env`，填写仅授权目标包的 npm Granular Access Token，并将文件权限设为 `0600`。`.env` 已被 Git 忽略；不要提交或输出其中的 token。

```bash
cp .env.example .env
chmod 600 .env
pnpm npm:auth-check
pnpm npm:publish:preflight
pnpm npm:publish:local
```

`npm:publish:local` 会真实发布当前 `master` 中的版本。它要求工作区干净且本地 `master` 与 `origin/master` 完全一致，并在发布前后核验 npm tarball 的 integrity、shasum 和 `latest`。发布后会为 npm 的异步处理预留最长约 5 分钟；结果仍不明确时先回读 registry，不要直接重复执行。
