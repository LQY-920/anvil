# 2026-10-10 main 共同开发基线验证

目的：将已有交付证据基础与六项需求材料合入共同 main，供贡献者认领。此次不验收 T01–T06、J01、旧 R2 或 H01，也不发布版本。

## 代码与环境

- 原 main：`4323656a79e41dc6a2b21881f9adb5018ab3a955`。
- 首轮候选：`26b6249bae00a6327535be0ffbacb0681e2e95e7`，包含 21 个基础代码提交及文档整理。
- 修复后代码：`144e69fcc67bfad8fe41a53227ae90d729565b7a`；后续提交仅更新协作/验证文档。最终 main SHA 以基线 PR 的 merge commit 为准。
- 执行环境：Windows 11，Node 22.18.0，pnpm 10.0.0，Git 2.50.1.windows.1。执行人：主 Codex 会话。
- 使用内存测试数据库和临时 Git 仓库；未运行真实 Kimi/Codex、未迁移日常数据库。

## 发现与回归

| 用例 | 步骤与期望 | 修复前 | 修复后 |
|---|---|---|---|
| BASE-TC01 · 历史 v1 Git 任务 | 真实 Server 创建 Git 任务，模拟迁移保留 version=1、max_attempts=1；claim 后执行 Agent backend，在 worktree commit 并调用旧 issue-status。须仅执行一次、completed、保留 v1、无伪造 v2 证据、有 diff、主仓库 HEAD 不变 | 失败：start 返回 400，task_value=1/payload_value=2，backend 未执行 | 通过 |
| BASE-TC02 · 既有 v2 证据链 | 同文件两条 Fake CLI 场景分别让终检退出 0/7；真实 Report、Git facts、Verification/Checks 原子落库，结果正确区分 | 既有通过 | 通过 |

问题由独立静态审查发现。Runner 原先向全部 Git 任务传递 v2 Start 锚点，导致旧 v1 任务违反服务端版本一致性校验。修复仅在 v2 时传递这些锚点，保留服务端校验和旧任务版本。自动化位置：`apps/runner/test/e2e.test.ts`。

## 实际命令与结果

1. 首轮 `pnpm test`：41 文件 / 861 用例通过；该结果未覆盖上述缺口。
2. 新增用例后、修复前：`pnpm --filter @anvil/runner test test/e2e.test.ts -t '升级前排队'`，1 失败 / 3 跳过，确认用例捕获实际回归。
3. 修复后：`pnpm --filter @anvil/runner test test/e2e.test.ts`，4/4 通过。
4. 固定在代码 `144e69f` 后串行执行完整门槛：

| 检查 | 结果 |
|---|---|
| `pnpm test` · Core | 3 文件 / 161 用例通过 |
| `pnpm test` · Server | 20 文件 / 411 用例通过 |
| `pnpm test` · Runner | 9 文件 / 211 用例通过 |
| `pnpm test` · Web | 9 文件 / 79 用例通过 |
| 全量合计 | 41 文件 / 862 用例通过 |
| `pnpm build` | 四包构建通过；Vite 报告 Core 中 node:crypto/node:path 的浏览器外置警告，无构建失败 |
| 四包各执行 `pnpm exec tsc --noEmit -p tsconfig.json` | 全部通过，零类型错误 |
| 文档链接、PRD/hash、待认领/未执行状态、diff | 56 份 Markdown 链接通过；六 PRD/hash、PDF 来源清单和历史锁定原文一致；70+3 条新任务用例仍未执行；diff 检查通过 |

首次受限执行因 pnpm 工具缓存写入 EPERM 未进入测试；按本次合入授权在本机权限下执行上述命令。产品测试、build、noEmit 没有交叉运行。原始日志留在本地忽略目录 tmp，不作为贡献者必需材料。

## 审查与限制

- 自审：主 Codex 核对分支增量、工作区、迁移/兼容影响、测试结果及文档一致性。
- 独立审查 1：`baseline_code_review` 只读审查 Runner/Core/证据边界，发现 BASE-TC01；修复后复核确认闭环，无其他确定的新阻塞。
- 独立审查 2：`baseline_server_review` 只读审查 Server/DB/Web、迁移、事务/授权/计时，未发现新增确定阻塞。
- 上述为独立 Agent 静态审查，不冒充人类 GitHub 审批、真实 CLI 验收或跨平台实测。
- 页面 Diff 仍浮动、旧 URL 合入 push 失败仍可能误 done、实时 Git Gate 尚未完成，保留在 T01 与 PROGRESS Backlog；不能借基线合入声称这些问题已解决。T01–T06、J01、旧 R2/H01 均未验收。
