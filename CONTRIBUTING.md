# Contributing to Anvil

感谢你愿意为 Anvil 做贡献。本文档说明本地开发流程、代码规范和提交要求。

## 前置环境

- Node.js ≥ 20
- pnpm 10（项目通过 `packageManager` 字段锁定）
- Git
- Kimi Code CLI（`kimi --version` 可见）

## 本地开发

```bash
pnpm install

# 分别启动三个应用（各占一个终端）
pnpm dev:server   # server，127.0.0.1:3100
pnpm dev:web      # web，127.0.0.1:5173
pnpm dev:runner   # runner，需先设置 ANVIL_DAEMON_TOKEN
```

## 仓库结构

- `apps/server` — API server（SQLite 存储，任务调度）
- `apps/runner` — 本地 runner，认领任务并在 git worktree 中执行
- `apps/web` — 看板前端
- `packages/core` — 共享代码
- `docs/` — 设计文档

## 代码规范

- 全部使用 TypeScript，`type: "module"`（ESM）。
- 改动前先读相关文件，复用项目已有模式；不引入不必要的新依赖。
- 保持改动最小化：只动任务要求的文件，匹配周围代码风格，不混入格式化改动。
- 注释、提交信息跟随仓库现有语言习惯。

## 测试

提交前务必运行并确认通过：

```bash
pnpm test
```

涉及 bug 修复时，请先写一个能复现问题的失败测试，再修复。

## 提交与分支

- 每个任务在独立分支（如 `task/<id>`）上进行，用 git commit 提交改动，保持分支不切换。
- Commit message 简明描述改动内容。
- 完成后将 issue 状态流转到 `in_review`，由维护者评审合并。

## License

贡献的代码按仓库的 MIT License 授权。
