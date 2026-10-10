# Anvil 设计文档 —— 个人 AI Agent 工作台（一期：编码任务调度）

- 日期：2026-08-04
- 状态：已评审（头脑风暴阶段四段设计均获确认）
- 项目根：`D:/anvil`

## 1. 背景与目标

Anvil 是一个自建的"AI Agent 工作台"，服务对象是一名程序员的一人公司（OPC）。它要承载两类业务：

1. **编码任务自主执行**（一期）：看板上的任务指派给 Agent 后，Agent 自主认领、在本地执行编码 CLI、实时回报进度、完成后进入 review。
2. **自媒体运营调度**（二期）：选题 → 内容产出 → 待发队列的流程自动化（4 个平台 8 个账号），复用一期的任务调度内核。

**不自建不行吗？** 同类产品 Multica（github.com/multica-ai/multica）功能匹配，但其许可证为 Apache 2.0 + 附加条款：向第三方提供托管服务或嵌入商业产品需商业授权，且 UI 品牌不得移除。本项目要保留将来产品化的可能，因此独立自建。

**著作权红线**：可以参考 Multica 的产品理念与已验证的机制设计，但不复制其代码、UI 布局与品牌资产。Anvil 全部代码从零编写（主要由 AI 编码 Agent 产出），采用 MIT License。

**成功标准（一期）**：

- 在看板创建一个 issue 并指派给 Agent，无需任何进一步人工干预，Agent 在本地机器完成编码并提交分支，看板实时可见执行日志流，结束后 issue 进入 `in_review`。
- daemon 无人值守连续运行 24 小时不退出，单任务崩溃不影响其他任务。
- runner 掉线、卡死、超时等故障能被自动检测并按策略恢复或标记。

## 2. 定位与边界

- **实现按单租户，数据模型按多租户**：所有业务表挂 `workspace_id`，自用期只有一个 workspace、一个用户；产品化时不需要改数据层。
- **一期范围**：编码任务调度全链路（看板 + server + runner + Kimi Code adapter）。
- **一期不做**：autopilot 定时调度、squads、skill 注入逻辑、浏览器自动化发布、多用户权限、计费、云运行时。其中 `skills` 相关三张表先进 schema（为二期免迁移），但不实现任何读写逻辑。

## 3. 技术选型

| 决策点 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript 全栈 | AI 编码 Agent 生成质量最高的语言；实时面板是 Node 生态主场 |
| 仓库形态 | pnpm monorepo | 前后端 + runner 共享 `packages/core` 协议类型 |
| 前端 | React + Vite | 看板 + 日志流，无 SSR 需求 |
| 后端 | Node.js + Fastify + @fastify/websocket | 成熟、生态大，AI 编码 Agent 对其最熟悉；REST + WS 一体 |
| ORM | Drizzle | 声明式 schema，SQLite → PostgreSQL 迁移成本低 |
| 数据库 | SQLite（开发期与自用期） | 单用户零运维；产品化出口是 PostgreSQL（pgvector 预留语义检索可能），MySQL 不在路径上 |
| 首个 Agent CLI | Kimi Code（headless 流式模式） | 用户日常在用；adapter 接口通用化，后续 Claude Code / Codex 各加一个文件 |
| 测试 | vitest | 前后端 runner 统一 |

## 4. 总体架构

```
pnpm monorepo
├── apps/server    Node 后端：REST + WS，任务调度与状态机，唯一状态权威
├── apps/web       React 看板：任务列表、详情（日志流/diff/评论）、Agent 与 Runner 管理
├── apps/runner    本地执行 daemon：认领任务 → git worktree → spawn Agent CLI → 流式回报
└── packages/core  纯类型：Task/Agent/Workspace 领域模型、server↔runner 消息协议、事件枚举
```

职责边界：

- **server**：任务 CRUD、调度（把 queued 任务派给有空闲容量且具备所需 adapter 的 runner）、接收 runner 事件推进状态机、向 web 广播实时更新。不碰 git、不碰 Agent 进程。
- **runner**：长驻 daemon，HTTP 轮询为主（10s），WS 仅接收"有活了"轻提示（提示丢失无害）。启动时探测本机可用 Agent CLI 并注册为 runtime。领到任务后建 git worktree、spawn CLI、流式回传输出、结束上报。
- **web**：仅三个页面——看板、任务详情、Agent/Runner 管理。
- **packages/core**：无逻辑纯类型，三方共同依赖，保证协议一致。

设计意图：server 与执行环境完全解耦。runner 可跑在任何机器；二期媒体运营子系统的"浏览器自动化执行器"只是另一种 runner，server 无需改动。

## 5. 数据模型

SQLite + Drizzle。所有业务表挂 `workspace_id`。共 13 张表（含二期预留 3 张）。

### 组织层

