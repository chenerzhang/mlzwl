#!/usr/bin/env bash
# 把 openhongguo 包里的 WASM 运行时同步进 Android assets。
#
# 这两个文件是构建产物，不入仓（见 .gitignore）。WASM 约 6.5 MB，
# 直接提交会让仓库膨胀，且它随 node_modules 里的包版本变化。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
sdk_dir="$repo_root/node_modules/.pnpm/openhongguo@0.1.0/node_modules/openhongguo/dist"
dest="$here/app/src/main/assets"

if [[ ! -f "$sdk_dir/openhongguo.wasm" ]]; then
  echo "找不到 $sdk_dir/openhongguo.wasm" >&2
  echo "请先在仓库根执行 pnpm install" >&2
  exit 1
fi

mkdir -p "$dest"
cp "$sdk_dir/openhongguo.wasm" "$sdk_dir/wasm_exec.js" "$dest/"
echo "已同步:"
ls -lh "$dest/openhongguo.wasm" "$dest/wasm_exec.js"
