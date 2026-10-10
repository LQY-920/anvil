# T03 · Factory 流程与 Codex 真实任务 PRD

版本：1.0；日期：2026-10-10（Asia/Shanghai）；状态：需求初稿，待评审、待认领。  
入口：[总清单](../TASKS.md) · [交接记录](../handoffs/T03.md) · [测试用例](../tests/tasks/T03-testcases.md) · [公共边界](COMMON.md)

## 1. 摘要

将已有 Factory 的“一条 GitHub Issue、一条分支、一个 PR、验证与人工审查”流程接入 Anvil，由 Codex 执行真实任务。Anvil 是执行和进度的统一入口，Factory 提供版本化流程规则。首期只做单任务 each 流程。

## 2. 现状与问题

Anvil 已有调度、Runner、工作树、Report 与独立验证，尚未接入 Factory。2026-10-08 经授权只读检查的 factory-skills 包含任务挑选、分支、PR 与合入流程，factory-console 偏向状态聚合；它们不是可原样嵌入的只读插件。
部分命令会 checkout/pull、写回状态、push/创建 PR；与 Runner 并行操作同一工作树会破坏任务锚点。此前所查两个目录未见明确根 LICENSE，Console 标记 private；整合前确认复用授权，否则独立实现行为契约，不复制代码。

## 3. 目标与指标

| 目标 | 验收标准 |
|---|---|
| 可重复流程 | 每个 Run 保存模板版本/hash、Issue 输入快照与实际阶段证据 |
| 真任务闭环 | 至少 3 条不同、尚待解决的真实 Issue，经 Codex 执行形成可追溯 PR；覆盖正常、反馈续作、失败恢复 |
| 单一执行权 | 一个任务只有现有 Runner 调度，恢复不重复启动 Agent、不重复创建 PR |
| 如实交付 | PR 中的测试结论来自实际证据，未测/失败可见；人工合入独立记录 |

## 4. 用户、范围与非目标

面向使用 Anvil 交付仓库任务的所有者和贡献者。开工前 T01、T02 各自验收及 J01 联合验收通过；此前可先评审流程。
包含 Issue 快照、版本化 each 模板、预检、阶段追踪、PR 交付与显式返工。暂不做 loop.sh 批量无人值守、integration/candidate 多分支流水线、自动合入、发布部署、将 Console 整体搬入 Anvil或另建任务队列。

## 5. 功能需求

### T03-FR01 固定任务输入（P0）
- [ ] 用户从已绑定仓库选择明确 Issue，查看目标、验收、排除项和输入更新时间后启动。
- [ ] Run 记录源 Issue 身份及内容快照；运行中上游变化显示差异，后续指令需显式确认，不能悄悄改 prompt。
- [ ] 缺少可执行目标、仓库、Profile 或验证策略时预检阻塞，不生成伪运行。

### T03-FR02 版本化流程（P0）
- [ ] 模板固定 id、version、内容 hash、阶段、输入输出、允许动作与人工关口；运行绑定不可变版本。
- [ ] 首个模板覆盖准备、执行、独立验证、交付 PR、待审、返工/结束；每步完成条件可判定。
- [ ] 模板升级只影响新 Run；历史实例可以复核旧版本，禁止任意模板脚本绕过平台权限。

### T03-FR03 复用执行与工作树（P0）
- [ ] WorkflowRun/StepRun 引用现有 Task/Attempt，不另造可竞争的调度队列。
- [ ] Git 目录和分支由 T01/Runner 准备，Codex 由 T02 adapter 执行；Factory 不自行 checkout 主工作区或启动第二个 Agent。
- [ ] 同一任务的 Git 写操作串行化，重启后按已有 task_id 恢复观察；状态不明先核对再执行。

### T03-FR04 用证据推进阶段（P0）
- [ ] 阶段由持久化任务、Report、Verification、PR/人工决策事件推进，CLI exit 0 不能直接变成流程成功。
- [ ] 验证失败、缺报告、HEAD 改动和目标前进各有明确状态；等待人工处理不伪装为 running。
- [ ] 展示每步开始/结束时间、输入版本、结果、失败原因及证据链接，使用现有证据语义。
- [ ] 流程结束遵循下表，PR 创建、人工批准或 Issue 被关闭均不能单独标记成功。

