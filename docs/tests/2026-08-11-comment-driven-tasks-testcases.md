# 评论即指令 测试用例文档

> 来源需求: docs/superpowers/specs/2026-08-11-comment-driven-tasks.md
> 生成日期: 2026-08-11 | 产品形态: 网站 | 用例数: 8
> 来源章节基线: 分支 comment-driven-tasks（T1/T2 实现完成后）

## 全局准备

- 接口用例（独立实例）：`cd apps/server && rm -f anvil-test.db* && ANVIL_PORT=3101 ANVIL_DB=anvil-test.db pnpm dev`；`BASE=http://127.0.0.1:3101`；经 `GET $BASE/api/bootstrap` 取 WSID；`POST /api/agents`（体 `{"name":"e2e-bot","provider":"kimi","max_concurrent_tasks":2}`）取 AID；`POST /api/daemon-tokens` 取 DTOKEN；`POST /api/daemon/register`（Bearer DTOKEN，体 `{"daemon_id":"d-e2e","runtimes":[{"provider":"kimi","version":"e2e-1.0"}]}`）。
- 页面用例（记 P1 环境）：server:3100 与 web:5173 已启动（runner 不起，避免认领竞争），浏览器打开 `http://localhost:5173`。
- 说明："无活跃任务"状态的造法：创建指派 agent 的 Issue 会自动入队一条 queued，需先 `POST /api/tasks/<id>/cancel` 取消。

## 用例列表

### TC-Comment_001 评论触发_无活跃任务_自动入队

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；存在指派 $AID 的 Issue（id 记为 IID），其自动入队的执行已取消（无 queued/dispatched/running）
- 测试数据: [body: 顺手把 README 也更新了]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/comments`，体 `{"body":"顺手把 README 也更新了"}`
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
  3. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 201；body.id 非空；body.trigger.enqueued=true；body.trigger.task_id 非空
  2. 数组含一条 status="queued"、attempt=1 的新执行
  3. comments 含一条 body="任务已入队（触发：comment）" 的 system 记录
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Comment_002 评论触发_已有排队任务_合并且不新建

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；存在指派 $AID 的 Issue（id 记为 IID），其自动入队的 queued 执行保留未动
- 测试数据: [body: 补充约束：先跑测试]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/comments`，体 `{"body":"补充约束：先跑测试"}`
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
- 预期结果:
  1. HTTP 201；body.trigger.enqueued=false；body.trigger.reason="merged_into_pending"
  2. 数组长度 1（未新建执行）
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Comment_003 评论触发_执行中任务_排队接力

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；Issue（id 记为 IID）的执行 T 经 claim、start 处于 running
- 测试数据: [body: 跑偏了，先看 DESIGN.md 再改]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/comments`，体 `{"body":"跑偏了，先看 DESIGN.md 再改"}`
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
- 预期结果:
  1. HTTP 201；body.trigger.enqueued=true；body.trigger.task_id 非空且不等于 T 的 id
  2. 数组长度 2：一条 running（T）、一条 queued（新接力执行）
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Comment_004 评论触发_未指派Agent_不触发且给原因

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；存在未指派的 Issue（体 `{"title":"无人接收"}` 创建，id 记为 IID）
- 测试数据: [body: 谁来接一下]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/comments`，体 `{"body":"谁来接一下"}`
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
- 预期结果:
  1. HTTP 201；body.trigger.enqueued=false；body.trigger.reason="assignee_not_agent"
  2. 数组长度 0
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Comment_005 评论触发_已完成Issue_不触发且给原因

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；存在 status="done" 的 Issue（创建后 PATCH `{"status":"done"}`，id 记为 IID）且指派 $AID
- 测试数据: [body: 再改一版]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/comments`，体 `{"body":"再改一版"}`
- 预期结果:
  1. HTTP 201；body.trigger.enqueued=false；body.trigger.reason="status_inactive"
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Comment_006 触发闭环_认领任务包_评论进入上下文

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备（接口实例）；Issue（id 记为 IID）按 TC-Comment_001 路径由评论触发入队一条 queued 执行
- 测试数据: [daemon_id: d-e2e] [max_tasks: 1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/claim`，头 `Authorization: Bearer $DTOKEN`，体 `{"daemon_id":"d-e2e","max_tasks":1}`
- 预期结果:
  1. HTTP 200；tasks 长度 1；tasks[0].comments 含一条 author_type="member"、body="顺手把 README 也更新了" 的元素
- 执行结果: ✅ 通过 (2026-08-11)

### TC-Comment_007 发送评论_触发入队_面板显示排队接力提示

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；存在指派 agent 的 Issue 且无活跃执行（自动入队的已取消）；该 Issue 的面板已打开
- 测试数据: [评论: 续作探针评论]
- 测试步骤:
  1. 在"追加指令或评论…"输入框输入"续作探针评论"
  2. 点击"发送"
  3. 检查输入框下方提示与评论区
- 预期结果:
  1. 输入成功
  2. 输入框清空
  3. 输入框下方显示"已触发新任务（排队接力）"；评论区依次出现 member 评论"续作探针评论"与 system 记录"任务已入队（触发：comment）"
- 执行结果: ✅ 通过 (2026-08-11) | 实测: 四项断言全中（提示/系统评论/member 评论/草稿清空）；探针已清理

### TC-Comment_008 发送评论_未指派Agent_面板显示不触发原因

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；存在未指派 agent 的 Issue 且面板已打开
- 测试数据: [评论: 未指派探针评论]
- 测试步骤:
  1. 在"追加指令或评论…"输入框输入"未指派探针评论"
  2. 点击"发送"
  3. 检查输入框下方提示
- 预期结果:
  1. 输入成功
  2. 输入框清空
  3. 输入框下方显示"未指派 Agent，评论仅记录不触发执行"
- 执行结果: ✅ 通过 (2026-08-11) | 实测: 提示与 member 评论均出现、无入队提示；前置构造为"先指派建任务→取消任务→取消指派"（未指派且无任务的 Issue 打不开面板，属既有交互）；探针已清理

## 需求覆盖矩阵

| 功能点 | 来源章节 | 用例编号 |
|--------|----------|----------|
| 无活跃任务评论入队（完成后续作） | spec 范围 A.1/2 | TC-Comment_001、007 |
| 已有排队任务合并去重 | spec 范围 A.1/4 | TC-Comment_002 |
| running 任务排队接力 | spec 范围 A.1 | TC-Comment_003 |
| 原因码：assignee_not_agent / status_inactive | spec 范围 A.1 | TC-Comment_004、005、008 |
| 评论进任务包（prompt 链路闭环） | spec 范围 A 测试 | TC-Comment_006 |
| 发送反馈提示四态 | spec 范围 B.2 | TC-Comment_007、008 |

## 执行汇总

- 总数 8 | 通过 8 | 失败 0 | 阻塞 0 | 未执行 0 | 通过率 100%（已执行 8 条）
- 缺陷清单: 无