- `workspaces(id, name, slug UNIQUE, settings_json, created_at)`
- `users(id, email UNIQUE, name, password_hash, created_at)`
- `workspace_members(workspace_id, user_id, role CHECK IN ('owner','admin','member'))`

### 任务层

- `issues(id, workspace_id, title, description, status, priority, assignee_type, assignee_id, creator_type, creator_id, position, created_at, updated_at)`
  - `status`：`backlog / todo / in_progress / in_review / done / blocked / cancelled`（7 值）
  - `priority`：`urgent / high / medium / low / none`
  - `assignee_type`：`member | agent`，与 `assignee_id` 组成多态指派（无 FK，应用层解析）；`creator_type/creator_id` 同构
  - `position FLOAT`：看板列内排序
- `tasks(id, workspace_id, issue_id, agent_id, runtime_id, status, priority, attempt, max_attempts, parent_task_id, failure_reason, session_id, work_dir, result_json, error, lease_expires_at, dispatched_at, started_at, completed_at, created_at)`
  - **一行 = 一次执行**（run），无独立 run 表
  - `status`：`queued / dispatched / running / completed / failed / cancelled`
  - 部分唯一索引：同一 issue 至多一条 `queued/dispatched`（去重保险）
  - `session_id / work_dir`：同 issue 下次任务用 resume 恢复 Agent 会话
  - `parent_task_id`：重试链；`attempt/max_attempts` 默认 3
- `task_messages(id, task_id, seq, type, tool, content, input_json, output, created_at)`
  - 执行 transcript；`type` 统一 7 型：`text / thinking / tool_use / tool_result / status / error / log`
  - `(task_id, seq)` 索引；seq 由 runner 连续编号
- `comments(id, issue_id, author_type, author_id, type, body, created_at)`
  - `type`：`comment / status_change / progress_update / system`——时间线事件复用评论表（Multica 的 comment/activity_log/inbox 三套并存是历史包袱，Anvil 合并为一条流）

### 执行层

- `agents(id, workspace_id, name, provider, status, max_concurrent_tasks DEFAULT 1, runtime_id, created_at)`
  - `provider`：初版仅 `'kimi'`，白名单与 adapter 实现对齐
  - `status`：`idle / working / blocked / error / offline`
- `runtimes(id, workspace_id, daemon_id, provider, version, status, last_seen_at)` + `UNIQUE(workspace_id, daemon_id, provider)`
  - 一台 daemon 机器注册 N 个 runtime（探测到几个 CLI 注册几个）
  - `status`：`online / offline`，由心跳维持
- `daemon_tokens(id, workspace_id, token_hash, label, revoked_at, created_at)`
  - daemon 凭据，哈希存储，可吊销

### 二期预留（仅建表，不实现逻辑）

- `skills(id, workspace_id, name, description, content, config_json)` + `UNIQUE(workspace_id, name)`
- `skill_files(id, skill_id, path, content)`
- `agent_skills(agent_id, skill_id)`

## 6. 任务状态机与执行流

### 双状态机，刻意解耦

```
issue:  backlog → todo → in_progress → in_review → done
                    ↘ blocked ↗              ↘ cancelled

task:   ∅ → queued → dispatched → running → completed / failed / cancelled
```

issue 状态不由平台推进。任务下发时 prompt 中告知 Agent："完成后用平台 CLI 将 issue 移到 in_review"。平台只提供带权限的回调端点。平台逻辑保持极薄，智能在 Agent 侧。

### 入队触发（server 侧仅有的三个入口）

1. issue 被指派给 agent 且状态非 backlog（backlog 是停车场，不触发执行）；
2. issue 从 backlog 移到活跃状态且 assignee 是 agent；
3. 看板手动"重跑"按钮。

### 执行主流程（runner 视角）

1. runner 每 10s `POST /api/daemon/claim` 轮询；WS 收到 task-available 提示时立即轮询一次。
2. server 原子认领：事务内单条 `UPDATE tasks SET status='dispatched', lease_expires_at=now+2min WHERE id=? AND status='queued'`，影响行数判赢（SQLite 单写者，语义等价 `FOR UPDATE SKIP LOCKED`）；候选排序 `priority DESC, created_at ASC`；认领前检查该 agent 的 `max_concurrent_tasks`。
3. runner 收到任务包（issue 内容、上次 `session_id/work_dir`、任务级 token）→ `git worktree add -b task/<short-id>` 建隔离工作区 → spawn Kimi Code headless 流式模式（确切命令行参数以实现时 Kimi Code 实际协议为准），prompt 走 stdin。
4. stdout 逐行解析为 7 型 Message；解析失败的行原样包成 `type='log'` 上报。每 500ms 批量 POST 回 server（seq 连续编号），server 落库 `task_messages` 并 WS 广播给看板。
5. 结束 POST `/complete`（分支名/diff 摘要）或 `/fail`；看板实时翻转状态。

### 故障恢复三件套（第一天内建）

