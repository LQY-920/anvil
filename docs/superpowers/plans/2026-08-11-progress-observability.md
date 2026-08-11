# Plan：任务进展可解释性（progress-observability）

- 日期：2026-08-11 | Spec：`docs/superpowers/specs/2026-08-11-progress-observability.md`
- 分支：`progress-observability`

## 任务拆分（subagent 并行，文件互不重叠）

### T1 · server 状态自动流转（coder）

文件：`apps/server/src/services/tasks.ts`、`apps/server/src/routes/daemon.ts`、（如需）`apps/server/src/services/issues.ts`、`apps/server/test/`

- 服务层新增 `autoAdvanceIssue`（或等价）：start 成功 → issue todo→in_progress；complete 成功且 branch 非空 → issue todo/in_progress→in_review。写 system 评论（`todo → in_progress（开始执行）` / `<old> → in_review（产出待验收）`）。
- `startTask`/`completeTask` 目前返回 boolean——最小改动：服务函数返回迁移结果或路由层调用后查询；路由（`/start`、`/complete`）在有迁移时广播 `issue.updated`（参考 `issue-status` 路由现有写法）。
- 测试：沿用现有 server 测试风格（真实 SQLite），覆盖 spec 范围 A 全部条目。
- 红线：不改 `setIssueStatusFromAgent` 语义；不动 `delivered_at`；不影响 enqueueForIssue。

### T2 · web 语义时间线 presenter（coder）

文件：`apps/web/src/lib/trace-presenter.ts`（新增）、`apps/web/src/components/TaskPanel.tsx`、`apps/web` 测试目录（先看现有测试落位再匹配约定）

- 按 spec 范围 B 实现 presenter 纯函数 + TaskPanel 渲染替换 + 顶部进度摘要行。
- 先看 TaskPanel 当前消息渲染与 `api.ts` 的消息类型（`type/tool/content/input_json/output`），presenter 输入即该消息形状。
- 单测覆盖 spec 列出的全部条目。
- 红线：不改 BoardPage/其他组件；样式用现有 Tailwind 类与语义 token（参考 TaskPanel 现有 className），不引入新依赖。

### T3 · web 通知 + 活信号角标（coder）

文件：`apps/web/src/lib/notify.ts`（新增）、`apps/web/src/ws.ts`（如需）、`apps/web/src/pages/BoardPage.tsx`、`apps/web` 测试目录

- `shouldNotify(prev, curr, now, dedupMap)` 纯函数：三事件判定 + 10 分钟去重；`notify()` 封装 Notification 授权/降级（document.title `● ` 前缀）。
- BoardPage：WS 事件流接入通知（reload 时对比前后 issues/latest_task 状态）；`?task=<id>` query 自动打开面板（复用 openIssue 逻辑，需按 task id 找 issue——可先 `GET /api/tasks/:id` 取 issue_id）；通知点击 focus+跳转。
- TaskCard 活信号角标：latest_task running/dispatched→绿点脉冲，queued→半透明灰点。
- 单测：shouldNotify 全部分支。
- 红线：不动 TaskPanel.tsx（T2 在改）；不引入新依赖；沿用现有 Tailwind/shadcn 约定。

## 串行阶段（实现完成后）

- T4 · test-craft：生成 `docs/tests/2026-08-11-progress-observability-testcases.md`（接口：状态迁移 4 条；页面：时间线渲染/通知/角标/降级），执行并回填（我执行，不经 subagent）
- T5 · 两段审查：我自查 diff + review subagent 独立审
- T6 · 合并门槛：pnpm test 全绿 + 四包 tsc 零错 → 合并 main → 推送 → 更新 PROGRESS.md（+ROADMAP 标记项 1/2/3 完成）
