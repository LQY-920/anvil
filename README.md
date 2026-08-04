# Anvil

个人 AI Agent 工作台（一期：编码任务调度）。看板创建 issue → 指派 Agent → 本地 runner 认领 → git worktree 中由 Kimi Code CLI 自主执行 → 日志流实时回看板 → 完成进 in_review。

设计文档：`docs/superpowers/specs/2026-08-04-anvil-design.md`

## 快速开始

前置：Node ≥ 20、pnpm、Git、Kimi Code CLI（`kimi --version` 可见）。

```bash
pnpm install

# 1. 启动 server（127.0.0.1:3100，SQLite 文件 anvil.db）
pnpm dev:server

# 2. 打开 web（127.0.0.1:5173），在 Agents 页：
#    a. 创建一个 Agent（provider=kimi）
#    b. 生成 daemon token 并复制
pnpm dev:web

# 3. 启动 runner（另一个终端）
set ANVIL_DAEMON_TOKEN=anv_xxx   # Windows cmd；PowerShell 用 $env:ANVIL_DAEMON_TOKEN="anv_xxx"
pnpm dev:runner

# 4. 看板新建 issue → 指派给 Agent → 观察自动执行
```

## 测试

```bash
pnpm test
```

## License

MIT（见 LICENSE）。本项目为独立实现，与 Multica 无代码继承关系。