- **认领即租约**：`dispatched` 带 2 分钟 `lease_expires_at`；清扫任务把过期未 `running` 的任务重新排队。
- **卡死与离线检测**：runner 心跳超阈值 → 其 `dispatched/running` 任务置 `failed / failure_reason='runtime_offline'`。
- **有限重试**：`attempt < max_attempts`（默认 3）的失败任务派生子任务（`parent_task_id` 回链）重新入队；超限停在 `failed` 等人工处理。

### 安全设计

- **任务级 token**：claim 时签发绑定 `(task_id, agent_id)` 的短期 token，经环境变量注入子进程（`ANVIL_TOKEN`、`ANVIL_SERVER_URL`、`ANVIL_WORKSPACE_ID`、`ANVIL_AGENT_ID`、`ANVIL_TASK_ID`）。daemon 高权限凭据绝不进 Agent 进程。
- **redact**：消息上报前过滤上述环境变量值，替换为 `***`。

### 取消与超时

- 看板取消 → server 置 `cancelled` → runner 5s 轮询任务状态发现 → 杀整个进程组（防止孤儿化 CLI 拉起的子进程）。
- **idle watchdog 而非总超时**：N 分钟（默认 30min）无任何消息判死；编码 Agent 长静默但活着是常态，不按 wall-clock。

## 7. AgentAdapter 接口

```ts
interface AgentBackend {
  execute(ctx: CancelToken, prompt: string, opts: ExecOptions): Promise<AgentSession>;
}
interface AgentSession {
  messages: AsyncIterable<AgentMessage>;  // 7 型消息流
  result: Promise<AgentResult>;           // 恰好一条：completed/failed/aborted/timeout/cancelled
}
```

- 每种 CLI 一个文件，自管参数构建、输出解析、禁用参数清单（防止用户自定义参数破坏流式协议）。
- 初版仅实现 `kimi.ts`；`claude-code.ts`、`codex.ts` 后续各加一个文件。
- `provider` 白名单与 DB CHECK 同步维护。

## 8. 错误处理

- **任务失败是业务状态，不是系统告警**：Agent 进程非零退出、idle 超时、解析失败一律落成 `tasks.status='failed'` + `failure_reason` + `error` 文本，看板可见。
- `failure_reason` 枚举（初版 6 值）：`runtime_offline / idle_timeout / spawn_failed / non_zero_exit / lease_expired / cancelled_by_user`。
- 平台错误（server/runner 自身）进结构化日志（pino，JSON 行，带 `task_id/issue_id` 上下文）。
- **runner 纪律：任何异常都不能让 daemon 退出**。单任务崩溃 try/catch 收敛到 fail 上报；主循环永不因单任务死掉。

## 9. 测试策略

TDD（先写失败测试再实现）。重点在状态机与并发边界：

- **packages/core**：协议消息编解码单测。
- **server 状态机**：真实 SQLite（`:memory:`）集成测试，每个状态迁移一个用例；并发用例：并发 claim 同任务只一个赢家、租约过期重派、runtime 离线清扫、同 issue 重复入队被唯一索引拦截。
- **AgentAdapter**：fake CLI 测试替身（按流式协议往 stdout 写固定消息序列的 Node 小脚本），验证消息分型、seq 连续性、idle watchdog、取消杀进程组。**CI 不跑真 CLI**；真 Kimi CLI 冒烟测试手动执行，列入验收 checklist。
- **E2E happy path 一条**：server + runner + fake CLI，从"创建 issue 并指派"到"看板 completed"。
- **不测**：React 组件快照、WS 丢包花式时序（提示丢失无害是设计前提）。

## 10. 验收 checklist（一期完成定义）

- [ ] 创建 issue → 指派 agent → 无人干预完成 → issue 进入 `in_review`，看板全程可见日志流
- [ ] 真 Kimi Code CLI 冒烟通过（手动）
- [ ] daemon 24h 无人值守运行，单任务崩溃隔离
- [ ] 故障三件套各有测试与手动验证：租约过期重派、runner 离线标记、重试链
- [ ] 取消任务后无孤儿进程（`git worktree list` 与进程表干净）
- [ ] 全部 vitest 通过

## 11. 命名约定

- 项目：Anvil；命令行：`anvil`；环境变量前缀：`ANVIL_`
- 仓库：`D:/anvil`（pnpm monorepo）；研究资料：`D:/anvil/research/multica`（仅参考，不复制其代码）

## 12. 二期展望（不在本期实施）

- autopilot 定时调度（cron/webhook → 自动建 issue 派 agent），单实例实现：node-cron + `(trigger_id, planned_at)` 唯一约束幂等，不需要 Multica 的多实例租约调度器
- skill 注入（文件系统注入：写成 SKILL.md 到 provider 原生 skill 目录）
- 媒体运营 runner（浏览器自动化执行器，Playwright MCP；发布环节先半自动）
- 数据库迁 PostgreSQL（产品化节点）