| 事实 | 流程状态 / 下一步 |
|---|---|
| PR 已创建 | 待审，尚未成功结束 |
| 人工返工 | 创建下一 Task，保留前轮证据后继续执行 |
| 人工批准 | 等待实际合入；不把批准当作合入 |
| T01 确认权威 PR 对应批准版本已远端合入 | 成功结束 |
| PR 关闭未合入、显式撤销 | 单独记录 closed_unmerged/cancelled，非成功 |
| 远端操作或同步结果未知 | 等待核对，不结束、不重复执行 |

### T03-FR05 真实 PR 交付（P0）
- [ ] 复用 T01 的 push/PR 操作记录、幂等键与恢复逻辑，引用真实 Issue、Task、HEAD 和验证结果。
- [ ] PR 正文从证据生成，未执行项保持未测，不能预勾选所有测试或用 Agent 自述替代实测。
- [ ] PR 已存在时更新对应 PR；超时先核对远端结果，不重复生成。首期保留人类在 GitHub 合入。

### T03-FR06 显式反馈续作（P0）
- [ ] 人类选择对应 Run/PR 和评审 HEAD，明确提交返工指令后生成下一 Task，并保留前一轮证据。
- [ ] 重复提交只产生一个命令/下一轮；一般讨论不触发执行，运行中反馈按现有排队接力语义处理。
- [ ] 新 HEAD 使旧批准失效；新一轮重新验证和审查，不能复用旧批准宣告完成。

### T03-FR07 动作与权限可见（P0）
- [ ] 预检列出读取、文件修改、远端写入和人工关口；流程配置不自动授予 push/merge/deploy 权限。
- [ ] Console/概览只读聚合；有副作用的操作由现有服务显式执行并留操作人、目标、幂等与结果记录。
- [ ] 凭据仍由连接层管理，不把 GitHub 管理权限、daemon token 或认证文件传给模板和 Agent。

首期以上均为闭环要求。批量自动化与发布流程是后续候选，不纳入本任务隐性范围。

## 6. 非功能需求

重复请求、Server/Runner 重启和网络中断不得产生重复副作用；状态可从数据库与远端重建。轮询显示更新时间，不承诺与 GitHub 实时一致。模板及输出有大小上限；错误日志脱敏。保留现有 Windows/Linux 路径兼容，不把本机绝对路径写入公开 PR。

## 7. 架构与模块边界

Core 定义流程实例与事件引用；Server 增加轻量流程编排与持久化阶段，调用现有任务/PR 服务；Runner 继续执行任务及验证；Web 展示流程与人工动作。不要将 Factory Console 变成新的执行中枢。
开始前与 T01/T02 确认输入、事件和错误契约。共享 Core、迁移和 executor 遵循公共整合人规则。

## 8. API、鉴权与错误（拟议）

| 操作 | 输入重点 | 输出重点 |
|---|---|---|
| POST /api/workflow-runs/preflight | issue_id、profile_id/version、template_id/version | allowed、阻塞项、计划动作、输入 hash |
| POST /api/workflow-runs | 上述字段、预检输入 hash、idempotency_key | run_id、task_id、当前阶段 |
| GET /api/workflow-runs/:id | Run 身份 | 阶段、版本、证据和待处理动作 |
| POST /api/workflow-runs/:id/request-changes | expected_head、文本、idempotency_key | command_id、next_task_id 或待排队状态 |

