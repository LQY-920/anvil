# Spec：任务进展可解释性（progress-observability）

- 日期：2026-08-11
- 状态：已确认（来源 `docs/ROADMAP.md` 迭代项 1+2+3，用户拍板的下一个主题）
- 分支：`progress-observability`

## 目标

派活即走、回来即懂。三根柱子：执行过程语义化、状态全自动流转、三类事件通知触达。

## 范围 A：server 状态自动流转

现状：issue 状态完全依赖 agent 回调 `issue-status`，不回调就停尸，`in_progress` 列永远空。

改动（`apps/server/src/services/tasks.ts` + `routes/daemon.ts`）：

1. `startTask` 成功且 issue 当前为 `todo` → 自动置 `in_progress`。仅 `todo` 迁移；`blocked/in_review/done/cancelled` 不动（blocked 是人工挂起，不抢）。写 status_change 评论（author_type=system，body `todo → in_progress（开始执行）`），路由层广播 `issue.updated`。
2. `completeTask` 成功且 result 含非空 `branch` 且 issue 当前为 `todo/in_progress` → 自动置 `in_review`。写评论（body `<old> → in_review（产出待验收）`），广播 `issue.updated`。
3. `failed` 不迁移 issue 状态（卡片 chip 已表达失败）。`complete` 无 branch（undelivered）不迁移——undelivered 追问链路（`delivered_at` 语义）不受影响，agent 回调仍是交付信号的唯一写入方。
4. 迁移逻辑收在服务层函数（如 `autoAdvanceIssue(db, taskId, event)` 返回迁移后的 issue 或 null），路由据此广播；不侵入现有 `setIssueStatusFromAgent`。

测试（`apps/server/test`，真实 SQLite :memory: 风格沿用现有）：
- start：todo → in_progress（含评论、含返回值）；blocked 不动；in_review 不动
- complete 有 branch：todo/in_progress → in_review；无 branch 不动；done 不动

## 范围 B：web 语义时间线 presenter

现状：TaskPanel 执行日志是近原始消息渲染，只有折叠没有分层语义。

改动（`apps/web`）：

1. 新增纯函数层 `src/lib/trace-presenter.ts`：`TaskMessage → RenderEntry { kind, title, body?, defaultCollapsed, tone }`：
   - `text` → 展开，正文色；`error` → 展开，destructive
   - `tool_use` → 单行摘要：工具名 + 关键参数（按工具名提取：Bash/Shell→`command`；Read/Write/Edit→`path`/`file_path`；Grep→`pattern`；Glob→`pattern`；其他→input JSON 摘要截断 80 字符）；Windows 长路径截断为 `.../parent/leaf`；`defaultCollapsed: true`（输出在 body，展开才见）
   - `thinking` / `tool_result` → 默认折叠；`status` / `log` → 单行 muted
   - 未知 `type` → 保底通用条目（kind `"unknown"`），内容原样可见，绝不丢弃
2. TaskPanel 执行日志区改用 presenter 渲染；面板顶部加进度摘要行：`工具调用 N 次 · 错误 N · 最近：<最近一条 tool_use 摘要或 text 节选>`（从已有消息数组统计，无新请求）。
3. 单测（vitest，jsdom 不需要——纯函数）：7 型各一条 + 未知类型 + 路径截断（`D:/very/deep/nested/dir/file.ts` → `.../dir/file.ts`）+ 关键参数提取 + 摘要统计。

## 范围 C：通知 + 看板活信号

1. 通知（`apps/web/src/lib/notify.ts` 纯函数 + hook 接入）：
   - 事件源：复用 `useServerEvents` 的 `task.updated` / `issue.updated` 广播。
   - 三类触发：① 待验收（task→completed 且 result_json 含 branch，或 issue→in_review）；② 终态失败（task→failed 且 attempt ≥ max_attempts）；③ idle 失败（failure_reason=idle_timeout，并入②的 failed 事件自然覆盖）。
   - 去重：同一 task 同类事件 10 分钟内只通知一次（内存 Map，刷新即清——可接受）。
   - 授权：`granted` 直接发；`default` 首次触发时 `requestPermission`；`denied`/不可用 → 降级：`document.title` 加 `● ` 前缀 + 对应卡片显示注意角标，打开该任务面板时清除。
   - 点击通知：`window.focus()` + 跳转 `/?task=<taskId>`；BoardPage 加载时读 query 自动打开对应面板。
2. 活信号角标（BoardPage TaskCard）：按 `latest_task.status`——`running/dispatched` → 绿点脉冲；`queued` → 半透明灰点。与现有 agent presence 点统一（以 latest_task 为准，agent 名旁的点保留现状）。
3. 单测：`shouldNotify` 三事件 + 10 分钟去重 + 降级分支（mock Notification）。

## 非目标（本主题不做）

- 计划审批点（用户委托决定：不做，理由已记录 ROADMAP）
- 外部通知通道（ntfy/Gotify 仅记录候选）、移动端
- diff 内联评论（迭代项 4）、评论触发任务（迭代项 5）、guidance（迭代项 6）——后续主题
- transcript 虚拟化（P2 清扫包）

## 验收对齐

逐项对应 ROADMAP 迭代项 1/2/3 的验收标准；合并门槛：pnpm test 全绿 + 四包 tsc 零错 + test-craft 用例执行回填（`docs/tests/2026-08-11-progress-observability-testcases.md`）。
