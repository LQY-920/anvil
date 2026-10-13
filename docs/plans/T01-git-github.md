# T01 · Git/GitHub 技术设计与实施顺序

日期：2026-10-13（Asia/Shanghai）。状态：认领 PR #2 已合入，S1 代码/验证完成；S2–S5 尚未完成。负责人：LQY-920；实施工具：Codex。本文细化实现，不更改 PRD 的验收范围。代码起点为 `75dfde454f653376c3dac10224e44bc734ee75a0`。

依据：[PRD v1.0](../prds/T01-git-github.md)、[公共边界 v1.0.1](../prds/COMMON.md)、[交接](../handoffs/T01.md)、[12 条用例](../tests/tasks/T01-testcases.md)。准备基线：`3bfd8ba81a7824fbbfbedbb2c6413e3c8035b853`。PRD SHA-256：`B6A29223757A3F09BF901102CE0E1ED8D8F0A1E642479F7B562C7B62BB21C819`。

## 1. 交付目标与实施前置

完整目标：绑定仓库 → 导入指定 Issue → 既有执行器产出 Report/Verification → 审查固定 Diff → 人工裁决/PR → 核对远端事实并同步。纯本地 Git 同样执行准确的目标/证据检查。首版 PR 在 GitHub 手动合入，Anvil 不提供绕过保护的合入按钮。

先让认领文档进入共享 main，再建立代码分支并记录实际 SHA。文档申请与实现分开提交；不在当前认领分支混入产品代码。T02 可独立推进，Provider 私有输出不属于 T01。T03 等待 T01/T02 独立验收及 J01。

认领、代码事实核对、需求/设计审查与测试映射已共享。真实 GitHub 验收还需明确试验仓库和写入范围；准备/认领 PR 不计作 Anvil 产品真实闭环。

## 2. 已确认的代码边界

| 现状 | 依据 | 设计影响 |
|---|---|---|
| 页面 Diff 使用当前分支与 merge-base | [review.ts](../../apps/server/src/services/review.ts) | v2 改用 Task 持久化 base/head，缺事实明确失败；v1 单独兼容 |
| 旧 merge 只检查 completed，push 失败仍 done | [review.ts](../../apps/server/src/services/review.ts)、[旧测试](../../apps/server/test/review.test.ts) | 先改误完成，恢复须绑定操作事实；不能以回归全绿保留旧错误语义 |
| Task 有 Git 锚点，无不可变 repository_id/仓库身份快照；Issue repo_path 可变 | [schema.ts](../../apps/server/src/db/schema.ts)、[models.ts](../../packages/core/src/models.ts) | 当前 checkout 与 worktree 相同只证明现场一致；完整身份绑定需增量契约/迁移 |
| Runner 有精确 common-dir 身份校验；Server 没有共用实现 | [worktree.ts](../../apps/runner/src/worktree.ts)、[git.ts](../../apps/server/src/lib/git.ts) | 提取时保持 bigint 文件标识、大小写和弱身份退化规则；不让 Server import Runner 包 |
| Report/Verification 和完成 Packet 已有；没有 Decision/Attempt | [delivery.ts](../../apps/server/src/services/delivery.ts)、[schema.ts](../../apps/server/src/db/schema.ts) | 复用原始证据；实时 Gate 和人类裁决另存，不改历史 Verification |

## 3. 实现默认方案与尚待冻结项

