# 任务进展可解释性 测试用例文档

> 来源需求: docs/history/specs/2026-08-11-progress-observability.md
> 生成日期: 2026-08-11 | 产品形态: 网站 | 用例数: 10
> 来源章节基线: 分支 progress-observability（T1/T2/T3 实现完成后）

## 全局准备

- 接口用例（独立实例）：`cd apps/server && rm -f anvil-test.db* && ANVIL_PORT=3101 ANVIL_DB=anvil-test.db pnpm dev`；`BASE=http://127.0.0.1:3101`；经 `GET $BASE/api/bootstrap` 取 WSID；`POST /api/agents`（体 `{"name":"e2e-bot","provider":"kimi","max_concurrent_tasks":2}`）取 AID；`POST /api/daemon-tokens` 取 DTOKEN；`POST /api/daemon/register`（Bearer DTOKEN，体 `{"daemon_id":"d-e2e","runtimes":[{"provider":"kimi","version":"e2e-1.0"}]}`）。
- 页面用例（记 P1 环境）：`pnpm dev` 三端已启动，浏览器打开 `http://localhost:5173`。
- 页面用例驱动 API 时直接对真实实例 `http://127.0.0.1:3100` 发请求。

## 用例列表

### TC-Obs_001 开始执行_待办Issue_自动转进行中且写评论

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；已创建指派 $AID 的 Issue（title "自动流转一探针"），经 claim 使执行 T 进入 dispatched，其 task_token 记为 TTASK，Issue id 记为 IID
- 测试数据: [work_dir: D:/anvil]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/start`，头 `Authorization: Bearer $TTASK`，体 `{"work_dir":"D:/anvil"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. issue.status="in_progress"；comments 含一条 author_type="system"、type="status_change"、body="todo → in_progress（开始执行）"
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Obs_002 开始执行_阻塞Issue_不自动迁移

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；已创建指派 $AID 的 Issue（id 记为 IID）并 PATCH 为 `{"status":"blocked"}`；其执行 T（id 记为 TID，凭据 TTASK）经 claim 进入 dispatched
- 测试数据: [work_dir: D:/anvil]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/start`，头 `Authorization: Bearer $TTASK`，体 `{"work_dir":"D:/anvil"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. issue.status 仍为 "blocked"；comments 不含 body 为 "blocked → in_progress（开始执行）" 的记录
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Obs_003 完成执行_有交付分支_自动转待验收

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；执行 T（id 记为 TID，凭据 TTASK）已经 start 处于 running，其 Issue（id 记为 IID）已被自动迁移为 in_progress
- 测试数据: [branch: task/obs0001] [diff_stat: 1 file changed]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/complete`，头 `Authorization: Bearer $TTASK`，体 `{"branch":"task/obs0001","diff_stat":"1 file changed"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
  3. 执行请求 `GET $BASE/api/tasks/$TID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. issue.status="in_review"；comments 含 body="in_progress → in_review（产出待验收）" 的 status_change 记录
  3. HTTP 200；task.delivered_at 为 null（自动流转不写入交付信号；complete 后任务凭据已作废，不能走 delivery 端点验证）
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Obs_004 完成执行_无交付分支_不迁移

- 优先级: P1 | 类型: 接口
- 前置条件: 同 TC-Obs_003 前置（T running，Issue 处于 in_progress）
- 测试数据: [请求体: {"work_dir":"D:/anvil"}]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/complete`，头 `Authorization: Bearer $TTASK`，体 `{"work_dir":"D:/anvil"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. issue.status 仍为 "in_progress"；comments 不含任何 body 含 "→ in_review（产出待验收）" 的记录
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Obs_005 完成执行_Issue已完成_不倒退

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；执行 T（id 记为 TID，凭据 TTASK）处于 running；其 Issue（id 记为 IID）已经 agent 回调 `POST /api/daemon/tasks/$TID/issue-status`（体 `{"status":"done"}`）置为 done
- 测试数据: [branch: task/obs0002]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/complete`，头 `Authorization: Bearer $TTASK`，体 `{"branch":"task/obs0002"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. issue.status 仍为 "done"；comments 不含 body 含 "→ in_review（产出待验收）" 的记录
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Obs_006 执行日志_混合消息_分层渲染

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；打开一个含工具调用与正文消息的任务面板（如已完成的真实任务）
- 测试步骤:
  1. 检查执行日志区的消息渲染
- 预期结果:
  1. tool_use 消息为单行摘要（工具名 + 关键参数，长路径显示为 `.../父目录/文件名`），输出默认折叠；agent 正文直接可读不折叠；thinking 与工具结果默认折叠；日志区无原始 JSON 整段倾倒
- 执行结果: ✅ 通过 (2026-08-11，修复后复跑) | 首执行实际: tool_use 行只有工具名无关键参数 | 缺陷: input_json 双重编码（OpenAI 风格 arguments 为字符串，落库被二次 stringify），已修复并重跑通过（实测行："Bash git log --oneline -5 && ..."、"Edit claude-progress.txt"）

### TC-Obs_007 进度摘要_有工具调用_显示计数与最近动作

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；同 TC-Obs_006 的面板已打开
- 测试步骤:
  1. 检查执行日志区顶部的摘要行
- 预期结果:
  1. 显示等宽小字摘要行，格式为 `工具调用 N 次 · 错误 N · 最近：<动作>`，N 与日志实际条数一致
- 执行结果: ✅ 通过 (2026-08-11) | 实测: 摘要行 "工具调用 5 次 · 错误 0 · 最近：Bash curl ..."，与接口消息计数一致

### TC-Obs_008 通知降级_权限拒绝_标题圆点且卡片出注意点

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；浏览器对该站点的通知权限为拒绝（或在授权弹窗中选拒绝）；看板页已打开
- 测试步骤:
  1. 对真实实例执行：创建指派 agent 的 Issue（体 `{"title":"通知降级探针","assignee_type":"agent","assignee_id":"<AID>"}`），随后经 register/claim/start/complete（complete 体含 `{"branch":"task/obs0003"}`）驱动其进入待验收
  2. 等待 5 秒，检查浏览器标签页标题与看板卡片
  3. 点击该卡片打开面板
  4. 检查标签页标题与卡片注意点
- 预期结果:
  1. 各请求返回预期状态码（201/200）
  2. 标签页标题以 "● " 开头；该卡片左上角显示琥珀色注意点
  3. 面板打开
  4. 标题 "● " 前缀消失；卡片注意点消失
- 执行结果: ✅ 通过 (2026-08-11) | 实测: 降级后 title="● Anvil" 且卡片出琥珀点；点开面板后 title 还原 "Anvil"、注意点消失（Notification 以 defineProperty 屏蔽模拟拒绝场景；探针任务/凭据已清理吊销）

### TC-Obs_009 活信号角标_排队与派发_显示灰点与绿脉冲

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；看板页已打开；真实实例已注册 daemon（d-page）且存在有效 agent
- 测试步骤:
  1. 创建指派 agent 的 Issue（title "角标探针"）
  2. 等待 5 秒，检查该卡片左上角角标
  3. 执行 claim（体 `{"daemon_id":"d-page","max_tasks":1}`）使执行进入 dispatched
  4. 等待 5 秒，检查该卡片左上角角标
  5. 执行取消（`POST /api/tasks/<id>/cancel`）清理现场，并将 Issue PATCH 为 cancelled
- 预期结果:
  1. HTTP 201
  2. 卡片左上角显示半透明灰点
  3. claim 返回 tasks 长度 1
  4. 灰点变为绿点脉冲
  5. HTTP 200；卡片角标消失
- 执行结果: ✅ 通过 (2026-08-11) | 实测: 排队时灰点 bg-zinc-400/60 → claim 后绿点脉冲（animate-ping/emerald）→ 取消并置已取消后角标消失

### TC-Obs_010 通知链接_带task参数_自动打开面板

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；存在一个可打开面板的任务，其 id 记为 TID
- 测试步骤:
  1. 浏览器地址栏打开 `http://localhost:5173/?task=$TID`
  2. 检查页面
- 预期结果:
  1. 看板加载完成
  2. 该任务的面板自动打开，标题为对应 Issue 标题
- 执行结果: ✅ 通过 (2026-08-11) | 实测: /?task=d0bea8ec… 打开后面板自动出现，标题"检查开发进度"

## 需求覆盖矩阵

| 功能点 | 来源章节 | 用例编号 |
|--------|----------|----------|
| start 自动迁移（todo→in_progress + 评论） | spec 范围 A.1 | TC-Obs_001、002 |
| complete 自动迁移（有 branch →in_review） | spec 范围 A.2 | TC-Obs_003、004、005 |
| delivered_at 语义不受自动流转影响 | spec 范围 A.3 | TC-Obs_003（步骤 3） |
| 语义时间线分层渲染 | spec 范围 B.1/2 | TC-Obs_006 |
| 进度摘要行 | spec 范围 B.2 | TC-Obs_007 |
| 通知授权降级（标题圆点 + 卡片注意点） | spec 范围 C.1 | TC-Obs_008 |
| 活信号角标（queued/dispatched/running） | spec 范围 C.2 | TC-Obs_009 |
| 通知点击定位面板（?task=） | spec 范围 C.1 | TC-Obs_010 |

## 执行汇总

- 总数 10 | 通过 10 | 失败 0 | 阻塞 0 | 未执行 0 | 通过率 100%（已执行 10 条；TC-Obs_006 为首执行发现缺陷、修复后复跑通过）
- 缺陷清单:
  - TC-Obs_006（已修复）: tool_use 摘要缺关键参数 | 实际: 页面仅显示工具名 | 预期: 工具名+关键参数 | 根因: OpenAI 风格 `function.arguments` 为 JSON 字符串，server 落库时二次 stringify 造成双重编码 | 修复: core `coerceInput` 源头解析 + presenter `parseInput` 双重解析容错（两处均 TDD）
