# T02 · Codex adapter 与测试 PRD

版本：1.0；日期：2026-10-10（Asia/Shanghai）；状态：需求初稿，待评审、待认领。  
入口：[总清单](../TASKS.md) · [交接记录](../handoffs/T02.md) · [测试用例](../tests/tasks/T02-testcases.md) · [公共边界](COMMON.md)

## 1. 摘要

让没有 Kimi 的机器通过 Anvil 使用本机 Codex CLI。用户能配置执行器、观察进度、取消和反馈续作，最终取得 v2 Report 与 Runner 独立验证。本任务交付完整执行链路，而非仅能 spawn 一个进程。使用本地 Git 测试仓库即可独立验收，不等待 GitHub 集成。

## 2. 现状与问题

当前 Provider 枚举、Runner 入口和配置 UI 只有 Kimi；Backend 的 resume:boolean 不足以指定 Codex 会话。Task 虽有 session_id，尚无完整 Provider 会话绑定。
已有消息上传、追问、取消、独立终检与幂等完成，应继续复用。此前仅探测 Codex 0.147.0 版本/帮助，未证明登录、额度、推理可用；实施时重新记录版本。
本地安装 CLI 不能替代平台协议适配，否则会出现串会话、错误成功和无法取消。

## 3. 目标与指标

| 目标 | 验收标准 |
|---|---|
| 无 Kimi 可用 | 干净环境只配置 Codex 即能注册 Runtime、派发和执行 |
| 真实闭环 | 至少 3 个不同真实 v2 Codex Task，至少 1 个反馈续作；记录会话和 Git/验证证据 |
| 生命周期可靠 | 失败、取消、超时、协议错误不假通过，daemon 后续任务仍可运行 |
| 权限保持 | daemon token 不入 Agent，Agent 自述不升级为 Runner 实测 |

## 4. 用户、范围与非目标

用户为本机已有 Codex 的所有者和协作者。包含配置/探测、调度匹配、CLI/JSONL、恢复、Report、取消超时、最小 UI 和使用说明。
不做 GitHub connector、PR Gate、Factory、聊天、手机、pi/dsh 或任意 shell 通用执行器。用户在本机完成 CLI 登录，不复制认证文件。
不默认关闭 sandbox/使用无限权限，不用旧不安全 merge 推真实主干。旧计时样本不作为本任务基础完成前置。

## 5. 功能需求

### T02-FR01 Profile 与执行快照（P0）
用户希望明确选择 Codex 及其配置，任务不会中途换配置。
- [ ] 保存 Provider、路径、允许参数数组、配置版本和 capabilities；平台保留 workdir/session/output 等参数，拒绝覆盖。
- [ ] Task 固定 Profile 版本与非敏感快照；后续编辑不改在途任务，Runtime 仅认领能力匹配的任务。
- [ ] 配置不保存 token/登录文件内容，不拼 shell 字符串，不静默回退 Kimi。

### T02-FR02 探测和无 Kimi 引导（P0）
用户希望知道程序找到、版本兼容和真实可用是不同状态。
- [ ] 分别展示 missing、unsupported_version、auth_not_checked、executable、run_failed；help/version 不标登录成功。
- [ ] 需要推理的探针明确由用户启动，结果单列；未登录/额度错误给可操作原因，不读取认证材料。
- [ ] 默认新配置提供 Codex，Runner 不因没有 Kimi 拒绝启动；历史 Kimi 数据可读、不自动迁移。

### T02-FR03 执行和事件解析（P0）
用户希望看到真实进度与失败原因。
- [ ] 首版基于实测版本 codex exec --json，映射文本、工具、错误、终态、可用 usage；记录实际 CLI 版本。
- [ ] JSONL 支持分块、CRLF、末行无换行、超长事件；stderr 分离脱敏；未知事件有界诊断，不能据此判成功。
- [ ] 退出码、协议结果、交付事实分开；无法确认结果时明确失败，不因“成功”文本或 exit 0 自动交付。
- [ ] Windows .cmd/中文/空格路径和参数传递有真实进程回归；启动失败不退出 daemon。

### T02-FR04 显式会话与续作（P0）
用户希望反馈回到正确仓库和执行上下文。
- [ ] 保存真实 session/thread ID，绑定 Provider/Profile/Runtime/仓库/worktree；禁止全局 resume --last。
- [ ] 两仓库两会话并存不串线；失效 ID、目录丢失、能力不支持要明确阻塞。
- [ ] 用户选择重新开始时显式新 attempt/Task，并注明上下文来源，不假装恢复；执行中输入沿用当前排队接力语义。

### T02-FR05 Report 与独立验证（P0）
用户希望 Agent 说明与平台实测分开。
- [ ] 探针确定受限 task 回调或结构化最终输出转交方案；后者仍是 Agent Report，不能写 Verification。
- [ ] Report 满足大小、脱敏、Task 与最终 HEAD 契约；缺失/旧 SHA 执行既有有界追问，最后一轮仍复核。
- [ ] Runner 从基线策略执行真实检查；Agent 自述通过但终检失败时保存 failed，不进入无限自动修复。
- [ ] complete 前再核对 HEAD/clean；回执未知按相同载荷重试，不改发冲突 fail。

### T02-FR06 取消、超时与权限（P0）
用户希望停住任务且不影响后续工作。
- [ ] 区分取消、idle timeout、spawn failed、非零退出、协议错误；终止对应进程树，不杀旧 PID。
- [ ] 执行进入终检后取消作用于终检进程；终态竞争可复现并保持一致。
- [ ] 无法在所选策略完成的批准请求进入明确 blocked/error，不无限等待或默认批准。
- [ ] 子进程无 daemon token；回调失败不自动关闭 sandbox 或扩大网络权限。

