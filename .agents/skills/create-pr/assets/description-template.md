# PR Description 模板

PR description 必须使用以下结构，并基于最终已推送的 commit 与 diff 填写：

```md
## Summary

用 1–2 句话简洁描述这个 PR 做了什么。

## Changes

- 具体变更 1
- 具体变更 2
- 必要时说明实际执行的验证及结果

## Impact

- 影响的模块或功能
- 有证据支持的兼容性、安全或运维风险；没有具体风险时不编造风险

🤖 Summarized by <AgentName>
```

规则：

- `Summary`、`Changes`、`Impact` 三个主章节必须保留。
- 内容优先使用中文，但代码标识、命令和专有名词保持原样。
- 多 commit PR 按行为归并，不逐条复制 commit subject。
- 只有实际执行过的验证才能写入；未执行但需说明时，明确写“未执行：<原因>”。
- `AgentName` 使用当前执行流程的 Agent 名称，不是模型名称。
- 不包含 token、Cookie、JWT、认证 header、真实凭据或内部请求体。
