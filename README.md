# Anvil

个人 AI Agent 工作台（一期：编码任务调度）。看板创建 issue → 指派 Agent → 本地 runner 认领 → git worktree 中由 Kimi Code CLI 自主执行 → 日志流实时回看板 → 完成进 in_review。

设计文档：`docs/superpowers/specs/2026-08-04-anvil-design.md`

## 快速开始

前置：Node ≥ 20、pnpm、Git、Kimi Code CLI（`kimi --version` 可见）。

```bash
pnpm install

# 一条命令同时启动 server / web / runner
pnpm dev

# runner 需要 daemon token（在 web 的 Agents 页生成并复制）：
set ANVIL_DAEMON_TOKEN=anv_xxx   # Windows cmd；PowerShell 用 $env:ANVIL_DAEMON_TOKEN="anv_xxx"

# 看板新建 issue → 指派给 Agent → 观察自动执行
```

也可以分终端启动（便于单独看日志）：

```bash
pnpm dev:server   # 127.0.0.1:3100，SQLite 文件 anvil.db
pnpm dev:web      # 127.0.0.1:5173
pnpm dev:runner   # 需先设置 ANVIL_DAEMON_TOKEN
```

## 测试

```bash
pnpm test
```

## License

MIT（见 LICENSE）。本项目为独立实现，与 Multica 无代码继承关系。