上述均为适配器基本正确性。多 Provider、运行中实时 steering、插件市场和复杂模型管理属于后续增强。

## 6. 非功能要求

输出有界、脱敏，stdout 和 stderr 独立；单任务错误不使 daemon 退出。敏感环境变量只按需要传递；Windows 进程树与系统路径兼容保持。
旧 v1/Kimi 任务可读、既有 v2 验证不降级。真实推理耗时不设虚假固定响应 SLA，平台接收事件后在本机及时展示并有心跳/超时依据。

## 7. 架构与文件边界

复用 Core、Fastify/SQLite、Runner、React。T02 维护 agents/codex、probe/config/process、Profile/Runtime 匹配和最小配置 UI。
Backend 接收准备好的 workDir/prompt/env/明确 session/超时取消，返回规范消息、session 和结果；不管理 worktree、push、PR、合入。
executor 统一准备、执行、追问、终检和完成，由双方指定单一整合人；公共 Profile/Provider/session schema 不各建一套。

## 8. API 与 Backend 建议（未实现）

| 操作 | 拟议契约 | 结果 |
|---|---|---|
| 配置 Profile | POST /api/agent-profiles | 201 id/provider/config_version |
| 只读探测 | POST /api/agent-profiles/:id/probe | 200 detected/version/auth_state/capabilities |
| 明确真实探针 | POST /api/agent-profiles/:id/test-run | 202 probe_run_id，不伪装业务样本 |
| 执行/恢复 | Backend.execute 扩展 ExecOptions | messages、result、session_ref、cancel/kill |

请求示例：{"provider":"codex","executable":"codex","args":[],"sandbox":"workspace-write"}。响应：{"id":"profile-id","config_version":1,"auth_state":"not_checked"}。
错误示例：{"code":"provider_unavailable","message":"找不到 Codex 程序","retryable":false}。
400 配置非法、409 配置/会话归属冲突、422 能力不支持。人类端点当前仅本机；T05 统一远程鉴权。现有 daemon/task 权限和幂等保持，增量字段统一进入 Core。

## 9. 数据建议（未实现）

| 实体 | 字段 / 类型 | 约束 |
|---|---|---|
| AgentProfile | id/provider/executable:string；args:string[]；version:int；capabilities:object | 不含秘密，任务固定版本 |
| Task execution snapshot | profile_id:string；config_version:int；cli_version:string；config:object | 排队后不可暗改 |
| ProviderSession | session_ref/provider/runtime_id/task_id:string；repo_identity:object；work_dir:string | 跨 Provider/仓库拒绝恢复 |
| Runtime capabilities | stream/resume/cancel/structured_report:boolean；approval_mode/os:string[] | 调度使用真实能力 |
| BackendResult | status:enum；exit_code:int?；session_ref:string?；error:object? | 不是业务 done |

## 10. 交互与状态

选择 Codex → 配置路径/策略 → 探测 → 明确真实执行 → 任务日志/证据 → 反馈续作。
无 CLI、未知登录、版本不支持、权限阻塞、运行失败、无法恢复、缺报告都有独立提示。能力不支持的按钮不可用；用户无需查看 raw JSON 才能理解结果。

## 11. 集成依据

2026-10-08 本机帮助与 [Codex 官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)用于选型，具体支持版本由实施探针确定。
源码：[Backend](../../apps/runner/src/agents/backend.ts)、[executor](../../apps/runner/src/executor.ts)、[Core](../../packages/core/src/models.ts)。不读取/搬运 CLI 认证文件。
T01 可并行；联合 GitHub 闭环记录在 J01，不是本任务单独开发前置。

## 12. 异常与恢复

| 情形 | 行为 |
|---|---|
| 缺程序/版本错误/登录失败 | 明确原因，保留任务，不换 Provider |
| JSON 损坏/未知终态 | 有界诊断，无法确定时失败 |
| session 或仓库不匹配 | 拒绝恢复，显式选择新执行 |
| 批准无法完成 | blocked/error，不无限挂起 |
| Report 缺失/旧 SHA | 有界追问，耗尽仍未交付 |
| 验证失败/取消竞争 | 保留实测与一致终态，不无限修复 |
| complete 响应丢失 | 重放原载荷、遵循已有幂等 |

## 13. 测试与完成定义

执行 [T02 用例](../tests/tasks/T02-testcases.md)：fixture、真实子进程、Windows、会话串线、权限隔离、失败证据与 3 个真实 Codex Task。
至少一个含真实反馈续作；保存 CLI 版本、Task/session、base/head/Report/verification SHA、策略 hash、退出码。help、fake、旧 Kimi 记录不计。
登录或额度阻塞时记录“实现完成、真实验收未完成”，不能整体完成。独立审查、产品验收与合并分别记录。

## 14. AI 实施顺序与交接

先探测 JSONL/明确恢复/Report/取消，冻结 Core 和 Backend；再配置与调度匹配、adapter、最小 UI、兼容测试，最后真实任务。
不要为了接 CLI 重写 GitHub/调度或降低权限；公共改动先同步 T01。
在 [T02 交接](../handoffs/T02.md)记录认领、范围、已做/未做、命令、代码 SHA、真实证据和下一步。
待决策：最低 CLI 版本、Profile 存储、sandbox/审批策略、Report 通路；在对应实现前确定，不伪装成已支持。

## 15. 版本记录

| 版本 | 日期 | 变化 | 状态 |
|---|---|---|---|
| 1.0 | 2026-10-10 | 独立 Codex 执行器主题；T01 可并行，真实 GitHub 联调单独记录 | 初稿待评审、待认领 |
