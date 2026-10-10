# Anvil

个人 AI Agent 工作台（一期：编码任务调度）。看板创建 issue → 指派 Agent → 本地 runner 认领 → git worktree 中由 Kimi Code CLI 自主执行 → 日志流实时回看板 → 完成进 in_review。

新协作者从[总任务清单](docs/TASKS.md)选择独立 PRD，在[交接记录](docs/handoffs/README.md)认领并更新进度；开发方式见[贡献指南](CONTRIBUTING.md)，资料索引见[文档地图](docs/README.md)。

2026-10-10：移除总 PRD v0.2，改为六项任务各自一份 PRD、测试用例和交接记录。Git/GitHub 与 Codex 可分别认领、并行开发，联合验收后再接 Factory；后续为内部频道线程、手机、pi/dsh。全部待正式认领。当前代码仍只有 Kimi adapter，旧 R2 未通过；本轮只整理文档，未实现或发布这些功能。

## 快速开始

开发/查看页面前置：Node ≥ 20、pnpm、Git，无需 Kimi。下列 Runner 步骤描述当前旧版 Kimi 执行能力；新版以 Codex 为首个默认执行器，尚不能通过配置直接启用。

```bash
pnpm install
```

首次运行先分别开终端启动后端和页面：

```bash
pnpm dev:server   # 127.0.0.1:3100，默认数据库 apps/server/anvil.db
pnpm dev:web      # 127.0.0.1:5173
```

若需复现旧版真实执行，另需 Kimi Code CLI（`kimi --version` 可见），在 Agents 页创建 Kimi Agent 和 daemon token。只做开发、页面检查和自动化测试的协作者可跳过 Runner，无需为新版工作安装 Kimi。旧版启动 Runner 时设置 token（占位符替换为本机值，不要提交或发送到聊天）：

```powershell
# PowerShell
$env:ANVIL_DAEMON_TOKEN = '<本机生成的 daemon token>'
pnpm dev:runner
```

Windows cmd 使用 `set ANVIL_DAEMON_TOKEN=<本机生成的 daemon token>`；Bash 使用 `export ANVIL_DAEMON_TOKEN='<本机生成的 daemon token>'`。Runner 注册上线后，在看板新建 Issue 并指派 Agent。

已有 token 时，可以先在终端配置它，再用 `pnpm dev` 同时启动三端；此时不要重复运行前面的独立服务。多副本开发的端口、数据库和 Runner 目录隔离见贡献指南。

## 测试

```bash
pnpm test
```

## License

MIT（见 LICENSE）。本项目为独立实现，与 Multica 无代码继承关系。
