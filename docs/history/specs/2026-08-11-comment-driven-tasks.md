# Spec：评论即指令（comment-driven-tasks）

- 日期：2026-08-11
- 状态：已确认（来源 `docs/ROADMAP.md` 迭代项 5；真注入不可行的技术结论已记录）
- 分支：`comment-driven-tasks`

## 目标

issue 下的评论就是指令通道：写完即走，agent 在合适的时机接着干。两种语义：

- **完成后续作**：无活跃任务时，member 评论 → 自动入队新任务（评论随 TaskPackage.comments 进 prompt）
- **排队接力转向**：有 running 任务时，评论 → 入队排队，当前任务结束后接力（kimi `-p` 一次性 headless 无 stdin 注入通道，真·执行中注入不可行——技术结论见 ROADMAP 迭代项 5）

## 范围 A：server 评论触发

现状：`POST /api/issues/:id/comments`（routes/issues.ts）落库 member 评论并广播，返回 `{id}`，无任何触发。`enqueueForIssue`（services/issues.ts）已有 assignee/状态守卫与 pending 唯一索引去重。

改动：

1. 新增服务函数（如 `enqueueForComment(db, issue)` 或给 enqueueForIssue 加原因返回），返回判别结果：
   - `enqueued`：成功入队（trigger="comment"，系统评论 `任务已入队（触发：comment）`）
   - `merged_into_pending`：已有 queued/dispatched 任务，评论自然合并（claim 时带最近 10 条评论），不新建任务
   - `assignee_not_agent`：未指派 agent，不触发
   - `status_inactive`：issue 处于 backlog/done/cancelled，不触发
2. 评论路由响应扩展为 `{id, trigger: {enqueued: boolean, task_id?: string, reason?: string}}`；入队成功时 `hub.hintDaemons(task.available)`（对齐现有两处入队点）。
3. 防环：只有路由写入的 member 评论参与触发；system/agent 评论走 addComment 直写，不经路由，天然不触发。
4. 连续评论去重由 pending 唯一索引保证（第一条入队后，后续评论命中 merged_into_pending）。

测试（`apps/server/test`，沿用现有风格）：
- 无活跃任务 + assignee=agent + todo → 201 且 trigger.enqueued=true，任务 queued，时间线有"任务已入队（触发：comment）"
- 已有 queued 任务 → enqueued=false reason=merged_into_pending，任务数不增
- running 任务存在时 → enqueued=true（新 queued 任务共存；唯一索引不挡 running）
- 未指派 agent → reason=assignee_not_agent
- issue done → reason=status_inactive
- 触发后 daemon claim 的 TaskPackage.comments 含该评论（链路闭环）

## 范围 B：web 发送反馈

现状：TaskPanel 评论框发送后静默成功，无触发结果反馈（`api.addComment` 只返回 `{id}`）。

改动：

1. `api.addComment` 返回类型扩展（含 trigger 字段）。
2. TaskPanel 发送评论后在输入框下方显示一行结果提示（muted 小字，下次发送或切换任务时清除）：
   - enqueued → `已触发新任务（排队接力）`
   - merged_into_pending → `已合并进排队任务，认领时生效`
   - assignee_not_agent → `未指派 Agent，评论仅记录不触发执行`
   - status_inactive → `当前状态不触发执行（收集箱/已完成/已取消）`
3. 时间线自动出现系统评论（现有 reload 链路覆盖，无需额外做）。
4. web 测试：addComment 返回 trigger 时 TaskPanel 展示对应提示（组件测试，mock api）。

## 非目标

- 真·执行中注入（不可行，已记录技术结论）
- @mention 解析、快速创建（迭代项 9）
- diff 内联评论回喂（迭代项 4）

## 验收对齐

对应 ROADMAP 迭代项 5（2026-08-11 修订版）验收标准；合并门槛：pnpm test 全绿 + 四包 tsc 零错 + test-craft 用例执行回填（`docs/tests/2026-08-11-comment-driven-tasks-testcases.md`）。