- GitHub 通路采用 Server 封装本机 `gh api`，CLI 参数数组、不拼 shell 字符串；固定允许的 host/endpoint/method，显式 HTTP method、显式仓库身份。凭据继续由本机 gh 管理，不读取/导出 token，不传给 Agent。`gh api` 会因字段参数改变默认 method，因此封装必须显式指定方法。[官方 CLI 依据](https://cli.github.com/manual/gh_api)
- 首版使用出站同步和手动刷新。设计默认每仓库串行请求、正常轮询 60 秒、手动刷新最短间隔 10 秒；支持条件请求，遵循 Retry-After/限流重置时间，网络故障按有界退避恢复。具体常量在 S4 测试中冻结。[GitHub REST 建议](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- Repository 的权威身份是 host + external repo ID；路径、full_name、clone URL 是可变化的定位信息。local_git 保存本机仓库身份。新 Task 固定 repository 引用、模式、目标分支和来源版本；运行中修改 Issue 不改该次任务。
- 历史任务不批量伪造身份或 v2 证据。旧 URL 不凭字符串自动判定 github_pr；明确绑定为 github_pr 后，关联仓库的旧 v1/v2 /merge 都必须被拒绝。未绑定旧任务的写入过渡行为在 S2 冻结，默认不给未知身份开放新的 GitHub 写入口。
- 一个 Task 一条不可变权威 Decision；操作可有多个 Attempt。新 HEAD 使旧批准不能再用于操作，但不删除/改写旧 Decision；返工创建新 Task。批准、验证通过、远端合入分别展示。
- base_advanced 是完整性阻塞，不能通过质量覆盖绕过，也不改写旧验证。显式新执行重新准备；不能从浮动目标重新猜 saved base。
- 质量覆盖只处理 failed/partial/not_configured，要求理由、二次确认及审计。缺 Report、dirty、SHA/仓库/目标错配一律不可覆盖。
- PR 响应丢失先查询关联的仓库、head/base 和本地操作标识；存在多候选时明确冲突，不猜测、不重复创建。记录 GitHub 返回的 PR ID/URL；外部关闭 Issue 不证明本地完成。[PR API 依据](https://docs.github.com/en/rest/pulls/pulls)

公共字段草案由 T01 主会话统一整理；T02 尚未认领，不能把本提案写成双方已确认。S1 尽量使用现有协议，新增 DTO 字段先兼容扩展；S2 涉及 Core/executor/迁移的补丁独立审查并共享。

## 4. 分段实现与验收

| 阶段 | 可观察交付 | 主要文件边界 | 对应测试及完成限制 |
|---|---|---|---|
| S0 认领与设计 | 认领进入共享基线；范围、版本、责任和下一步可追溯 | TASKS、交接、本设计 | 文档链接/hash/diff、自审与独立设计审查；不计产品验收 |
| S1 Git 现有链路纠错 | v2 Diff 固定；push 失败不 done；持久化操作意图，重复请求不再次 merge | server review/Git、Core DTO、最小操作表/迁移、审查用例；必要的最小 Web 文案 | TC04、TC09 部分及 v1 回归；未实现完整仓库身份/Gate/PR，不宣称 T01 完成 |
| S2 身份与公共契约 | Repository、Task 不可变快照、连接状态、迁移与旧入口分类 | Core、schema/迁移、repository 服务、Runner 准备/claim/executor 最小增量 | TC01、TC02、TC07；真实旧库迁移夹具，无运行库修改；T02 接口同步 |
| S3 实时 Gate 与本地裁决 | 证据和 Git 实时核对、Decision/Attempt、质量覆盖、纯本地安全合入 | review gate、Git 锁、decision/attempt 服务、最小审查 UI | TC05、TC06、TC08；并发/崩溃/响应丢失、两次核对、权限边界 |
| S4 GitHub 闭环 | 指定 Issue 导入、来源快照、PR 创建/关联、查询恢复、同步 | gh connector、来源/PR/operation 服务、轮询与配置/状态 UI | TC03、TC09、TC10、TC11；替身错误矩阵、无权限/限流/网络失败；保留计时 |
| S5 独立验收 | 授权测试仓库上真实 Issue → 任务证据 → PR → 人工合入 → 同步 | 测试记录、交接、指南 | TC12 与全部 FR；独立代码审查、产品验收、全量门槛；J01 另行执行 |

各段以最小可回归改动提交，不一次重写调度或整个任务面板。S1 的部分覆盖不能把 TC09 整条记为通过。每段结束同步交接、TASKS 和实际用例记录。

## 5. S1 的具体实施边界

### 固定 Diff

1. v1 保留历史 Diff 路径并在响应中明确兼容语义；不补造 v2 base/head。版本按 Task.delivery_contract_version 分流；旧 branch-only 测试显式设为 v1，不让坏 v2 夹具走 legacy。
2. v2 读取 Task 的完整 base_commit/head_commit/task_branch/target_branch，不以 result_json.branch 或仓库当前 HEAD 替换；完成证据缺失、非法 SHA、对象不存在返回可识别错误，不回退浮动 Diff。
3. Git 使用固定参数和 `--` 分隔 revision/path，禁用外部 diff/textconv；限制输出大小并保留截断标记，避免仓库配置触发额外执行。
4. 可用 worktree 和当前 checkout 做 common-dir 一致性核对，但若缺现场或无法确认仓库则明确阻塞；没有持久化历史身份前，不声称检测了两者同时被替换的情形。S2 补齐不可变身份后重新覆盖该边界。
5. GET Diff 不改变验证、裁决、分支或任务状态。Task 分支后来推进仍返回保存的 SHA Diff；缺对象返回错误。是否允许合入由后续实时 Gate 判断。
6. 响应兼容新增 delivery_contract_version、base_commit、head_commit；原 base 继续表示目标分支名，避免改变 Web 合入文案。错误区分任务/对象不存在与锚点/身份冲突，不再全部压成含糊的 404。

### push 失败与恢复

1. 删除 push 失败路径的误 done；保留 Issue、worktree、分支及原始证据，返回机器错误与清楚文案。
2. S1 分为 S1a 固定 Diff、S1b 失败状态与最小持久操作记录两个提交。S1b 在 Git 副作用前原子写入操作意图，固定 task/head、当次 checkout 身份、目标 ref/操作前 SHA、请求 hash；实际 merge 使用该固定 head SHA，执行前重检目标 ref/操作前 SHA，变化则阻塞，不能仍合入浮动分支名。成功本地合入后记录 merge SHA。按 task_id 原子守卫活动/待恢复操作，并发重复请求读取原记录，不执行第二次 merge。
3. S1b 先采用保守恢复：已有未确认/失败记录时普通 /merge 返回 recovery_required，换新的请求键也不能绕过 task_id 守卫；UI 提示本地结果和保留现场，Server 重启也不绕过。Git 成功、数据库尚未记录时的崩溃记为结果未知，不擅自重试。此段不提供自动重推，不把错误分支当已回滚，也不把当前现场身份称为原始任务绑定。
4. 最小操作表沿用后续 IntegrationAttempt 的演进方向；历史兼容操作可没有 Decision，不伪造人类批准，不写入 daemon complete 回执或覆写原始证据。S3 为新流程关联 Decision，S3/S4 补查询与恢复能力；unknown 先查询远端实际结果，不重复运行 Agent，不强推，不自动回退已发生的本地合入。

### 首段回归场景

- v2 任务分支与目标分支各自推进后，页面仍使用保存的 base/head；已 commit 的改动不会变成空 Diff。
- 缺/非法锚点、对象丢失、工作树不匹配明确失败；v1 仍按历史路径可读。
- push 拒绝或响应未知不会 done/清现场，二次请求不会合入新 HEAD；原合入成功/冲突、空 JSON body、计时失败排除语义继续有效。
- 明确首段尚未实现的身份替换、完整 Gate、Decision 与 GitHub PR，用例保持未完成或部分覆盖。

2026-10-13 实施调整：成功后保留任务分支/worktree，保证历史 Diff 仍可读取且不误删后来的修改；S1 暂无清理按钮。独立审查指出 porcelain 为空不代表没有未结束的 Git 操作，且无条件 abort 可能撤销用户现场，因此增加操作标记检查，冲突改为保留现场并要求核对，不自动 abort。S1 不提供自动恢复，也不把持久仓库守卫宣称为已接通 Runner 的临界锁。错误 HTTP 与持久记录使用同一个脱敏函数；Git 禁用 replacement objects，避免完整 SHA 被 refs/replace 改变内容语义。

## 6. 后续契约的最低约束

- Repository/SourceSnapshot：同 host+repo ID 唯一；导入按外部 Issue ID 幂等，不自动派发。Task 固定接受的来源版本，上游变化提示差异。
- Gate：Decision 提交前及实际操作持锁后分别核对 Task、branch、HEAD、Report、Verification、clean、base/target 和仓库身份。临界锁按 common-dir 跨 Server/Runner 进程协调；不跨 Agent 执行或人类等待持锁。先做崩溃/过期锁测试，不以进程内 Promise 当跨进程锁。
- 外部操作：本地幂等键和规范载荷 hash 先持久化，重复请求返回同一结果，不同载荷冲突；Git/HTTP 不伪装成与 SQLite 一个事务，恢复靠可查询的操作状态。
- 推送归属：现有 Runner 会对 URL 任务自动推任务分支。启用 github_pr 时须将该动作纳入平台 Git/操作记录统一控制，避免 Runner 和 Server 各推一次；Adapter 不拥有 GitHub 连接凭据。该执行上下文增量在 S2 与 T02 同步。
- 远端合入：仅接受所选权威 PR；核对最后批准 head、实际目标、merged、merge commit 及目标可达事实，兼容 squash/rebase。关闭未合入、新 head 未复审、结果未知均不完成。
- UI：沿用现有主题和任务面板；分别展示 Runner 检查、GitHub checks、人类决定和 PR 结果；打开 PR 仅保存计时草稿，不产生有效裁决。
- 迁移：先在旧 schema 夹具验证新增表/字段、外键/唯一约束和重复 migrate；记录备份恢复步骤。旧 v1、测量有效性和原报告不可被回填成新证据。

## 7. 验证与审查记录

准备阶段历史：2026-10-13 较早的状态核验发现 Server 全量一条 5 秒超时、单文件 11/11 通过；Core/Web/补测 Runner、build、四包 noEmit 通过。此为准备基线事实，不是 T01 产品用例结果；后续成功不覆盖历史失败记录。

S1 代码 `bee982a`：专项及独立静态审查后，串行执行全量 46 文件/903 用例、build、四包 noEmit 全部通过。没有修改旧用例的 5 秒超时；新增多步真实 Git 场景明确 15 秒上限。完整运行记录、首轮错误和修复见 [T01 用例](../tests/tasks/T01-testcases.md)。S1 没有完成 Repository/Decision/PR/同步或真实外部验收。

代码阶段依次运行相关专项、`pnpm test`、`pnpm build`、四包 `pnpm exec tsc --noEmit -p tsconfig.json`，不得叠加执行。真实 Git 使用临时仓库；真实 GitHub 使用另行明确授权的测试仓库。用例须记录 SHA、环境、命令、日期和结果。

主会话自审与只读 Agent 的需求/设计/代码审查分开记录；设计或代码审查不是 GitHub 人类审批或产品验收。S1 仅有部分子场景通过；远端操作为认领 PR，不属于产品验收；迁移只在临时库测试，未迁移运行库。

| 日期 / 审查者 | 范围与结论 | 本轮处理 |
|---|---|---|
| 2026-10-13 主 Codex | 自审 PRD、数据结构、路由、官方 gh/REST 文档及认领边界 | 保持 v1.0/hash；方案分阶段，认领先共享 |
| 2026-10-13 plan_readiness，只读 Agent | 独立需求/设计审查；固定 Diff 与实时 Gate 分开，旧 URL 不猜模式，Decision 不可改写，新 HEAD 使批准失效 | 纳入第 3–6 节；双线契约仍待同步 |
| 2026-10-13 implementation_audit，只读 Agent | 独立源码边界审查；缺不可变身份，push 失败后重复 merge，branch-only v2 测试夹具不适合作 legacy | S1b 采用持久意图与恢复阻塞；S2 补身份；扩展响应而不改变 base 语义 |

定稿复核：plan_readiness 对四份认领/设计/用例文档给出通过结论；implementation_audit 要求补清 task_id 级恢复守卫和实际 merge 的固定 SHA，两项已纳入 S1b。主会话核对修订与意见一致；没有将文档审查记为产品代码通过。
