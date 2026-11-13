# 第三方组件许可声明

本文件收录 `@mlzwl/hongguo` 各包内**以源码形式内联**的第三方作品许可。
只通过 `package.json` 依赖引入的包，其许可由各自的 `node_modules` 目录携带，
不在此重复。

---

## Phosphor Icons

**使用位置**：`web/src/components/icons.tsx`

**使用方式**：将图标 SVG 的 `path` 数据内联到本项目源码中，未引入
`@phosphor-icons/react` 运行时依赖。内联是为了控制首屏体积，不改变许可义务。

**原始项目**：https://github.com/phosphor-icons/core

**原始图标名**：每个导出的图标在 `icons.tsx` 中的注释标注了对应的 Phosphor
图标名（如 `arrow-left`、`clock-counter-clockwise`、`heart`、`heart-fill`、
`bell`、`bell-fill`、`trend-up`、`magnifying-glass`、`sparkle`、`dots-three`、
`sun`、`moon`、`play`、`pause`、`speaker-high`、`speaker-slash`、`arrows-out`、
`arrows-in`、`caret-left`、`caret-right`、`x`、`download-simple`、`caret-down`、
`check`、`trash`）。

**许可**：MIT

```
MIT License

Copyright (c) 2020 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
