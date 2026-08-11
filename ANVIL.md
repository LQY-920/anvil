# ANVIL.md — Anvil 仓库常驻指引

本文件由 Anvil 平台在任务执行时自动注入 prompt（runner 读取 <仓库根>/ANVIL.md，超 8KB 截断）。

## 改动纪律

- 完成后必须验证：`pnpm test` 全绿 + 四包 tsc 零错（packages/core、apps/server、apps/runner、apps/web 各执行 `pnpm exec tsc --noEmit -p tsconfig.json`）
- diff 最小化：不碰任务未要求的文件，不混入格式化改动；匹配周边代码风格与注释密度
- 新行为配测试：server / runner / web 各有 vitest，沿用现有测试写法（server 用 buildApp :memory: + app.inject；web 组件测试 mock ../src/api.js）
- UI 文案用简洁中文；样式走语义 token 与现有 Tailwind 类，不硬编码色值，不引入新依赖
- 文档同步：行为变更涉及 docs/PROGRESS.md 的 backlog/约定时，一并更新
