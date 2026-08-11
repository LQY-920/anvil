# Plan：评论即指令（comment-driven-tasks）

- 日期：2026-08-11 | Spec：`docs/superpowers/specs/2026-08-11-comment-driven-tasks.md`
- 分支：`comment-driven-tasks`

## 任务拆分（两个 subagent 并行，文件不重叠）

### T1 · server 评论触发（coder）

文件：`apps/server/src/services/issues.ts`、`apps/server/src/routes/issues.ts`、`apps/server/test/`

- 服务层：`enqueueForIssue` 目前返回 Task|null、四种 null 场景不可区分。最小改动方案：新增 `enqueueForComment(db, issue): { enqueued: true, task: Task } | { enqueued: false, reason: "merged_into_pending" | "assignee_not_agent" | "status_inactive" }`（内部可复用/重构 enqueueForIssue，保持现有三处调用点行为不变）。
  - assignee_type!=="agent" 或无 assignee_id → assignee_not_agent
  - status ∈ backlog/done/cancelled → status_inactive
  - 已有 queued/dispatched（唯一索引冲突）→ merged_into_pending
  - 否则插入 queued 任务（trigger="comment"，系统评论"任务已入队（触发：comment）"）
- 路由：`POST /api/issues/:id/comments` 响应 `{id, trigger}`；enqueued 时 hintDaemons(task.available)。
- 测试：按 spec 范围 A 的六条。先读 apps/server/test 现有 issues 相关测试匹配风格。

### T2 · web 发送反馈（coder）

文件：`apps/web/src/api.ts`、`apps/web/src/components/TaskPanel.tsx`、`apps/web/test/`

- api.addComment 返回 `{id, trigger?: {enqueued: boolean, task_id?: string, reason?: string}}`。
- TaskPanel 发送后在输入框下方一行 muted 小字提示（四态文案见 spec），发送新评论或切换任务时清除。
- 组件测试：mock api.addComment 返回不同 trigger，断言提示文案；沿用 apps/web/test 现有组件测试写法。

## 串行阶段

- T3 · test-craft：生成 `docs/tests/2026-08-11-comment-driven-tasks-testcases.md` 并执行回填（我执行）
- T4 · 两段审查：自查 + review subagent
- T5 · 合并门槛 → 合并 main → 推送 → 更新 PROGRESS.md / ROADMAP.md（迭代项 5 勾掉）