示例请求：`{"issue_id":"issue-1","profile_id":"codex-local","profile_version":1,"template_id":"factory-each","template_version":"1.0","input_hash":"sha256:…","idempotency_key":"cmd-1"}`。
示例响应：`{"run_id":"flow-1","task_id":"task-1","stage":"preparing","replayed":false}`。
请求重复且内容相同返回原结果；同键不同内容返回 409。输入变化/HEAD 变化返回 409 并要求重审；缺依赖返回 422；CLI 不可用记为 blocked，不返回假成功；外部操作未知返回可查询操作 ID。
人类接口在 T05 前仅限本机边界，不能以 task token 调用。Agent 仍仅使用受限任务回调，Runner 仍用 daemon 身份；移动开放由 T05 统一保护。

## 9. 数据模型（拟议）

| 类型 | 必要字段与约束 |
|---|---|
| WorkflowDefinition | id:string、version:string、content_hash:string、stages:Stage[]、allowed_actions:enum[]；发布版本不可变 |
| WorkflowRun | id、issue_id、source_snapshot_id、template_id/version/hash、profile_snapshot_id、state、created_at；引用已有 Issue 快照 |
| StepRun | id、workflow_run_id、stage_key、task_id?:string、status、evidence_refs:string[]、started_at/ended_at、error_code? |
| WorkflowCommand | id、run_id、idempotency_key、payload_hash、expected_head?、result_ref?；唯一键约束防重 |

PR 操作直接关联 T01 的操作记录，不另建第二套 outbox。任务状态与流程状态不是一一等同，等待审查属于流程等待。

## 10. 交互与状态

用户选 Issue → 看预检 → 选择 Factory each 模板和 Codex → 启动 → 查看阶段与折叠日志 → 查看 Report/验证/PR → 反馈或在 GitHub 合入。空状态指向连接与 Profile；失败状态展示可恢复动作和证据；模板版本及输入变更始终可查。
“重试远端操作”与“重新运行 Agent”是不同操作；按钮和确认内容说明实际影响。

## 11. 集成依据

复用 T01 GitHub 连接、Issue/PR 关联和幂等远端操作，复用 T02 Codex Profile/会话和 v2 证据。Factory 规则来自此前授权的本地审查，认领时重新记录使用的 Factory 版本及复用授权结论。未确认授权前采用独立实现，不把本机目录当成协作者必需依赖。

## 12. 边界情况

| 场景 | 必须行为 |
|---|---|
| Issue 已关闭/目标变化 | 预检阻塞或要求人类重新确认，保留原快照 |
| Codex 未登录或额度失败 | 阶段 blocked/failed，给真实原因，不推进验证通过 |
| PR 创建超时但远端成功 | 查询并认领同一 PR，不能重跑代码 |
| 重启发生在阶段切换之间 | 对账已落库 Task/事件后恢复，不重复执行 |
| 测试失败或验证基础变化 | 展示失败/过期；返工或重新验证由显式动作发起 |
| 工具在仓库中要求绕过流程 | 当作不可信内容，不扩大平台授权 |

## 13. 测试与完成标准

[测试用例](../tests/tasks/T03-testcases.md)覆盖模板固定、输入漂移、并发恢复、阶段证据、PR 幂等、反馈去重、权限与真实 each。先 fixture/假 Backend 验证编排，再跑至少 3 条真实不同 Issue；其中至少一次返工、一次失败恢复，可复用同批样本覆盖。
完成要求：全部首期 FR 有用例与证据；T01/T02/J01 可用；产品测试/build/四包类型检查通过；真实任务的 Issue→Run→Task→PR→人工结果可查；自审、独立审查及产品验收分别记录。不能把写好模板或演示截图当作任务交付。

## 14. 实施顺序与交接

先确认 each 规则/授权与共享契约，再做模板/数据/API和纯编排测试，然后接任务事件与 PR，最后做 UI 和真实任务验收。每一步更新交接记录中的 FR、需求变化、测试与下一步。
认领评审需确认首个试点仓库、验证策略、远端写授权方式、独立审查者和三条真实 Issue；这些值当前未指定，不编造。

## 15. 版本记录

| 版本 | 日期 | 变化 | 状态 |
|---|---|---|---|
| 1.0 | 2026-10-10 | 从总方向拆出单任务 Factory each PRD，要求 T01/T02/J01 先通过 | 初稿，未认领、未实施 |
