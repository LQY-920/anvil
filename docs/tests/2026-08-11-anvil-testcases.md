# Anvil 一期（编码任务调度）测试用例文档

> 来源需求: docs/history/specs/2026-08-04-anvil-design.md（主），PRODUCT.md、DESIGN.md、docs/PROGRESS.md（验收链路/目标契约/远程仓库等里程碑，补充）
> 生成日期: 2026-08-11 | 产品形态: 网站 | 用例数: 71
> 来源章节基线: main 分支（2026-08-11）

## 全局准备

接口用例在独立测试实例执行（独立端口、独立数据库文件，不污染自用数据）：

- G1 启动测试实例：`cd apps/server && rm -f anvil-test.db* && ANVIL_PORT=3101 ANVIL_DB=anvil-test.db pnpm dev`，下文 `BASE` 指 `http://127.0.0.1:3101`
- G2 取工作区：执行请求 `GET $BASE/api/bootstrap`，从响应取 `workspace.id` 记为 `WSID`
- G3 建 Agent：执行请求 `POST $BASE/api/agents`，体 `{"name":"e2e-bot","provider":"kimi","max_concurrent_tasks":2}`，从响应取 `id` 记为 `AID`
- G4 建 daemon 凭据：执行请求 `POST $BASE/api/daemon-tokens`，体 `{"label":"e2e"}`，从响应取 `token` 记为 `DTOKEN`（明文仅此一次返回）
- G5 注册运行时：执行请求 `POST $BASE/api/daemon/register`，头 `Authorization: Bearer $DTOKEN`，体 `{"daemon_id":"d-e2e","runtimes":[{"provider":"kimi","version":"e2e-1.0"}]}`

页面用例环境（记 P1）：已在项目根执行 `pnpm dev` 拉起三端（server 3100 / web 5173 / runner），浏览器打开 `http://localhost:5173`。

补充说明：带"等待"的步骤用于覆盖 server 端 30 秒清扫周期（`app.ts` setInterval 30_000）或 60 秒心跳离线阈值（`runtimes.ts` OFFLINE_AFTER_MS），等待时长已按此推算。

## 功能树与测试点

```
Anvil 一期
├─ 1 Issue 管理（spec §5/§6；PROGRESS 第0波）
│   ├─ 1.1 创建 Issue：仅标题/全字段/缺标题/枚举参数无效/放入收集箱/注入字符/列表性能
│   ├─ 1.2 状态流转与评论：收集箱移出触发/状态变更评论/无效状态/404/评论增删查
│   └─ 1.3 入队三入口：指派触发/backlog 移出触发/手动重跑（成功/有 pending/未指派）
├─ 2 任务调度（spec §6/§8）
│   ├─ 2.1 原子认领：正向/空队列/优先级排序/并发单赢
│   ├─ 2.2 租约清扫：次数未满重排/次数已满置失败
│   ├─ 2.3 有限重试：派生子执行/达上限停止
│   ├─ 2.4 取消：活跃可取消/终态 409
│   └─ 2.5 runtime 注册与离线清扫：注册在线/心跳停止置离线且将在途执行置失败
├─ 3 任务执行（spec §6/§8；PROGRESS 第0波）
│   ├─ 3.1 开始上报：正向/缺 work_dir/重复上报
│   ├─ 3.2 消息流：seq 连续落库/跳跃 409/重复批次不重复落库
│   ├─ 3.3 完成与失败上报：写交付/终态 409/缺字段 400
│   ├─ 3.4 状态回调与交付信号：置待验收+delivered/白名单外 400
│   └─ 3.5 任务级凭据：冒用他任务凭据 401
├─ 4 验收链路（PROGRESS 验收链路；2026-08-06 冲突详情修复）
│   ├─ 4.1 diff 获取：正向/404
│   ├─ 4.2 合入：无冲突成功/冲突 409 带详情/未完成 409
│   └─ 4.3 打回重跑：意见进评论并重新入队（页面用例 TC-Board_007）
├─ 5 Agent 与凭据管理（spec §5/§6；PROGRESS 第1波）
│   ├─ 5.1 Agent 创建：正向/缺字段
│   ├─ 5.2 daemon 凭据：签发明文一次/列表不含哈希/吊销/重复吊销
│   └─ 5.3 daemon 认证：未带凭据/伪造凭据/已吊销凭据 → 401
├─ 6 目标仓库（PROGRESS 远程仓库）
│   ├─ 6.1 repo_path 记录最近使用
│   └─ 6.2 最近仓库：去重置顶/上限八条/页面快捷回填
└─ 7 看板界面（PRODUCT.md；DESIGN.md）
    ├─ 7.1 看板骨架：七列/计数/空态/窄窗口横向滚动
    ├─ 7.2 新建弹窗：禁用态/正向创建/双击防重/最近仓库回填
    ├─ 7.3 任务面板：日志与评论/待验收徽章/打回重跑/发送评论
    ├─ 7.4 双主题：切换/刷新持久化
    ├─ 7.5 Agents 页：凭据明文一次/吊销
    └─ 7.6 实时刷新：WS 广播驱动看板更新
```

产品形态 checklist（网站+接口）跳过说明：登录鉴权与越权用例不适用（spec §2 单租户自用，无登录体系）；小程序/桌面程序条目不适用；XSS/SQL 注入由 TC-Issue_016 覆盖；响应时间由 TC-Issue_015 覆盖；远程 URL 仓库的克隆/推送链路依赖真实 GitHub 与 Kimi CLI，列入人工冒烟，不在本文档自动用例内。

## 用例列表

### TC-Issue_001 创建Issue_仅填标题_返回201且落库待办

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2
- 测试数据: [title: 写一份README]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues`，体 `{"title":"写一份README"}`
  2. 执行请求 `GET $BASE/api/issues?workspace_id=$WSID`
- 预期结果:
  1. HTTP 201；body.id 非空；title="写一份README"；status="todo"；priority="medium"；assignee_type 为 null；repo_path 为 null
  2. HTTP 200；返回数组含步骤 1 的 id，该元素 latest_task 为 null
- 执行结果: 未执行

### TC-Issue_002 创建Issue_指派Agent_自动入队且写系统评论

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G3
- 测试数据: [title: 开发登录页] [assignee_type: agent] [assignee_id: $AID]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues`，体 `{"title":"开发登录页","assignee_type":"agent","assignee_id":"$AID"}`，从响应取 id 记为 IID
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
  3. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 201；status="todo"；assignee_id=$AID
  2. HTTP 200；数组长度 1；元素 status="queued"、attempt=1、max_attempts=3、agent_id=$AID
  3. HTTP 200；comments 含一条 author_type="system"、type="system"、body="任务已入队（触发：assign）"
- 执行结果: 未执行

### TC-Issue_003 创建Issue_缺少标题_返回400

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2
- 测试数据: [请求体1: {}] [请求体2: {"title":""}]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues`，体 `{}`
  2. 执行请求 `POST $BASE/api/issues`，体 `{"title":""}`
- 预期结果:
  1. HTTP 400；body.error="title required"
  2. HTTP 400；body.error="title required"
- 执行结果: 未执行

### TC-Issue_004 创建Issue_枚举参数无效_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2
- 测试数据: [请求体1: {"title":"x","priority":"P0"}] [请求体2: {"title":"x","status":"doing"}]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues`，体 `{"title":"x","priority":"P0"}`
  2. 执行请求 `POST $BASE/api/issues`，体 `{"title":"x","status":"doing"}`
- 预期结果:
  1. HTTP 400；body.error="invalid priority"
  2. HTTP 400；body.error="invalid status"
- 执行结果: 未执行

### TC-Issue_005 创建Issue_放入收集箱且指派Agent_不入队

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G3
- 测试数据: [title: 灵感暂存] [status: backlog] [assignee_type: agent] [assignee_id: $AID]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues`，体 `{"title":"灵感暂存","status":"backlog","assignee_type":"agent","assignee_id":"$AID"}`，从响应取 id 记为 IID
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
- 预期结果:
  1. HTTP 201；status="backlog"
  2. HTTP 200；数组长度 0
- 执行结果: 未执行

### TC-Issue_006 移出收集箱_已指派Agent_触发入队

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G3；存在 status="backlog" 且指派 $AID 的 Issue（创建体 `{"title":"灵感暂存","status":"backlog","assignee_type":"agent","assignee_id":"$AID"}`），其 id 记为 IID
- 测试数据: [status: todo]
- 测试步骤:
  1. 执行请求 `PATCH $BASE/api/issues/$IID`，体 `{"status":"todo"}`
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
  3. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 200；status="todo"
  2. HTTP 200；数组长度 1；元素 status="queued"
  3. comments 含一条 type="status_change"、body="backlog → todo"；且含一条 body="任务已入队（触发：status）"
- 执行结果: 未执行

### TC-Issue_007 修改状态_待办转阻塞_写入状态变更评论

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2；存在未指派的 Issue（体 `{"title":"状态探针"}` 创建），其 id 记为 IID
- 测试数据: [status: blocked]
- 测试步骤:
  1. 执行请求 `PATCH $BASE/api/issues/$IID`，体 `{"status":"blocked"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 200；status="blocked"
  2. comments 含一条 author_type="member"、type="status_change"、body="todo → blocked"
- 执行结果: 未执行

### TC-Issue_008 修改状态_取值无效_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2；存在 Issue，其 id 记为 IID
- 测试数据: [status: doing] [priority: P9]
- 测试步骤:
  1. 执行请求 `PATCH $BASE/api/issues/$IID`，体 `{"status":"doing"}`
  2. 执行请求 `PATCH $BASE/api/issues/$IID`，体 `{"priority":"P9"}`
- 预期结果:
  1. HTTP 400；body.error="invalid status"
  2. HTTP 400；body.error="invalid priority"
- 执行结果: 未执行

### TC-Issue_009 修改Issue_目标不存在_返回404

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2
- 测试数据: [issue_id: 00000000-0000-0000-0000-000000000000]
- 测试步骤:
  1. 执行请求 `PATCH $BASE/api/issues/00000000-0000-0000-0000-000000000000`，体 `{"status":"todo"}`
- 预期结果:
  1. HTTP 404；body.error="not found"
- 执行结果: 未执行

### TC-Issue_010 重跑Issue_无待处理执行_返回201

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G3；存在指派 $AID 的 Issue（id 记为 IID）且其自动入队的执行已被 `POST $BASE/api/tasks/<task_id>/cancel` 取消
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/rerun`
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 201；body.status="queued"；attempt=1
  2. comments 含一条 body="任务已入队（触发：rerun）"
- 执行结果: 未执行

### TC-Issue_011 重跑Issue_存在待处理执行_返回409

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G3；存在指派 $AID 的 Issue（id 记为 IID）且其有 status="queued" 的执行（创建即自动入队）
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/rerun`
- 预期结果:
  1. HTTP 409；body.error="已有 pending 任务或 assignee 不是 agent"
- 执行结果: 未执行

### TC-Issue_012 重跑Issue_未指派Agent_返回409

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2；存在未指派的 Issue（id 记为 IID）
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/rerun`
- 预期结果:
  1. HTTP 409；body.error="已有 pending 任务或 assignee 不是 agent"
- 执行结果: 未执行

### TC-Issue_013 发表评论_正文非空_返回201且可查

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2；存在 Issue，其 id 记为 IID
- 测试数据: [body: 补充约束：先看 DESIGN.md 再动手]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/comments`，体 `{"body":"补充约束：先看 DESIGN.md 再动手"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 201；body.id 非空
  2. comments 含一条 author_type="member"、type="comment"、body="补充约束：先看 DESIGN.md 再动手"
- 执行结果: 未执行

### TC-Issue_014 发表评论_正文为空_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2；存在 Issue，其 id 记为 IID
- 测试数据: [body: 空字符串]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues/$IID/comments`，体 `{"body":""}`
- 预期结果:
  1. HTTP 400；body.error="body required"
- 执行结果: 未执行

### TC-Issue_015 列表接口_百条数据_响应在一秒内

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2（全新实例，库中无其他 Issue）
- 测试数据: [title 前缀: 批量-] [数量: 100]
- 测试步骤:
  1. 循环执行 100 次请求 `POST $BASE/api/issues`，体 `{"title":"批量-N"}`（N 从 1 到 100）
  2. 计时执行请求 `GET $BASE/api/issues?workspace_id=$WSID`
- 预期结果:
  1. 每次响应均为 HTTP 201
  2. HTTP 200；响应耗时小于 1000ms；返回数组长度不小于 100
- 执行结果: 未执行

### TC-Issue_016 创建Issue_标题含注入字符_原样落库

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2
- 测试数据: [title: <script>alert(1)</script>' OR '1'='1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues`，体 `{"title":"<script>alert(1)</script>' OR '1'='1"}`，从响应取 id 记为 IID
  2. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 201
  2. HTTP 200；issue.title 与输入串逐字符相等（未被转义或改写）
- 执行结果: 未执行

### TC-Dispatch_001 认领执行_存在排队执行_返回任务包且置已派发

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；已创建指派 $AID 的 Issue（title "认领探针"），其执行处于 queued
- 测试数据: [daemon_id: d-e2e] [max_tasks: 1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/claim`，头 `Authorization: Bearer $DTOKEN`，体 `{"daemon_id":"d-e2e","max_tasks":1}`
  2. 执行请求 `GET $BASE/api/agents`
- 预期结果:
  1. HTTP 200；tasks 长度 1；tasks[0].task.status="dispatched"；tasks[0].task_token 以 "atk_" 开头；tasks[0].issue.title="认领探针"；tasks[0].comments 为数组
  2. HTTP 200；$AID 对应元素 status="working"
- 执行结果: 未执行

### TC-Dispatch_002 认领执行_无排队执行_返回空数组

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2、G4、G5（未创建任何 Issue）
- 测试数据: [daemon_id: d-e2e] [max_tasks: 1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/claim`，头 `Authorization: Bearer $DTOKEN`，体 `{"daemon_id":"d-e2e","max_tasks":1}`
- 预期结果:
  1. HTTP 200；body.tasks 为数组且长度 0
- 执行结果: 未执行

### TC-Dispatch_003 认领执行_两条排队_高优先级先派出

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；按顺序创建两个指派 $AID 的 Issue：「低优先级活」（priority=low）、「紧急活」（priority=urgent）
- 测试数据: [daemon_id: d-e2e] [max_tasks: 1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/claim`，头 `Authorization: Bearer $DTOKEN`，体 `{"daemon_id":"d-e2e","max_tasks":1}`
- 预期结果:
  1. HTTP 200；tasks 长度 1；tasks[0].issue.title="紧急活"
- 执行结果: 未执行

### TC-Dispatch_004 认领执行_并发认领同一执行_仅一个赢家

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G4；已分别用 daemon_id "d-a"、"d-b" 各执行一次 G5 注册；存在 1 条 queued 执行
- 测试数据: [daemon_id1: d-a] [daemon_id2: d-b] [max_tasks: 1]
- 测试步骤:
  1. 同一秒内并发执行两条请求 `POST $BASE/api/daemon/claim`（体分别为 `{"daemon_id":"d-a","max_tasks":1}` 与 `{"daemon_id":"d-b","max_tasks":1}`，可用 `curl ... & curl ... & wait`）
- 预期结果:
  1. 两个响应均为 HTTP 200；其中一个 tasks 长度 1、另一个 tasks 长度 0；同一 task.id 只出现在一个响应中
- 执行结果: 未执行

### TC-Dispatch_005 租约过期_次数未满_重新排队且次数加一

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）刚被 claim 处于 dispatched（租约 2 分钟）
- 测试步骤:
  1. 执行请求 `GET $BASE/api/tasks/$TID`
  2. 等待 155 秒（覆盖租约 120 秒与清扫周期 30 秒）
  3. 执行请求 `GET $BASE/api/tasks/$TID`
- 预期结果:
  1. HTTP 200；task.status="dispatched"；task.lease_expires_at 非空
  2. （无检查点，等待覆盖一个清扫周期）
  3. HTTP 200；task.status="queued"；task.attempt=2；task.lease_expires_at 为 null
- 执行结果: 未执行

### TC-Dispatch_006 租约过期_次数已满_置失败且记录租约过期

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）处于 dispatched 且 attempt=3（可用 node 脚本置位：`cd apps/server && node -e "const db=require('better-sqlite3')('anvil-test.db');db.pragma('busy_timeout=5000');db.prepare(\"UPDATE tasks SET attempt=3 WHERE id='TID值'\").run()"`）
- 测试步骤:
  1. 等待 155 秒（从 dispatched_at 起算已超过 120 秒租约，等待覆盖清扫周期）
  2. 执行请求 `GET $BASE/api/tasks/$TID`
- 预期结果:
  1. （无检查点，等待覆盖一个清扫周期）
  2. HTTP 200；task.status="failed"；task.failure_reason="lease_expired"
- 执行结果: 未执行

### TC-Dispatch_007 执行失败_次数未满_自动派生子执行

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID，任务凭据记为 TTASK）处于 running（claim 后经 start 上报）；其 Issue id 记为 IID
- 测试数据: [failure_reason: non_zero_exit] [error: exit code 1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/fail`，头 `Authorization: Bearer $TTASK`，体 `{"failure_reason":"non_zero_exit","error":"exit code 1"}`
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
  3. 执行请求 `GET $BASE/api/issues/$IID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. 数组长度 2；存在一条 status="failed"、failure_reason="non_zero_exit"（T 本身）；存在一条 status="queued"、attempt=2、parent_task_id=TID
  3. comments 含一条 body="任务失败（non_zero_exit），自动重试 2/3"
- 执行结果: 未执行

### TC-Dispatch_008 执行失败_次数已满_停在失败不再派生

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID，凭据 TTASK）处于 running 且 attempt=3、max_attempts=3（置位命令：`cd apps/server && node -e "const db=require('better-sqlite3')('anvil-test.db');db.pragma('busy_timeout=5000');db.prepare(\"UPDATE tasks SET attempt=3 WHERE id='TID值'\").run()"`）；其 Issue id 记为 IID
- 测试数据: [failure_reason: non_zero_exit] [error: exit code 1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/fail`，头 `Authorization: Bearer $TTASK`，体 `{"failure_reason":"non_zero_exit","error":"exit code 1"}`
  2. 执行请求 `GET $BASE/api/issues/$IID/tasks`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. 数组中 status="failed" 的条目 attempt=3；不存在 attempt=4 的条目；不存在新增 status="queued" 的条目
- 执行结果: 未执行

### TC-Dispatch_009 取消执行_排队中_置已取消且记录原因

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G3；执行 T（id 记为 TID）处于 queued（创建指派 $AID 的 Issue 自动入队）
- 测试步骤:
  1. 执行请求 `POST $BASE/api/tasks/$TID/cancel`
  2. 执行请求 `GET $BASE/api/tasks/$TID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. HTTP 200；task.status="cancelled"；task.failure_reason="cancelled_by_user"；task.completed_at 非空
- 执行结果: 未执行

### TC-Dispatch_010 取消执行_已完成_返回409

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）已完成（claim、start、complete 走完整链路）
- 测试步骤:
  1. 执行请求 `POST $BASE/api/tasks/$TID/cancel`
- 预期结果:
  1. HTTP 409；body.error="task not active"
- 执行结果: 未执行

### TC-Dispatch_011 心跳停止_超过60秒_运行时离线且执行置失败

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G4；已用 daemon_id "d-x" 执行 G5 注册（此后不再发心跳）；已创建指派 $AID 的 Issue（id 记为 IID）
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/claim`，头 `Authorization: Bearer $DTOKEN`，体 `{"daemon_id":"d-x","max_tasks":1}`，从响应取 task.id 记为 TID
  2. 等待 95 秒（覆盖 60 秒离线阈值与 30 秒清扫周期）
  3. 执行请求 `GET $BASE/api/runtimes`
  4. 执行请求 `GET $BASE/api/tasks/$TID`
  5. 执行请求 `GET $BASE/api/issues/$IID/tasks`
- 预期结果:
  1. HTTP 200；tasks 长度 1
  2. （无检查点，等待覆盖一个清扫周期）
  3. daemon_id="d-x" 的元素 status="offline"
  4. task.status="failed"；task.failure_reason="runtime_offline"
  5. 数组长度 2；存在一条 status="queued"、attempt=2、parent_task_id=TID
- 执行结果: 未执行

### TC-Exec_001 开始执行_已派发_置执行中

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）处于 dispatched，claim 响应的 task_token 记为 TTASK
- 测试数据: [work_dir: D:/anvil]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/start`，头 `Authorization: Bearer $TTASK`，体 `{"work_dir":"D:/anvil"}`
  2. 执行请求 `GET $BASE/api/tasks/$TID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. HTTP 200；task.status="running"；task.work_dir="D:/anvil"；task.started_at 非空
- 执行结果: 未执行

### TC-Exec_002 开始执行_缺工作目录_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim 进入 dispatched，其 task_token 记为 TTASK
- 测试数据: [请求体: {}]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/start`，头 `Authorization: Bearer $TTASK`，体 `{}`
- 预期结果:
  1. HTTP 400；body.error="work_dir required"
- 执行结果: 未执行

### TC-Exec_003 开始执行_重复上报_返回409

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID，凭据 TTASK）已成功 start 一次处于 running
- 测试数据: [work_dir: D:/anvil]
- 测试步骤:
  1. 再次执行请求 `POST $BASE/api/daemon/tasks/$TID/start`，头 `Authorization: Bearer $TTASK`，体 `{"work_dir":"D:/anvil"}`
- 预期结果:
  1. HTTP 409；body.error="task not in dispatched state"
- 执行结果: 未执行

### TC-Exec_004 上报消息_序号连续_落库且可增量拉取

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK
- 测试数据: [messages: [{"seq":0,"type":"text","content":"开始干活"},{"seq":1,"type":"tool_use","tool":"Bash","content":"ls"}]]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/messages`，头 `Authorization: Bearer $TTASK`，体 `{"messages":[{"seq":0,"type":"text","content":"开始干活"},{"seq":1,"type":"tool_use","tool":"Bash","content":"ls"}]}`
  2. 执行请求 `GET $BASE/api/tasks/$TID/messages?after_seq=-1`
- 预期结果:
  1. HTTP 200；body.ok=true；body.last_seq=1
  2. HTTP 200；数组长度 2；首条 seq=0、type="text"、content="开始干活"；次条 seq=1、tool="Bash"
- 执行结果: 未执行

### TC-Exec_005 上报消息_序号跳跃_返回409并带last_seq

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK；已落库 1 条 seq=0 的消息
- 测试数据: [messages: [{"seq":5,"type":"text","content":"跳号"}]]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/messages`，头 `Authorization: Bearer $TTASK`，体 `{"messages":[{"seq":5,"type":"text","content":"跳号"}]}`
  2. 执行请求 `GET $BASE/api/tasks/$TID/messages?after_seq=-1`
- 预期结果:
  1. HTTP 409；body.last_seq=0
  2. HTTP 200；数组长度 1（跳号消息未落库）
- 执行结果: 未执行

### TC-Exec_006 上报消息_重复批次_拒绝且不重复落库

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK；已落库 seq=0、1 两条消息
- 测试数据: [messages: [{"seq":0,"type":"text","content":"开始干活"},{"seq":1,"type":"tool_use","tool":"Bash","content":"ls"}]]
- 测试步骤:
  1. 重发请求 `POST $BASE/api/daemon/tasks/$TID/messages`，头 `Authorization: Bearer $TTASK`，体同上批次
  2. 执行请求 `GET $BASE/api/tasks/$TID/messages?after_seq=-1`
- 预期结果:
  1. HTTP 409；body.last_seq=1
  2. HTTP 200；数组长度 2（未新增）
- 执行结果: 未执行

### TC-Exec_007 完成执行_执行中_落库交付分支

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK
- 测试数据: [branch: task/e2e9001] [diff_stat: 1 file changed] [work_dir: D:/anvil] [session_id: sess-e2e-1]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/complete`，头 `Authorization: Bearer $TTASK`，体 `{"branch":"task/e2e9001","diff_stat":"1 file changed","work_dir":"D:/anvil","session_id":"sess-e2e-1"}`
  2. 执行请求 `GET $BASE/api/tasks/$TID`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. HTTP 200；task.status="completed"；task.result_json 含 "task/e2e9001"；task.session_id="sess-e2e-1"；task.completed_at 非空
- 执行结果: 未执行

### TC-Exec_008 完成执行_已取消_返回409

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK；已执行 `POST $BASE/api/tasks/$TID/cancel` 且返回 ok
- 测试数据: [branch: task/e2e9002]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/complete`，头 `Authorization: Bearer $TTASK`，体 `{"branch":"task/e2e9002"}`
- 预期结果:
  1. HTTP 409；body.error="task not active"
- 执行结果: 未执行

### TC-Exec_009 上报失败_缺失败原因_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK
- 测试数据: [请求体: {"failure_reason":"non_zero_exit"}]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/fail`，头 `Authorization: Bearer $TTASK`，体 `{"failure_reason":"non_zero_exit"}`（缺 error 字段）
- 预期结果:
  1. HTTP 400；body.error="failure_reason/error required"
- 执行结果: 未执行

### TC-Exec_010 回调状态_置待验收_Issue流转且登记已交付

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK；其 Issue id 记为 IID
- 测试数据: [status: in_review] [note: 开发完成]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/issue-status`，头 `Authorization: Bearer $TTASK`，体 `{"status":"in_review","note":"开发完成"}`
  2. 执行请求 `GET $BASE/api/issues/$IID`
  3. 执行请求 `GET $BASE/api/daemon/tasks/$TID/delivery`，头 `Authorization: Bearer $TTASK`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. issue.status="in_review"；comments 含一条 author_type="agent"、type="status_change"、body="todo → in_review：开发完成"
  3. HTTP 200；body.delivered=true
- 执行结果: 未执行

### TC-Exec_011 回调状态_取值不在白名单_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）经创建指派 $AID 的 Issue、claim、start 进入 running，其 task_token 记为 TTASK
- 测试数据: [status: doing]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID/issue-status`，头 `Authorization: Bearer $TTASK`，体 `{"status":"doing"}`
- 预期结果:
  1. HTTP 400；body.error="status must be in_review | done | blocked"
- 执行结果: 未执行

### TC-Exec_012 任务凭据_冒用他任务凭据_返回401

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；存在两个指派 $AID 的 Issue，经一次 `{"daemon_id":"d-e2e","max_tasks":2}` 的 claim 同时派出：执行 T1 凭据记为 TOK1，执行 T2 的 id 记为 TID2
- 测试数据: [messages: [{"seq":0,"type":"text","content":"冒用"}]]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/tasks/$TID2/messages`，头 `Authorization: Bearer $TOK1`，体 `{"messages":[{"seq":0,"type":"text","content":"冒用"}]}`
- 预期结果:
  1. HTTP 401；body.error="invalid task token"
- 执行结果: 未执行

### TC-Review_001 获取diff_执行有交付分支_返回对比内容

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；已造 fixture 仓库：执行 `mkdir -p /d/anvil/test/fixtures/review-diff && cd /d/anvil/test/fixtures/review-diff && git init -b main && git config user.email e2e@anvil.local && git config user.name e2e && echo base > a.txt && git add . && git commit -m init && git checkout -b task/e2e0001 && echo line2 >> a.txt && git commit -am change && git checkout main`；已创建 repo_path="D:/anvil/test/fixtures/review-diff" 且指派 $AID 的 Issue，其执行 T（id 记为 TID，凭据 TTASK）经 claim、start、并以体 `{"branch":"task/e2e0001"}` complete
- 测试步骤:
  1. 执行请求 `GET $BASE/api/tasks/$TID/diff`
- 预期结果:
  1. HTTP 200；body.branch="task/e2e0001"；body.base="main"；body.diff_stat 含 "1 file changed"；body.diff_text 含 "+line2"；body.truncated=false
- 执行结果: 未执行

### TC-Review_002 获取diff_执行不存在_返回404

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1
- 测试数据: [task_id: 00000000-0000-0000-0000-000000000000]
- 测试步骤:
  1. 执行请求 `GET $BASE/api/tasks/00000000-0000-0000-0000-000000000000/diff`
- 预期结果:
  1. HTTP 404；body.error="task not found"
- 执行结果: 未执行

### TC-Review_003 合入分支_无冲突_合入成功且Issue置已完成

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；已造 fixture 仓库：执行 `mkdir -p /d/anvil/test/fixtures/review-ok && cd /d/anvil/test/fixtures/review-ok && git init -b main && git config user.email e2e@anvil.local && git config user.name e2e && echo base > a.txt && git add . && git commit -m init && git checkout -b task/e2e0002 && echo hello > b.txt && git add . && git commit -m add-b && git checkout main`；已创建 repo_path="D:/anvil/test/fixtures/review-ok" 且指派 $AID 的 Issue（id 记为 IID），其执行 T（id 记为 TID）经 claim、start、并以体 `{"branch":"task/e2e0002","diff_stat":"1 file changed"}` complete
- 测试步骤:
  1. 执行请求 `POST $BASE/api/tasks/$TID/merge`
  2. 执行请求 `GET $BASE/api/issues/$IID`
  3. 执行命令 `git -C /d/anvil/test/fixtures/review-ok log --oneline -3` 与 `git -C /d/anvil/test/fixtures/review-ok branch --list task/e2e0002`
- 预期结果:
  1. HTTP 200；body.ok=true；body.merged_branch="task/e2e0002"；body.target="main"
  2. issue.status="done"；comments 含一条 body="todo → done（合并 task/e2e0002 → main）"
  3. log 输出含 "merge: anvil task"；branch --list 输出为空（本地任务分支已删）
- 执行结果: 未执行

### TC-Review_004 合入分支_存在冲突_返回409且带冲突详情

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；已造 fixture 仓库：执行 `mkdir -p /d/anvil/test/fixtures/review-conflict && cd /d/anvil/test/fixtures/review-conflict && git init -b main && git config user.email e2e@anvil.local && git config user.name e2e && echo base > a.txt && git add . && git commit -m init && git checkout -b task/e2e0003 && echo branch > a.txt && git commit -am branch-change && git checkout main && echo main > a.txt && git commit -am main-change`；已创建 repo_path="D:/anvil/test/fixtures/review-conflict" 且指派 $AID 的 Issue，其执行 T（id 记为 TID）经 claim、start、并以体 `{"branch":"task/e2e0003"}` complete
- 测试步骤:
  1. 执行请求 `POST $BASE/api/tasks/$TID/merge`
  2. 执行命令 `git -C /d/anvil/test/fixtures/review-conflict status --porcelain`
  3. 执行请求 `GET $BASE/api/tasks/$TID`
- 预期结果:
  1. HTTP 409；body.error 含 "CONFLICT" 且含 "a.txt"
  2. 输出为空（合并已中止，工作区无残留冲突标记）
  3. task.status 仍为 "completed"（可修复后重试合入）
- 执行结果: 未执行

### TC-Review_005 合入分支_执行未完成_返回409

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1~G5；执行 T（id 记为 TID）处于 running（claim、start 后未 complete）
- 测试步骤:
  1. 执行请求 `POST $BASE/api/tasks/$TID/merge`
- 预期结果:
  1. HTTP 409；body.error="task status is running, not completed"
- 执行结果: 未执行

### TC-Agent_001 创建Agent_填名字_返回201且状态空闲

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1
- 测试数据: [name: forge-02] [provider: kimi]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/agents`，体 `{"name":"forge-02","provider":"kimi"}`
  2. 执行请求 `GET $BASE/api/agents`
- 预期结果:
  1. HTTP 201；body.name="forge-02"；body.provider="kimi"；body.status="idle"；body.max_concurrent_tasks=1
  2. HTTP 200；数组含步骤 1 返回的 id
- 执行结果: 未执行

### TC-Agent_002 创建Agent_缺provider_返回400

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1
- 测试数据: [请求体: {"name":"x"}]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/agents`，体 `{"name":"x"}`
- 预期结果:
  1. HTTP 400；body.error="name/provider required"
- 执行结果: 未执行

### TC-Agent_003 生成凭据_调用_返回明文且列表不含哈希

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1
- 测试数据: [label: ui-e2e]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon-tokens`，体 `{"label":"ui-e2e"}`
  2. 执行请求 `GET $BASE/api/daemon-tokens`
- 预期结果:
  1. HTTP 201；body.id 非空；body.token 以 "anv_" 开头
  2. HTTP 200；label="ui-e2e" 的元素含 id、label、created_at、revoked_at 字段，且不含 token_hash 字段
- 执行结果: 未执行

### TC-Agent_004 吊销凭据_有效凭据_记录吊销时间

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1；已生成凭据（label "to-revoke"），其 id 记为 KID
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon-tokens/$KID/revoke`
  2. 执行请求 `GET $BASE/api/daemon-tokens`
- 预期结果:
  1. HTTP 200；body.ok=true
  2. id=KID 的元素 revoked_at 非空
- 执行结果: 未执行

### TC-Agent_005 吊销凭据_重复吊销_返回409

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1；凭据（label "to-revoke"，id 记为 KID）已生成，且已执行 `POST $BASE/api/daemon-tokens/$KID/revoke` 吊销过一次
- 测试步骤:
  1. 再次执行请求 `POST $BASE/api/daemon-tokens/$KID/revoke`
- 预期结果:
  1. HTTP 409；body.error="already revoked"
- 执行结果: 未执行

### TC-Agent_006 daemon认证_凭据已吊销_返回401

- 优先级: P1 | 类型: 接口
- 前置条件: 已完成全局准备 G1；凭据 KTOKEN 已生成并已吊销
- 测试数据: [daemon_id: d-revoked]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/register`，头 `Authorization: Bearer $KTOKEN`，体 `{"daemon_id":"d-revoked","runtimes":[{"provider":"kimi","version":"1.0"}]}`
- 预期结果:
  1. HTTP 401；body.error="invalid token"
- 执行结果: 未执行

### TC-Agent_007 daemon认证_未带或伪造凭据_返回401

- 优先级: P0 | 类型: 接口
- 前置条件: 已完成全局准备 G1
- 测试数据: [伪造凭据: anv_deadbeef]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/claim`，不带 Authorization 头，体 `{"daemon_id":"d-x","max_tasks":1}`
  2. 执行请求 `POST $BASE/api/daemon/claim`，头 `Authorization: Bearer anv_deadbeef`，体 `{"daemon_id":"d-x","max_tasks":1}`
- 预期结果:
  1. HTTP 401；body.error="missing token"
  2. HTTP 401；body.error="invalid token"
- 执行结果: 未执行

### TC-Agent_008 注册运行时_上报provider_列表可查且在线

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G4
- 测试数据: [daemon_id: d-reg] [provider: kimi] [version: e2e-1.0]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/daemon/register`，头 `Authorization: Bearer $DTOKEN`，体 `{"daemon_id":"d-reg","runtimes":[{"provider":"kimi","version":"e2e-1.0"}]}`
  2. 执行请求 `GET $BASE/api/runtimes`
- 预期结果:
  1. HTTP 200；body.runtimes 长度 1；元素 daemon_id="d-reg"、provider="kimi"、status="online"、last_seen_at 非空
  2. HTTP 200；数组含 daemon_id="d-reg" 且 status="online" 的元素
- 执行结果: 未执行

### TC-Repo_001 创建Issue_填目标仓库_记入最近使用

- 优先级: P2 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2（全新实例）
- 测试数据: [title: 带仓库的任务] [repo_path: D:/anvil]
- 测试步骤:
  1. 执行请求 `POST $BASE/api/issues`，体 `{"title":"带仓库的任务","repo_path":"D:/anvil"}`
  2. 执行请求 `GET $BASE/api/bootstrap`
- 预期结果:
  1. HTTP 201；body.repo_path="D:/anvil"
  2. HTTP 200；recent_repos 长度 1；recent_repos[0]="D:/anvil"
- 执行结果: 未执行

### TC-Repo_002 创建Issue_重复仓库_去重且置顶

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2（全新实例）
- 测试数据: [repo_path1: D:/repo-a] [repo_path2: D:/repo-b]
- 测试步骤:
  1. 依次执行三次 `POST $BASE/api/issues`，体分别为 `{"title":"r1","repo_path":"D:/repo-a"}`、`{"title":"r2","repo_path":"D:/repo-b"}`、`{"title":"r3","repo_path":"D:/repo-a"}`
  2. 执行请求 `GET $BASE/api/bootstrap`
- 预期结果:
  1. 三次响应均为 HTTP 201
  2. recent_repos 长度 2；recent_repos[0]="D:/repo-a"；recent_repos[1]="D:/repo-b"
- 执行结果: 未执行

### TC-Repo_003 最近仓库_写入第九个_仅保留八个

- 优先级: P3 | 类型: 接口
- 前置条件: 已完成全局准备 G1、G2（全新实例）
- 测试数据: [repo_path 列表: D:/repo-r1 至 D:/repo-r9]
- 测试步骤:
  1. 依次执行九次 `POST $BASE/api/issues`，体 `{"title":"rk","repo_path":"D:/repo-rK"}`（K 从 1 到 9）
  2. 执行请求 `GET $BASE/api/bootstrap`
- 预期结果:
  1. 九次响应均为 HTTP 201
  2. recent_repos 长度 8；recent_repos[0]="D:/repo-r9"；数组不含 "D:/repo-r1"
- 执行结果: 未执行

### TC-Board_001 打开看板_页面加载_七列与新建按钮可见

- 优先级: P0 | 类型: 页面
- 前置条件: 环境 P1 就绪；浏览器窗口 1920×1080
- 测试步骤:
  1. 打开 `http://localhost:5173/`
  2. 核对七列标题与页面元素
- 预期结果:
  1. 页面标题为"看板"；左侧导航含"看板"、"Agents"两项与品牌"Anvil"；导航底部有"深色模式"按钮
  2. 七列标题依次为：收集箱、待办、进行中、待验收、已完成、阻塞、已取消；每列带计数徽章与列头"＋"按钮；页面右上有"新建 Issue"按钮
- 执行结果: 未执行

### TC-Board_002 新建弹窗_标题留空_创建按钮禁用

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；已在看板页
- 测试步骤:
  1. 点击"新建 Issue"按钮
  2. 检查"创建任务"按钮状态
  3. 在"输入任务标题..."输入框输入 `x`
- 预期结果:
  1. 弹出标题为"新建 Issue"的对话框；含标题输入框、描述、验收标准、优先级、指派给、目标仓库输入框
  2. "创建任务"按钮为禁用态
  3. "创建任务"按钮变为可点击
- 执行结果: 未执行

### TC-Board_003 新建Issue_完整填写_卡片进入待办列

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；存在名为 anvil-01 的 Agent（无则先在 Agents 页创建）
- 测试数据: [标题: 看板冒烟任务] [优先级: high] [指派给: anvil-01] [目标仓库: D:/anvil]
- 测试步骤:
  1. 点击"新建 Issue"，标题输入"看板冒烟任务"，优先级选 high，指派给选 anvil-01，目标仓库输入 D:/anvil
  2. 点击"创建任务"
  3. 检查待办列新出现的卡片
- 预期结果:
  1. 各字段填入成功
  2. 对话框关闭
  3. 待办列出现标题为"看板冒烟任务"的卡片；含 high 优先级徽章；含 anvil-01 名字与圆点标识；任务徽章为"排队中"、"执行中"或"待验收"之一
- 执行结果: 未执行

### TC-Board_004 新建弹窗_双击创建_仅生成一张卡片

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；已在看板页
- 测试数据: [标题: 双击探针]
- 测试步骤:
  1. 点击"新建 Issue"，标题输入"双击探针"
  2. 快速双击"创建任务"按钮
  3. 检查待办列中标题为"双击探针"的卡片数量
- 预期结果:
  1. 标题填入成功
  2. 对话框关闭
  3. 该标题的卡片数量为 1
- 执行结果: 未执行

### TC-Board_005 任务卡片_交付待验收_显示徽章与变更统计

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；看板存在任务已 completed 且 result_json 含 branch 的卡片（如一条跑完真实任务的卡片）
- 测试步骤:
  1. 检查该卡片的徽章区域
- 预期结果:
  1. 卡片显示琥珀色"待验收"徽章（图标+文字双编码）；徽章下方显示等宽小字的变更统计（形如 "1 file changed"）；卡片整体带淡琥珀色底
- 执行结果: 未执行

### TC-Board_006 打开任务面板_点击卡片_显示日志与评论区

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；看板存在至少一张有执行记录的卡片
- 测试步骤:
  1. 点击该卡片
  2. 检查右侧面板内容
- 预期结果:
  1. 右侧打开任务面板，宽度约占页面 42%
  2. 面板标题为 Issue 标题；含"执行日志"与"评论"两个小节；若任务 completed 且有交付分支，另含"交付"小节（分支名、变更统计、diff、"合入"按钮与"打回意见…"输入框）
- 执行结果: 未执行

### TC-Board_007 打回重跑_提交意见_执行重新排队

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；已打开一张处于待验收（completed 且有交付分支）卡片的面板
- 测试数据: [打回意见: 请补充单元测试]
- 测试步骤:
  1. 在"打回意见…"输入框输入"请补充单元测试"
  2. 点击"提交意见并重跑"
  3. 检查评论区与卡片任务徽章
- 预期结果:
  1. 输入成功
  2. 评论区新增一条 member 评论"请补充单元测试"，并新增一条系统记录"任务已入队（触发：rerun）"
  3. 卡片任务徽章变为"排队中"或"执行中"
- 执行结果: 未执行

### TC-Board_008 任务面板_发送评论_列表即时显示

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；已打开一张卡片的面板
- 测试数据: [评论: 面板评论探针]
- 测试步骤:
  1. 在"追加指令或评论…"输入框输入"面板评论探针"
  2. 点击"发送"
  3. 检查评论列表
- 预期结果:
  1. 输入成功
  2. 输入框清空
  3. 评论列表出现一条 member 评论，内容为"面板评论探针"
- 执行结果: 未执行

### TC-Board_009 切换主题_点深色模式_界面与存储同步

- 优先级: P1 | 类型: 页面
- 前置条件: 环境 P1 就绪；当前为浅色主题（导航底部按钮文案为"深色模式"）
- 测试步骤:
  1. 点击导航底部"深色模式"按钮
  2. 检查页面配色、按钮文案、localStorage 的 anvil-theme 键与 html 元素的 data-theme 属性
- 预期结果:
  1. 页面切换为深色配色
  2. 按钮文案变为"浅色模式"；localStorage 中 anvil-theme="dark"；html 元素 data-theme="dark"
- 执行结果: 未执行

### TC-Board_010 主题持久化_刷新页面_保持深色

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；当前主题为深色（localStorage anvil-theme="dark"，html 元素 data-theme="dark"）
- 测试步骤:
  1. 按 F5 刷新页面
  2. 检查页面配色与导航底部按钮文案
- 预期结果:
  1. 页面重新加载完成
  2. 页面保持深色配色；按钮文案为"浅色模式"
- 执行结果: 未执行

### TC-Board_011 生成凭据_点击按钮_明文仅出现一次

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪
- 测试步骤:
  1. 进入 Agents 页，点击"生成新 token"
  2. 检查凭据展示区
  3. 按 F5 刷新页面，再次检查凭据展示区与列表
- 预期结果:
  1. 出现深色凭据框，内容为以 "anv_" 开头的字符串，右侧有"点击复制"提示
  2. 凭据完整可见
  3. 深色凭据框消失；Daemon Token 表格中新增一行 label="default"，行内无凭据明文
- 执行结果: 未执行

### TC-Board_012 吊销凭据_弹窗确定_状态变已吊销

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；Agents 页 Daemon Token 表格存在一行状态为"有效"的凭据
- 测试步骤:
  1. 点击该行"吊销"按钮
  2. 在系统对话框中点击「确定」
  3. 检查该行状态列
- 预期结果:
  1. 弹出系统对话框，文案含"确定吊销 token"
  2. 对话框关闭
  3. 该行状态变为"已吊销"；"吊销"按钮不再显示
- 执行结果: 未执行

### TC-Board_013 看板实时刷新_接口建Issue_卡片自动出现

- 优先级: P2 | 类型: 页面
- 前置条件: 环境 P1 就绪；看板页已打开；已从 `GET http://127.0.0.1:3100/api/bootstrap` 取得 WSID
- 测试数据: [title: 实时刷新探针]
- 测试步骤:
  1. 在终端执行请求 `POST http://127.0.0.1:3100/api/issues`，体 `{"title":"实时刷新探针","status":"backlog"}`
  2. 不刷新页面，仅等待 10 秒
  3. 检查收集箱列
  4. 执行请求 `PATCH http://127.0.0.1:3100/api/issues/<该Issue id>`，体 `{"status":"cancelled"}`（清理现场）
- 预期结果:
  1. HTTP 201
  2. 页面无手动刷新
  3. 收集箱列出现"实时刷新探针"卡片（由 WS 广播驱动，非手动刷新）
  4. HTTP 200；卡片移入已取消列
- 执行结果: 未执行

### TC-Board_014 窄窗口_宽度1366_看板列横向滚动

- 优先级: P3 | 类型: 页面
- 前置条件: 环境 P1 就绪；已在看板页
- 测试步骤:
  1. 将浏览器窗口宽度调至 1366×768
  2. 检查列布局与滚动条
- 预期结果:
  1. 页面无布局错乱
  2. 看板列保持 320px 固定宽；看板容器出现横向滚动条，可滚动浏览七列；左侧导航仍完整可见
- 执行结果: 未执行

### TC-Board_015 空列_无卡片_显示无任务占位

- 优先级: P3 | 类型: 页面
- 前置条件: 环境 P1 就绪；看板存在一列无任何卡片（如阻塞列）
- 测试步骤:
  1. 检查该空列内容区
- 预期结果:
  1. 列内显示虚线边框占位区，文案为"无任务"
- 执行结果: 未执行

### TC-Board_016 新建弹窗_最近仓库_点击回填输入框

- 优先级: P3 | 类型: 页面
- 前置条件: 环境 P1 就绪；当前 workspace 已有最近仓库记录（recent_repos 至少 1 条）
- 测试步骤:
  1. 点击"新建 Issue"
  2. 检查目标仓库输入框下方区域
  3. 点击其中一个仓库 chip
- 预期结果:
  1. 对话框打开
  2. 输入框下方显示圆角 chip，数量与 recent_repos 条数一致，文本为仓库路径
  3. 目标仓库输入框内容变为该 chip 的文本
- 执行结果: 未执行

## 需求覆盖矩阵

| 功能点 | 来源章节 | 用例编号 |
|--------|----------|----------|
| 1.1 创建 Issue（字段、校验、落库） | spec §5；PROGRESS 第0波（acceptance） | TC-Issue_001~005、015、016 |
| 1.2 状态流转与评论时间线 | spec §5/§6 | TC-Issue_006~009、013、014 |
| 1.3 入队三入口（指派/backlog 移出/重跑） | spec §6 | TC-Issue_002、005、006、010~012 |
| 2.1 原子认领与优先级排序 | spec §6 | TC-Dispatch_001~004 |
| 2.2 租约与过期清扫 | spec §6 | TC-Dispatch_005、006 |
| 2.3 有限重试（重试链） | spec §6/§8 | TC-Dispatch_007、008 |
| 2.4 取消执行 | spec §6 | TC-Dispatch_009、010 |
| 2.5 runtime 注册/心跳/离线清扫 | spec §5/§6 | TC-Agent_008、TC-Dispatch_011 |
| 3.1 开始上报（start） | spec §6 | TC-Exec_001~003 |
| 3.2 消息流 seq 连续性与幂等 | spec §6 | TC-Exec_004~006 |
| 3.3 完成/失败上报 | spec §6/§8 | TC-Exec_007~009 |
| 3.4 状态回调与交付信号 delivered_at | PROGRESS 第0波 | TC-Exec_010、011 |
| 3.5 任务级凭据隔离 | spec §6 安全设计 | TC-Exec_012、TC-Agent_006、007 |
| 4.1 diff 获取 | PROGRESS 验收链路 | TC-Review_001、002 |
| 4.2 合入（成功/冲突/前置校验） | PROGRESS 验收链路；2026-08-06 冲突详情修复 | TC-Review_003~005 |
| 4.3 打回重跑（意见进评论、重新入队） | PROGRESS 验收链路 | TC-Board_007 |
| 5.1 Agent 创建与状态展示 | spec §5；PROGRESS 第1波 | TC-Agent_001、002、TC-Dispatch_001 |
| 5.2 daemon 凭据签发/列表/吊销 | PROGRESS 第1波 | TC-Agent_003~005、TC-Board_011、012 |
| 6.1 目标仓库 repo_path 记录 | PROGRESS 远程仓库 | TC-Repo_001 |
| 6.2 最近使用仓库（去重/置顶/上限/回填） | PROGRESS 远程仓库 | TC-Repo_002、003、TC-Board_016 |
| 7.1 看板骨架（七列/计数/空态/响应式） | PRODUCT.md；DESIGN.md | TC-Board_001、014、015 |
| 7.2 新建 Issue 弹窗 | PRODUCT.md；PROGRESS | TC-Board_002~004 |
| 7.3 任务面板（日志/交付/评论） | PRODUCT.md 设计原则 3/4 | TC-Board_005~008 |
| 7.4 双主题（切换/持久化） | DESIGN.md 双主题工程 | TC-Board_009、010 |
| 7.6 实时刷新（WS 广播） | spec §4；PROGRESS 第1波 | TC-Board_013 |

## 执行汇总

- 总数 71 | 通过 - | 失败 - | 阻塞 - | 未执行 71 | 通过率 -
- 缺陷清单: 无
