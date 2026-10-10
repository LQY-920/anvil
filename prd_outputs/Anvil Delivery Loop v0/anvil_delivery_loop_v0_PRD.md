---
stylesheet:
  - prd_outputs/Anvil Delivery Loop v0/prd.css
body_class:
  - prd-document
document_title: Anvil 交付证据与反馈闭环 v0 PRD
pdf_options:
  format: A4
  margin:
    top: 22mm
    right: 16mm
    bottom: 19mm
    left: 16mm
  printBackground: true
  displayHeaderFooter: true
  headerTemplate: |-
    <style>section { width: 100%; padding: 0 16mm; box-sizing: border-box; color: #71717a; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 7.5pt; }</style>
    <section>Anvil · 交付证据与反馈闭环 v0</section>
  footerTemplate: |-
    <style>section { width: 100%; padding: 0 16mm; box-sizing: border-box; color: #71717a; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 7.5pt; text-align: right; }</style>
    <section><span class="pageNumber"></span> / <span class="totalPages"></span></section>
---

# Anvil 交付证据与反馈闭环 v0 — Product Requirements Document

**Version:** 1.0  
**Date:** 2026-08-28  
**Author:** Codex / PRD Generator  
**Status:** Final for implementation planning

## 2. Executive Summary

Anvil 交付证据与反馈闭环 v0 面向技术型一人公司经营者，把一次 Agent 编码执行转换为有版本锚点、有独立验证证据、可安全裁决的人类决策。本迭代不建设完整 Software Factory，而是补齐 Anvil 当前“Issue → Task → 日志 → Diff → 合入”链路中最关键的可信交付层。Runner 负责固化 Git 事实并执行仓库定义的验证命令，Agent 负责提交问题理解、变更摘要、风险与未知项，人类只在合入前完成一次正式裁决。预期结果是在质量门槛不下降的前提下，显著减少用户阅读原始日志和拼装上下文所消耗的高判断时间，并让返工原因成为可追溯、可积累的系统输入。

## 3. Problem Statement

### Current state

Anvil 当前已经完成编码任务调度闭环：用户创建 Issue 并指派 Agent，Runner 在独立 Git worktree 中执行 Kimi Code CLI，Server 持久化消息流，任务完成后用户查看 Diff 并选择合入或打回。现有产品将成功定义为“派活—监工—验收”，UI 的主要信息仍是任务状态、原始执行轨迹和 Diff。

当前模型中，Issue 是持久目标，Task 是一次执行尝试，这一点与 Multica 对 Issue/Task 的区分一致；Task 完成不代表 Issue 已完成。[Multica Tasks](https://multica.ai/docs/tasks) 但当前 Anvil 还没有把“Agent 自述”“Git 事实”“Runner 实测”“人类决定”分开建模，导致用户必须自行从日志和代码差异中判断交付是否可信。

### Pain points

1. **完成不等于可信。** `Task.status=completed` 只说明 CLI 进程正常结束；现有合入只校验 completed 与分支存在，没有检查任务是否已交付、验证是否实际执行、分支是否在验证后变化。
2. **Diff 缺少不可变版本锚点。** 当前服务端按验收时的仓库当前分支动态计算 merge-base；目标分支前进、切换或任务分支被改写后，用户看到的内容可能不是 Agent 完成与验证时的内容。
3. **验证依赖 Agent 自述。** `ANVIL.md` 能告诉 Agent 应运行哪些命令，但平台没有机器可读的强制验证策略，也没有由 Runner 实际执行并记录退出码、耗时和输出摘要。
4. **人类判断材料分散。** Issue 描述、验收标准、Agent 说明、测试过程、风险、Diff 和评论分布在不同区域；用户需要持续监工或重新拼装上下文。
5. **打回反馈无法沉淀。** 当前反馈以普通评论进入下一次 Prompt，无法区分仅本次澄清、项目规则候选、自动化测试候选和人工接管，也无法衡量重复纠正。
6. **裁决结果与 Git 结果混在一起。** 用户点击“合入”不代表合入、远程推送和 Issue 关闭都成功；远程推送失败、分支过期或工作区不干净需要成为独立、可追溯状态。

### Impact

- 用户仍然扮演“逐步监工者”，而不是负责目标、边界与品味的 Loop Owner。
- Agent 并发增加时，Review 队列和认知负担会同步放大，吞吐最终受限于人的逐日志、逐 Diff 检查。
- 一次返工只修当前实例，没有形成可分析的失败模式，系统不会因人类介入而逐步减少相同介入。
- 错误显示“验证通过”、使用过期证据合入或远程未推送却关闭 Issue，会直接损害用户对自治执行的信任。

### Product hypothesis

[《The Transposed Organization》](https://blog.sshh.io/p/the-transposed-organization) 将 Loop 描述为由同一人拥有、从问题到已部署结果的完整决策链，人的主要产出是判断而不是工件；[《Designing Software for Software Factories》](https://blog.sshh.io/p/designing-software-for-software-factories) 则强调自治系统最终应掌握完整测试循环、人类应审查经过整理的重点而非原始产物，并把反馈转化为系统性改进。

本 PRD 把这两篇文章视为设计假说而非已验证的产品结论。当前迭代只验证其中与 Anvil 现状最贴近的一段：

> 把一次 Agent 编码执行转换成有来源、有版本、有 Runner 独立终检的人类决策，并为未来“验证失败自动回到 Agent 修复”的自治测试循环建立可信地基。

### Scope boundary

本迭代的闭环终点是“已验证并成功合入目标分支”，不是“已部署到生产并回到客户来源”。Issue 继续表示一次具体问题，Task 继续表示一次 Agent 执行尝试；不引入通用 Loop、Node、Edge 或 DAG 数据模型。

### Non-goals

- 不宣称实现文章定义的完整 Software Factory。
- 不接入客服系统、GitHub Issues、邮件、Webhook 或其他外部问题来源。
- 不包含部署、生产监控、线上回滚、业务指标验证或客户通知。
- 不做通用 Loop/DAG Builder、自定义阶段或条件编排。
- 不做 Squads、固定专业角色 Agent、Agent 组织图或多 Provider。
- 不新增逐阶段人工审批；正式人工门槛仍只有合入前一次。
- v0 不在 Runner 终检失败后自动 resume Agent 修复；只建立可信终检、结构化返工与人工逃生通道。
- v0 不自动 rebase、合并最新目标分支或重新验证；并发执行不等于并发闭环，先完成的合入可能使其他 Packet 进入 base_advanced。
- 不做自动合入、自动部署或自动应用规则。
- 不自动修改 `ANVIL.md`、测试、Skills、Prompt 或源码。
- 不建设通用 Skills 市场、向量记忆或模型训练系统。
- 不重做看板、导航和整体视觉设计。
- 不包含 Diff 行级评论、Cmd/Ctrl+K、快速创建或 Autopilot cron。
- 不修改 Issue 创建表单或新增来源字段；未经拆解的问题继续使用现有 title/description/acceptance。
- 不提供验证命令沙箱；Runner 终检仅对用户明确信任的仓库启用。
- 不支持多用户、云执行或新的远程权限体系。

## 4. Goals & Success Metrics

P0-B 决策页替换现有验收界面前，先在现有界面前瞻采集 10 个真实任务的主动验收基线；不能用缺少 `active_review_ms` 与 `opened_transcript` 的历史 Task 反推基线。新决策页启用后再运行至少 10 个真实 v2 dogfood 任务。第一阶段先证明事实采集可信，第二阶段才判断认知成本是否下降。

| Goal | Metric | Target | Measurement Method |
|---|---|---:|---|
| 决策包可用 | 决策包完整率 | 首批 10 个 v2 有分支任务 ≥ 90% | completed Task 中同时具备版本锚点、Runner 终检、Agent 摘要、风险与未知项的比例 |
| 证据可信 | 错误显示通过、过期证据允许普通合入 | 0 次 | Server Gate 集成测试 + dogfood 审计 |
| 降低认知负担 | 无需打开原始 Transcript 即可裁决的任务比例 | ≥ 80% | Review Decision 携带 `opened_transcript` |
| 缩短主动验收 | 中位 active_review_ms 相对前瞻基线 | 降低 ≥ 30% | 同一 Review Timer 先采 10 个旧 UI 样本，再采 10 个新 UI 样本 |
| 反馈可追溯 | 返工/接管决定的分类、理由、来源 Task 完整率 | 100% | Review Decision 数据审计 |
| 保留逃生通道 | 无验证配置或验证非全绿时的人工接管/有理由覆盖路径 | 100% 可用 | E2E 反向用例 |
| 建立工厂指标基线 | cycle time、revision、off-ramp、override 采集覆盖率 | 100% v2 Task | Metrics API 与 DB 聚合 |
| 质量不下降 | required gate pass、错误通过、合入后 7 日内因本任务产生的修正/回滚 | required pass 100%；错误通过 0；修正/回滚不高于基线 | Verification、Decision、关联 correction Issue 与人工 dogfood 审计 |
| 本地交互性能 | Review Packet API p95 | < 500ms | 本地 SQLite、1,000 条消息、8 个当前检查与 20 条历史 Integration Attempt 压测 |
| 页面性能 | 决策页可交互时间 p95 | < 1.5s | 本地生产构建、Diff 与 Transcript 懒加载 |

### North-star metric

> 在质量门槛不下降的前提下，每个成功合入所消耗的人类高判断时间。

### Guardrail metrics

- 必选验证失败却显示 passed：0。
- `base_commit`、任务分支 HEAD 或 `verification_sha` 不一致仍允许普通合入：0。
- 未经明确批准修改规则、测试或项目文件：0。
- URL 仓库远程推送失败却把 Issue 标为 done：0。
- 新功能导致 active review time 相对基线上升超过 20%：No-go。
- base_advanced 发生率必须被采集；v0 不把并发阻塞包装成已解决的工厂吞吐能力。

## 5. User Personas

#### 技术型一人公司 Loop Owner

- **Role:** 产品负责人、开发负责人和最终发布责任人由同一人承担。
- **Goals:** 用自然语言交代问题后离开；回来时快速判断结果是否正确、风险是否可接受，并安全合入或明确打回。
- **Pain points:** 不信任 Agent 的“已完成”自述；需要阅读大量日志；多任务并发后验收队列成为瓶颈；同类反馈反复出现。
- **Technical proficiency:** High。
- **Usage context:** Windows 桌面、本地自托管、单用户；浏览器常开但不应要求持续盯屏；目标仓库可能是本地路径或 Git URL。

## 6. Functional Requirements

本 PRD 共 8 项功能：P0 3 项（37.5%）、P1 3 项（37.5%）、P2 2 项（25%）。P0 构成发布门槛；P1 属于同一主题的增强项，只有在 P0 无完整性问题时继续；P2 仅记录验证后的后续方向，当前迭代未授权实施。

#### FR-001: 不可变 Git 锚点与 Runner 强制验证

**Description:** Runner 在 Agent 完成后、Task complete 前，基于任务开始时固化的 Git 基线执行机器可读验证策略，并持久化独立于 Agent 自述的证据。

**User story:** As a Loop Owner, I want the platform to prove exactly which code was verified so that I do not approve stale or self-reported results.

**Acceptance criteria:**

- [ ] Git 锚点、Runner 验证、complete 和 fail 只允许使用未下放给 Agent 的 daemon token；Server 校验 body.daemon_id 与 Task.claim 时绑定的 runtime/daemon 一致。
- [ ] Delivery Report、消息和 blocked 回调继续使用 task token；Agent 无法调用 Runner 事实或 complete/fail 写路径。
- [ ] 新建 v2 Task 在首次创建 worktree 时记录 `target_branch` 与完整 40 位 `base_commit`；resume 和自动重试继承原始基线，不以返工开始时的新 HEAD 替换。
- [ ] Runner 在 Agent 及最多两轮交付追问结束后读取 `head_commit`、`git status --porcelain`，且只在工作树干净时执行验证。
- [ ] 仓库根 `ANVIL.verify.json` 是唯一强制验证命令来源；Runner 从 `base_commit` 对应版本读取并计算 SHA-256 `policy_hash`，任务分支修改该文件不改变本次策略。
- [ ] 策略最多 8 条命令；每条包含唯一 id、中文 label、command、required、timeout_ms；timeout 范围为 1,000–1,800,000ms。
- [ ] Windows 使用 `%SystemRoot%/System32/cmd.exe /d /s /c`，POSIX 使用 `/bin/sh -lc`；cwd 固定为 worktree；timeout 使用现有进程树终止能力。
- [ ] Runner 串行执行命令，按 UTF-8（非法字节替换）记录开始/结束时间、退出码、耗时和脱敏后的 stdout/stderr 摘要；单条摘要上限 8KB，总验证载荷上限 64KB。
- [ ] 验证子进程环境继承普通 Runner 环境，但显式剔除 daemon token、task token、所有 `ANVIL_*TOKEN` 与已知 secret 值；PRD 明示这不是本机凭据沙箱。
- [ ] 任一 required 命令退出码非 0 或超时，状态为 failed；没有策略文件为 not_configured；全部 required 通过且验证前后 HEAD 相同、工作树干净才为 passed。
- [ ] 验证结束后再次读取 `verification_sha` 与工作树状态；HEAD 变化或出现未提交/未跟踪文件时状态为 stale 或 dirty，不能显示 passed。
- [ ] Agent 自己在日志或交付说明中声称“测试通过”不得改变 Runner 验证状态。
- [ ] daemon start/complete 采用“同 Task、同 operation、同 payload_hash 返回原响应；同 operation 不同 payload 返回 409”的幂等语义，响应丢失后不依赖已清除的 task token 重试。
- [ ] 迁移前 v1 Task 保持可查看；其验证状态明确显示 legacy，不伪造 passed。

**Priority:** P0 (MVP)

**Dependencies:** 现有 worktree、Git helper、Runner complete、Task token 脱敏。

#### FR-002: 结构化 Agent 交付报告与决策包

**Description:** Agent 提交结构化判断材料，Server 将其与 Runner 验证、Git 事实和现有 Diff 汇总成版本化 Review Packet。

**User story:** As a Loop Owner, I want one page to distinguish Agent judgment from platform evidence so that I can review the right information in the right order.

**Acceptance criteria:**

- [ ] v2 Agent 在 Task active 期间通过任务级 token 幂等提交一份 `schema_version=1` 的 Delivery Report，并携带提交时的 `report_head_commit`。
- [ ] Delivery Report 必须包含 problem_understanding、solution_summary；changed_areas 最多 50 项；risks、unresolved 各最多 20 项；整个请求体不超过 64KB。
- [ ] Agent Report 在 UI 明确标注为“Agent 判断”，不得与“平台采集”或“Runner 验证”混用。
- [ ] Server 递归脱敏当前 task token，限制字符串长度，并拒绝未知 schema、重复 changed-area path、非法风险等级及超限载荷。
- [ ] Runner 在每轮 Agent 结束后比较 `report_head_commit` 与当前 HEAD；缺 Report 或 SHA 不同均可触发同一会话追问，最多 2 轮；每轮后重新读取 HEAD。
- [ ] 最终仍缺 Report，或 `report_head_commit`、`head_commit`、`verification_sha` 三者未全部相等时，Task 可 completed 但 Packet 为 incomplete/stale，Issue 不进入普通可批准状态。
- [ ] `GET /api/tasks/:id/review-packet` 聚合：原始问题、期望结果、Agent 报告、Git 锚点、Runner 验证、决策资格、既有 Decision 摘要。
- [ ] Review Packet 不内嵌完整 Diff 或 Transcript；Diff 继续走现有接口并懒加载，Transcript 默认折叠。
- [ ] Packet 状态统一为 generating、ready、incomplete、verification_blocked、integrity_blocked、legacy、decision_recorded、integration_failed、remote_push_pending、closed。
- [ ] Packet 缺失、获取失败或过期时必须显示明确原因和恢复动作，不能像当前 Diff 404 一样静默隐藏交付区。
- [ ] Review Packet 必须绑定具体 Task；返工后的每个新 Task 生成自己的 Packet，不覆盖前序记录。
- [ ] Packet 返回轻量 `activity[]`，每项包含 id、type、actor_type、actor_id、task_id、occurred_at、source_order、summary；按 occurred_at/source_order/id 稳定排序。
- [ ] v1 Task 的 Packet 请求返回 `200 + status=legacy`；继续提供现有 Diff、合入、打回和日志能力，但明确不计入 v2 可信证据指标。

**Priority:** P0 (MVP)

**Dependencies:** FR-001、现有 Issue/Task/Diff/消息接口、现有 delivered_at 语义。

#### FR-003: 可信决策、受控合入与结果恢复

**Description:** 将现有独立 Task 页面升级为决策详情页，把一次不可变的人类 Decision 与可重试的 Git Integration Attempts 分开记录。

**User story:** As a Loop Owner, I want to approve one verified artifact with one deliberate decision so that I do not become a permanent process monitor.

**Acceptance criteria:**

- [ ] `/tasks/:id` 按以下顺序展示：原始问题与期望结果 → Agent 交付摘要 → Runner 验证 → 风险与未知项 → Git 变更摘要 → 人工裁决 → 折叠的执行轨迹 → 活动时间线。
- [ ] Issue 的 description 与 acceptance 在决策页可见；没有 acceptance 时显示“未提供人工验收标准”，不能伪造为空白成功。
- [ ] 普通“接受并合入”仅在 Task 为该 Issue 最新可交付版本、Delivery Report 完整、verification=passed、工作树干净、任务分支 HEAD=`verification_sha` 时启用。
- [ ] 合入前 Server 实时重新读取任务分支 HEAD、目标分支当前 HEAD 和工作区状态；完整性条件变化时返回机器码并把 Packet 标为 stale。
- [ ] 目标分支从 `base_commit` 前进时，普通合入被阻止；v0 不自动 rebase/merge-main/reverify。
- [ ] 质量类阻塞（not_configured、failed、partial）只允许使用“覆盖验证并合入”，必须填写不少于 10 个字符的 override_reason 并二次确认；该行为计为 off-ramp。
- [ ] 完整性类阻塞（branch moved、dirty、base advanced、wrong target branch）不可在 UI 覆盖，只能返工或人工接管。
- [ ] Issue.done 只由成功的人类批准合入产生；v2 Agent 不能直接把 Issue 写成 done。
- [ ] v2 Task 调用旧 `issue-status=done` 或 `in_review` 返回稳定机器码；blocked 保留为兼容逃生路径。v1 行为保持。
- [ ] 每个 Task 最多一条权威 Review Decision，类型为 approve、approve_override、changes_requested、manual_takeover；Decision 追加写且不可被 Git 结果覆盖。
- [ ] 每次 Decision 请求携带唯一 client_request_id；同键同载荷返回原结果，同键不同载荷 409。
- [ ] changes_requested 必须包含 feedback、feedback_scope 与 restart_mode=resume|fresh_base；fresh_base 创建不复用 prior_work_dir 的新 Task，并从当前目标分支记录新 base。
- [ ] 同 Issue 已有 queued/dispatched Task 时，反馈合并进 pending Task；已有更新 running/completed Task 时旧 Packet 返回 stale_task，不注入错误执行。
- [ ] manual_takeover 要求不少于 10 个字符的原因，Issue → in_progress、assignee → 当前 member，不创建 Agent Task。
- [ ] Review Decision 同时保存 review_started_at、active_review_ms、opened_transcript、opened_full_diff，供 P0 前瞻基线和后续指标使用。
- [ ] approve/approve_override 产生一个或多个追加写 Integration Attempt；merge、remote push 和 retry push 的结果不修改 Decision 本体。
- [ ] URL 仓库只有远程目标分支 push 成功后才标 done；本地已合入但远程 push 失败时记录 local_merged_remote_failed、保持 in_review，并提供安全重试。
- [ ] 合入冲突必须执行 merge --abort；Integration Attempt 记录 merge_conflict，Issue 不得 done。
- [ ] retry-push 使用独立 API 与幂等键；重试前验证本地 target 仍等于已记录 merge_commit，URL 仓库先 fetch，成功后才关闭 Issue。
- [ ] URL 仓库 Gate 前执行 `git fetch` 并比较远端 target ref；每个 repo 的 merge/push/fetch 使用互斥锁。
- [ ] 决策页 p95 可交互时间 <1.5s；完整 Diff 和 Transcript 不阻塞首屏。
- [ ] 决策页首屏不调用 messages/diff API；用户首次展开才请求，折叠后再次展开不重复请求。Drawer running 模式继续增量拉消息。
- [ ] queued/dispatched/running 页面保留取消和“评论即指令”；正式 changes_requested 不再额外调用普通评论+rereun 两套路径。
- [ ] 浅色/深色、键盘焦点、状态“图标+文字”与现有语义 token 规则保持一致。

**Priority:** P0 (MVP)

**Dependencies:** FR-001、FR-002、现有 `mergeTaskBranch` 与 `TaskPanel`。

#### FR-004: 反馈范围与改进候选记录

**Description:** 用户可以把一次返工反馈标记为仅本次、项目规则候选或自动化测试候选，但系统不自动修改项目。

**User story:** As a Loop Owner, I want reusable corrections to be remembered without allowing the system to rewrite its own rules autonomously.

**Acceptance criteria:**

- [ ] feedback_scope 仅允许 one_time、project_rule、automated_test。
- [ ] project_rule 或 automated_test 只在用户明确选择时创建 Improvement Candidate，并关联 Issue、Task 与 Review Decision。
- [ ] Candidate 默认状态为 proposed，展示原始反馈、来源、创建时间与建议目标；不得自动改写 `ANVIL.md`、`ANVIL.verify.json`、测试或源码。
- [ ] 同一 Decision 的同一 kind 最多创建一个 Candidate，重复请求幂等。
- [ ] UI 明确说明“这是候选，不会自动应用”。
- [ ] P1 只在来源 Decision 页面展示 Candidate 记录，不建设候选列表、详情页或 accepted 工作流。

**Priority:** P1 (Important)

**Dependencies:** FR-003、现有 Issue 创建服务与评论时间线。

#### FR-005: 闭环指标聚合与比较

**Description:** 记录每个 v2 Task 的周期、主动验收时间、Transcript/Diff 打开情况、返工、覆盖合入和人工接管。

**User story:** As a product owner, I want evidence that the new workflow lowers judgment cost rather than merely making the UI look more sophisticated.

**Acceptance criteria:**

- [ ] active_review_ms 由独立 `useReviewTimer` 采集：页面不可见、窗口失焦或连续 60 秒无交互时暂停；恢复后继续累计；刷新和失败重试不产生负数或重复时间。
- [ ] Metrics API 输出 task_count、packet_complete_rate、cycle_time_p50、active_review_ms_p50、decision_without_transcript_rate、revision_rate、off_ramp_rate、override_rate。
- [ ] 时间窗口支持 7d、30d、all；少于 5 条样本时返回 sample_warning，不展示趋势结论。
- [ ] cycle time 定义为 Issue.created_at 到成功 merge/push 的墙钟时间；active review time 与等待时间分开。
- [ ] approve_override 与 manual_takeover 均计入 off-ramp；changes_requested 计入 revision。
- [ ] v1 基线必须由同一 Review Timer 前瞻采集 10 条，不允许人工回填不存在的历史页面事件；v1 与 v2 分组展示。
- [ ] 所有指标均可从持久化事实重算，不依赖仅存在浏览器内存的计数。
- [ ] 额外输出 base_advanced_rate 与 post_merge_correction_rate；少样本时不声称质量改善。

**Priority:** P1 (Important)

**Dependencies:** FR-003、Review Decision 数据模型。

#### FR-006: 统一决策深链接与通知语义

**Description:** 所有需要人判断的通知都进入独立决策页，侧栏只保留快速摘要。

**User story:** As a Loop Owner, I want a notification to take me directly to the decision context so that I do not search through the board.

**Acceptance criteria:**

- [ ] 待验收通知点击后进入 `/tasks/:id`，而不是仅打开 `/?task=id` 侧栏。
- [ ] Board 侧栏在 ready/incomplete/failed/stale 状态展示 Packet 摘要与“打开完整决策页”；不在 420–640px 侧栏塞入复杂完整布局。
- [ ] Server 新增 `review.updated` WS 事件，至少携带 task_id、packet_status、action_required、occurred_at；App 级 notifier 只挂载一次。
- [ ] Server 新增 action-required 查询；App 启动和 WS 重连后补拉，Board 不再维护第二套重复轮询。
- [ ] v0 不引入 unread 数据模型；标题圆点和卡片角标直接来源于服务端可重建的 action_required，打开页面不改变它，产生终态 Decision 才清除。
- [ ] `useServerEvents` 暴露 connected/reconnected 状态；断线时显示“数据可能不是最新”，重连后补拉 action-required 与当前 Packet。
- [ ] 不新增独立通知中心或移动端通知。

**Priority:** P1 (Important)

**Dependencies:** FR-002、FR-003、现有通知和 React Router。

#### FR-007: 改进候选管理

**Description:** 在 Candidate 记录量证明有价值后，提供最小候选队列和转 Issue 操作。

**User story:** As a Loop Owner, I want to review reusable corrections in batches so that one-off feedback can become deliberate system improvement.

**Acceptance criteria:**

- [ ] 只有累计至少 10 个 Candidate 且其中至少 3 个被用户确认可复用后进入实施。
- [ ] 提供 proposed/accepted/rejected/converted_to_issue 四态列表与详情。
- [ ] accepted 只表示“认可为改进项”，不修改仓库；converted_to_issue 才创建 backlog Issue。
- [ ] 新 Issue 默认不指派 Agent，并回链 Candidate、Decision 与来源 Task。
- [ ] Candidate 状态变化追加审计事件且幂等。

**Priority:** P2 (Nice to have)

**Dependencies:** FR-004 的真实使用数据。

#### FR-008: 异常优先工作台

**Description:** 在验证数据证明决策包有效后，提供只聚合“需要你决定、正在推进、最近闭环”的轻量工作台。

**User story:** As a Loop Owner, I want attention organized by exceptions and decisions rather than by every status column.

**Acceptance criteria:**

- [ ] 仅在前 10 个 v2 dogfood Task 中 Decision 无 Transcript 比例 ≥80% 后进入实施。
- [ ] “需要你决定”只包含待验收、阻塞和达到最大重试的失败，按风险、优先级、等待时间排序。
- [ ] “正在推进”只展示摘要，不复制完整执行日志。
- [ ] “最近闭环”展示合入、返工和人工接管结果。
- [ ] 看板保留为完整状态视图，不删除、不重构数据模型。

**Priority:** P2 (Nice to have)

**Dependencies:** FR-005 的验证数据、FR-006 的 action-required 状态。

## 7. Non-Functional Requirements

#### Performance

- Review Packet 元数据响应 p95 <500ms；单次 Packet 最多 8 个当前检查，不包含 Diff 正文与 Transcript。
- 决策页生产构建下 p95 可交互时间 <1.5s；Diff 与 Transcript 按需请求。
- 单个 Delivery Report ≤64KB；单个 Verification Run 总输出摘录 ≤64KB；单条检查输出 ≤8KB。
- 默认面向单用户、最多 5 个并行 Task；不为假想大规模租户引入缓存层或消息队列。

#### Security

- Web 端继续仅绑定 `127.0.0.1` 且无用户认证；本迭代不扩大网络边界。
- Agent Delivery Report 只接受 task token；Runner Git/Verification/complete/fail 只接受 daemon token，并校验 claimed runtime/daemon 归属。
- daemon token 永不进入 Agent 或验证子进程；task token 不进入验证子进程；Agent 无权提交或覆盖 Runner 证据。
- Report、验证输出、错误与 Decision 文本持久化前执行递归脱敏。
- `ANVIL.verify.json` 命令来自用户信任的仓库；Runner 明确显示命令，限制数量、超时和输出，不从自由文本推断命令。
- v0 不提供文件系统、网络或本机凭据沙箱；用户必须显式信任仓库及其基线验证命令。
- 本迭代不新增外部来源 URL 字段或由 Server 主动抓取的网络入口，避免扩大 SSRF 与凭据泄漏面。

#### Reliability and integrity

- Task completed、Agent delivered、Verification passed、Human approved、Git merged 是五个独立事实。
- Agent Delivery、Human Decision 与 retry-push 使用显式幂等键；daemon start/complete/fail 使用稳定 payload hash 幂等。重复请求不产生重复评论、Task、Decision 或 Git 操作。
- Review Decision 追加写、每 Task 最多一条且不可覆盖；Git Merge/Push 结果写入独立 Integration Attempts。
- 合入前必须重新核对 base/head/verification/current-target；完整性失败不可 override。
- 数据库迁移必须保留历史 v1 Task 的查看、Diff、合入、打回、取消与评论功能，迁移在 transaction 中执行。
- Runner 单任务验证异常收敛为业务状态，不能导致 daemon 退出。

#### Compatibility

- Node.js ≥20、pnpm 10、Windows PowerShell/Git/Kimi 路径探测保持兼容。
- 本地路径与 Git URL 两种 repo_path 均覆盖。
- v1 Task 仍能使用旧 Diff、合入、打回、取消、评论与历史日志；v2 合入不能通过旧 `/merge` 绕过 Gate。
- Web import 继续使用显式 `.js` 后缀；不改变现有 REST/WS 基本约定。

#### Accessibility

- WCAG 2.2 AA；所有证据和决策状态使用图标+文字，不只依赖红绿。
- 决策按钮可键盘访问，有可见焦点；Dialog 保持焦点陷阱和 Esc 行为。
- 验证输出与 Diff 使用语义标题，屏幕阅读器可以区分 Agent 判断、Runner 证据和人类决定。
- 尊重 `prefers-reduced-motion`，不新增持续动效。

#### Availability and recovery

- 单机本地产品不声明云端 uptime SLA。
- SQLite 数据继续由用户现有备份策略负责；迁移失败时应用不得在半迁移状态启动。
- URL 仓库本地合入后远程推送失败必须可重试，不能自动重复 merge。

## 8. Technical Architecture

### System Overview

Anvil 保持现有 pnpm monorepo 和四包职责，不新增服务：

- `packages/core`：新增版本化 Delivery Report、Verification、Review Packet、Review Decision 类型、枚举、校验纯函数和 TaskResult 安全解析。
- `apps/runner`：采集不可变 Git 锚点，从基线版本读取 `ANVIL.verify.json`，在 Agent 完成后执行验证并将事实随 complete 上报。
- `apps/server`：存储 Agent Report、Runner Verification、Human Decision 与 Integration Attempts，派生 Gate，提供 Review Packet，执行受控 merge/push。
- `apps/web`：把 `/tasks/:id` 升级为决策页，侧栏复用摘要；Diff 和 Transcript 仍按需加载。

### Technology Stack

- **Frontend:** React 18、TypeScript、Vite、Tailwind CSS v4、现有 shadcn 风格组件。
- **Backend:** Node.js、TypeScript、Fastify 5、WebSocket。
- **Runner:** Node.js daemon、Kimi Code CLI、Git worktree。
- **Database:** SQLite、better-sqlite3、Drizzle ORM。
- **Testing:** Vitest、Testing Library、现有 Fake CLI。
- **Hosting:** 本机单用户，Server 绑定 `127.0.0.1:3100`。
- **New dependencies:** P0 不新增运行时依赖。

### Architecture Diagram (Description)

用户在现有看板创建 Issue → Server 创建 v2 Task → Runner claim Task 并准备 worktree，同时固化 target_branch/base_commit 与基线版本验证策略 → Kimi Agent 执行、commit，并用 task token 提交绑定 report_head_commit 的 Agent Delivery Report → Runner 比较 Report SHA，必要时追问，再检查 clean/head 并执行基线策略 → Runner 使用 daemon token 将 Git 与验证事实随 complete 提交给 Server → Server 在 transaction 中完成 Task、保存 Verification，并在 Report 存在时让 Issue 进入 in_review → Web 决策页请求 Review Packet，分区显示 Agent 判断、Runner 证据与 Git 事实 → 用户提交一条不可变 Review Decision → Server 在 repo 互斥锁内重新校验版本，写入一个或多个 Integration Attempts 并 merge/push；成功后 Issue.done，失败则按结果提供 fresh-base 返工、人工接管或 retry-push。

### Trust model

| Information | Producer | Trust level | UI label |
|---|---|---|---|
| 问题理解、方案、风险、未知项 | Agent | Judgment | Agent 判断 |
| base/head/branch/clean/diff stat | Runner daemon plane + Git | System fact | Git 事实 |
| 命令、退出码、耗时、输出摘要 | Runner daemon plane | Verification evidence | Runner 验证 |
| approve/revise/takeover、理由 | Human | Authority | 人类决定 |
| merge/push 结果 | Server + Git | Outcome fact | 合入结果 |

### Repository verification contract

仓库根新增可选文件 `ANVIL.verify.json`：

```json
{
  "version": 1,
  "commands": [
    {
      "id": "tests",
      "label": "全量测试",
      "command": "pnpm test",
      "required": true,
      "timeout_ms": 900000
    },
    {
      "id": "build",
      "label": "四包 TypeScript 构建",
      "command": "pnpm build",
      "required": true,
      "timeout_ms": 600000
    }
  ]
}
```

Runner 必须从 `base_commit` 读取该文件，例如 `git show <base_commit>:ANVIL.verify.json`；不能读取任务分支上被 Agent 修改后的版本作为本次强制策略。

### Authentication planes

| Plane | Credential | Allowed writes | Explicitly forbidden |
|---|---|---|---|
| Agent plane | task token | Delivery Report、messages、blocked、status/delivery query | start、complete、fail、Git anchors、Verification |
| Runner plane | daemon token + daemon_id | claim、start、complete、fail、Git/Verification facts | 下放给 Agent 或验证命令 |
| Human local Web | 127.0.0.1 local API | Review Decision、Candidate、merge/push retry | 伪造 Runner evidence |

Server 必须从 Task.runtime_id 反查 runtime.daemon_id，并与 Runner plane 请求的 daemon_id 一致；仅 workspace 匹配不足以证明该 Runner 拥有该 claimed Task。

### State taxonomy

| Layer | States | Meaning |
|---|---|---|
| Task lifecycle | queued/dispatched/running/completed/failed/cancelled | CLI 执行事实 |
| Review Packet | generating/ready/incomplete/verification_blocked/integrity_blocked/legacy/decision_recorded/integration_failed/remote_push_pending/closed | 页面与动作资格 |
| Verification | passed/failed/not_configured/partial/stale/dirty/legacy | Runner 终检事实 |
| Human Decision | approve/approve_override/changes_requested/manual_takeover | 人类权威判断 |
| Integration Attempt | merge_succeeded/merge_conflict/remote_push_succeeded/remote_push_failed/remote_non_fast_forward | 可重试 Git 结果 |

## 9. API Specifications

以下只列新增或改变语义的端点；现有 Issue、Task、Message、Diff、Comment API 保持。

#### POST /api/daemon/tasks/:id/start

**Purpose:** Runner 通过可信 daemon plane 上报 worktree 与不可变任务基线。

**Authentication:** Required — daemon token；Server 校验 daemon_id 与 claimed runtime。

**Request:**

```json
{
  "daemon_id": "local-runner-01",
  "work_dir": "D:/Users/example/.anvil/worktrees/abcd1234",
  "task_branch": "task/abcd1234",
  "target_branch": "main",
  "base_commit": "40-character-git-sha",
  "delivery_contract_version": 2
}
```

**Response (200):**

```json
{
  "ok": true,
  "task_id": "uuid",
  "status": "running"
}
```

**Error responses:**

- 400 `invalid_git_anchor`: branch 或 SHA 格式非法。
- 401: daemon token 无效。
- 403 `runtime_ownership_mismatch`: daemon_id 不拥有该 Task 的 runtime。
- 409 `invalid_transition`: Task 不是 dispatched。
- 409 `base_mismatch`: 续跑上报的基线与前序 Task 不一致。
- 409 `idempotency_conflict`: 已存在不同 start payload。

**Idempotency:** Server 持久化 start payload hash；相同 Task 和相同 hash 重试返回原 200，不重复推进状态。

#### PUT /api/daemon/tasks/:id/delivery-report

**Purpose:** Agent 幂等提交结构化判断材料；不包含平台验证结论。

**Authentication:** Required — task token。

**Request:**

```json
{
  "schema_version": 1,
  "report_head_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "problem_understanding": "用户无法判断 completed 是否真正满足交付门槛。",
  "solution_summary": "新增 Runner 验证证据与受控合入 Gate。",
  "changed_areas": [
    {
      "path": "apps/runner/src/verification.ts",
      "summary": "读取基线策略并执行验证命令"
    }
  ],
  "risks": [
    {
      "level": "medium",
      "summary": "验证命令可能超时",
      "mitigation": "每条命令独立 timeout 并终止进程树"
    }
  ],
  "unresolved": []
}
```

**Response (200):**

```json
{
  "ok": true,
  "task_id": "uuid",
  "report_version": 1,
  "report_head_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "submitted_at": "2026-08-27T10:00:00.000Z"
}
```

**Error responses:**

- 400 `invalid_schema`: 未知 schema 或字段非法。
- 400 `payload_too_large`: 总载荷超过 64KB。
- 401: task token 无效。
- 409 `task_not_active`: Task 已终态。

#### GET /api/daemon/tasks/:id/delivery

**Purpose:** Runner 查询 Agent 是否已提交交付及其是否满足追问停止条件。

**Authentication:** Required — task token。

**Response (200):**

```json
{
  "delivered": true,
  "report_submitted": true,
  "report_schema_version": 1,
  "report_head_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "issue_status_requested": "in_review"
}
```

**Error responses:**

- 401: task token 已失效。
- 404: Task 不存在。

#### POST /api/daemon/tasks/:id/complete

**Purpose:** Runner 通过可信 daemon plane 原子提交 Task 终态、Git 事实与实际验证回执。

**Authentication:** Required — daemon token；Server 校验 daemon_id 与 claimed runtime。

**Request:**

```json
{
  "daemon_id": "local-runner-01",
  "branch": "task/abcd1234",
  "work_dir": "D:/Users/example/.anvil/worktrees/abcd1234",
  "base_commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "head_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "worktree_clean": true,
  "verification": {
    "schema_version": 1,
    "policy_source": "ANVIL.verify.json",
    "policy_hash": "sha256-hex",
    "verification_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "status": "passed",
    "started_at": "2026-08-27T10:01:00.000Z",
    "completed_at": "2026-08-27T10:04:00.000Z",
    "checks": [
      {
        "id": "tests",
        "label": "全量测试",
        "command": "pnpm test",
        "required": true,
        "status": "passed",
        "exit_code": 0,
        "duration_ms": 180000,
        "output_excerpt": "187 tests passed"
      }
    ]
  }
}
```

**Response (200):**

```json
{
  "ok": true,
  "task_id": "uuid",
  "status": "completed",
  "review_packet_status": "ready"
}
```

**Error responses:**

- 400 `invalid_verification`: 状态与检查事实矛盾。
- 400 `payload_too_large`: 验证输出超限。
- 401: daemon token 无效。
- 403 `runtime_ownership_mismatch`: daemon_id 不拥有该 Task。
- 409 `base_mismatch`: complete 与 start 的基线不同。
- 409 `invalid_transition`: Task 已终态或状态不允许。
- 409 `idempotency_conflict`: 已存在不同 complete payload。

**Idempotency:** Server 持久化 complete payload hash 与原响应；相同 payload 重试返回原结果，即使 task token 已清除。

#### POST /api/daemon/tasks/:id/fail (changed semantics)

**Purpose:** Runner 在执行或终检无法完成时，通过可信 daemon plane 上报 Task 失败；Agent 不具备该写权限。

**Authentication:** Required — daemon token；Server 校验 `daemon_id` 与 claimed runtime。

**Request:** 保持现有错误字段并新增必填 `daemon_id`；错误文本在持久化前脱敏。

**Error responses:** 401 daemon token 无效；403 `runtime_ownership_mismatch`；409 `invalid_transition` 或 `idempotency_conflict`。

**Idempotency:** 与 start/complete 相同，持久化稳定 fail payload hash 与原响应。

#### POST /api/daemon/tasks/:id/issue-status (changed semantics)

**Purpose:** 保留 Agent blocked 逃生路径，同时阻止 v2 Agent 绕过人类 Decision 与 Integration Gate。

**Authentication:** Required — task token。

**Behavior:** v1 保持现有状态回调；v2 的 `blocked` 继续允许，`done` 返回 409 `human_decision_required`，`in_review` 返回 409 `runner_evidence_required`。v2 是否进入 in_review 由 Server 在可信 complete 后，根据 delivered_at、Report 与已持久化证据派生。

#### GET /api/tasks/:id/review-packet

**Purpose:** 获取不含完整 Diff/Transcript 的聚合决策材料。

**Authentication:** None — 保持本机 Web API 约定。

**Response (200):**

```json
{
  "task_id": "uuid",
  "issue_id": "uuid",
  "status": "ready",
  "problem": {
    "title": "建立可信验收证据",
    "description": "自然语言原始问题",
    "acceptance": "pnpm test 与 pnpm build 全绿"
  },
  "agent_report": {
    "source": "agent",
    "report_head_commit": "sha",
    "problem_understanding": "string",
    "solution_summary": "string",
    "changed_areas": [],
    "risks": [],
    "unresolved": []
  },
  "git_facts": {
    "source": "runner_git",
    "target_branch": "main",
    "base_commit": "sha",
    "task_branch": "task/abcd1234",
    "head_commit": "sha",
    "current_target_commit": "sha",
    "worktree_clean": true,
    "fresh": true
  },
  "verification": {
    "source": "runner",
    "status": "passed",
    "verification_sha": "sha",
    "checks": []
  },
  "decision_gate": {
    "can_approve": true,
    "can_override": false,
    "integrity_blockers": [],
    "quality_blockers": []
  },
  "decision": null,
  "integration_attempts": [],
  "activity": [
    {
      "id": "event-id",
      "type": "verification_completed",
      "actor_type": "runner",
      "actor_id": "local-runner-01",
      "task_id": "uuid",
      "occurred_at": "2026-08-27T10:04:00.000Z",
      "source_order": 30,
      "summary": "2/2 必选验证通过"
    }
  ],
  "live_check_error": null
}
```

**Error responses:**

- 404 `task_not_found`: Task 不存在。

**Live-check degradation:** Task 存在但 Git 实时核验失败时仍返回 200；`fresh=false`、`can_approve=false`，并在 `live_check_error` 返回机器码、中文恢复动作和持久化 Packet 快照。只有写操作使用 409。

#### POST /api/tasks/:id/review-decisions

**Purpose:** 追加写人类裁决，并按类型执行受控合入、返工或人工接管。

**Authentication:** None — 保持本机单用户 Web API 约定。

**Request:**

```json
{
  "client_request_id": "uuid",
  "decision": "approve",
  "feedback": null,
  "feedback_scope": null,
  "restart_mode": null,
  "override_reason": null,
  "review_started_at": "2026-08-27T10:10:00.000Z",
  "active_review_ms": 125000,
  "opened_transcript": false,
  "opened_full_diff": true
}
```

**Response (200):**

```json
{
  "decision_id": "uuid",
  "decision": "approve",
  "recorded_at": "2026-08-27T10:12:05.000Z",
  "integration_attempt": {
    "id": "uuid",
    "operation": "merge_and_push",
    "status": "succeeded",
    "outcome_code": "remote_push_succeeded",
    "merge_commit": "sha",
    "remote_ref": "refs/heads/main"
  },
  "followup_task_id": null,
  "candidate_id": null
}
```

**Decision behavior:**

| decision | Required fields | Server action |
|---|---|---|
| approve | Gate passed | 写 Decision，重新校验并创建 merge/push Attempt |
| approve_override | override_reason ≥10 chars，且无完整性 blocker | 写 off-ramp Decision，再创建 merge/push Attempt |
| changes_requested | feedback、feedback_scope、restart_mode | 写 Decision/时间线；resume 接力或 fresh_base 新建干净 Task |
| manual_takeover | feedback ≥10 chars | Issue → in_progress，assignee → member，不建 Task |

**Error responses:**

- 400 `feedback_required`、`override_reason_required`。
- 404: Task 不存在。
- 409 `stale_task`: 不是 Issue 最新可裁决 Task。
- 409 `integrity_blocked`: 分支、基线或工作树事实不允许覆盖。
- 409 `merge_conflict`: 已 abort，Integration Attempt outcome_code=merge_conflict。
- 409 `local_merged_remote_failed`: 本地已合入、远程未推送，可重试。

#### POST /api/review-decisions/:id/retry-push

**Purpose:** 对已经本地合入但远程 push 失败的权威批准进行仅 push 重试，不重复 merge 或创建第二条 Decision。

**Authentication:** None — 保持本机单用户 Web API 约定。

**Request:**

```json
{
  "client_request_id": "uuid"
}
```

**Response (200):**

```json
{
  "decision_id": "uuid",
  "integration_attempt": {
    "id": "uuid",
    "operation": "retry_push",
    "status": "succeeded",
    "outcome_code": "remote_push_succeeded",
    "merge_commit": "sha",
    "remote_ref": "refs/heads/main"
  },
  "issue_status": "done"
}
```

**Error responses:**

- 404: Decision 不存在。
- 409 `not_push_retryable`: 不存在 local_merged_remote_failed。
- 409 `local_target_moved`: 本地 target 不再指向记录的 merge_commit。
- 409 `remote_non_fast_forward`: fetch 后远端无法安全接收该 merge commit。

**Idempotency:** client_request_id 唯一；同键重放返回原 Integration Attempt。

#### POST /api/tasks/:id/merge (compatibility)

**Purpose:** 保留现有调用方；v1 继续旧行为，v2 必须委托同一 Review Gate，不能成为绕过入口。

**Authentication:** None。

**Behavior:**

- v1 Task：保持现有 Diff/merge/打回体验。
- v2 Task：没有 Review Decision 时返回 409 `decision_required`；已有 approve Decision 时只返回其 Integration 状态，不重复创建 Decision 或 merge。

#### GET /api/metrics/software-delivery-loop

**Purpose:** 输出本迭代的闭环验证指标。

**Authentication:** None。

**Request query:** `window=7d|30d|all`

**Response (200):**

```json
{
  "window": "30d",
  "sample_size": 18,
  "sample_warning": false,
  "packet_complete_rate": 0.94,
  "cycle_time_p50_ms": 2450000,
  "active_review_ms_p50": 180000,
  "decision_without_transcript_rate": 0.83,
  "revision_rate": 0.22,
  "off_ramp_rate": 0.11,
  "override_rate": 0.06,
  "base_advanced_rate": 0.08,
  "post_merge_correction_rate": 0.00
}
```

**Error responses:**

- 400 `invalid_window`。

#### GET /api/reviews/action-required

**Purpose:** 返回服务端可重建的待决策 Task，供 App 启动、WS 重连、Board 角标和未来工作台复用。

**Authentication:** None。

**Response (200):**

```json
{
  "items": [
    {
      "task_id": "uuid",
      "issue_id": "uuid",
      "packet_status": "ready",
      "action_required": true,
      "reason": "review_ready",
      "updated_at": "2026-08-27T10:04:00.000Z"
    }
  ]
}
```

**WS event:**

```json
{
  "type": "review.updated",
  "data": {
    "task_id": "uuid",
    "packet_status": "ready",
    "action_required": true,
    "occurred_at": "2026-08-27T10:04:00.000Z"
  }
}
```

#### GET /api/improvement-candidates

**Purpose:** P2 候选队列；P1 只创建记录，不实施此列表 UI。

**Authentication:** None。

**Request query:** `status=proposed|accepted|rejected|converted_to_issue`

**Response (200):**

```json
{
  "items": [
    {
      "id": "uuid",
      "kind": "project_rule",
      "status": "proposed",
      "title": "验证策略必须从基线读取",
      "review_decision_id": "uuid",
      "created_at": "2026-08-27T10:20:00.000Z"
    }
  ]
}
```

#### PATCH /api/improvement-candidates/:id

**Purpose:** 人工处理项目规则或自动化测试候选。

**Authentication:** None。

**Request:**

```json
{
  "status": "converted_to_issue"
}
```

**Response (200):**

```json
{
  "id": "uuid",
  "status": "converted_to_issue",
  "created_issue_id": "uuid"
}
```

**Error responses:**

- 400 `invalid_status`。
- 404: Candidate 不存在。
- 409 `already_resolved`。

**Semantics:** accepted 只表示用户认可该改进方向，不执行任何仓库修改；只有 converted_to_issue 创建 backlog Issue。

## 10. UI/UX Requirements

#### Shared Task Surface

**Purpose:** 现有 `TaskPanel` 与 `TaskDetailPage` 共用同一数据和状态内核，分别承担快速抽屉与完整决策页。

**Implementation contract:**

- 共享容器支持 `mode="drawer" | "page"`。
- 共用 `useTaskDetail`、Review Packet presenter、Decision Gate、generation 隔离、WebSocket 去抖和请求防重入。
- Drawer 只展示摘要与 `/tasks/:id` Link；完整 Decision UI 只在 page mode。
- queued/dispatched/running 保留现有取消任务、评论即指令、Enter 提交、失败保留草稿和增量日志。
- 正式 changes_requested 走 Review Decision 服务，不同时触发普通评论和 rerun 两套链路。

#### Task Decision Page

**Purpose:** 在一个完整页面内完成可信验收，而不是把日志当作主要工作界面。

**Key elements:**

- 问题与期望：Issue title、description、acceptance。
- Agent 交付：问题理解、方案摘要、改动区域；明确标注“Agent 判断”。
- Runner 验证：总体状态、每条命令、required、退出码、耗时、输出摘要。
- Git 事实：target/base/task/head/report/verification SHA、clean/fresh；默认显示前 12 位并支持复制完整值。
- 风险与未知项：按严重度展示；空状态写“Agent 未报告风险”，不能写“无风险”。
- 变更摘要：Diff stat 与按需打开的完整 Diff；保留 truncated 提示。
- 上下文动作：接受并合入、覆盖验证并合入、要求修改、从最新基线重新执行、人工接管、仅重试推送。
- 执行轨迹：复用 trace presenter，默认折叠。
- 活动时间线：只渲染 Packet.activity 契约，不从原始日志猜测产品事件。

**Information density:**

- passed 检查默认折叠摘要；failed/timed_out 默认展开。
- changed areas、risks、unresolved 超过 5 项后折叠。
- 完整输出、完整 Diff、Transcript 均为二级信息。
- Agent 判断与 Runner 验证使用不同标题和来源徽章，不仅依靠颜色。

**Lazy-loading acceptance:**

- 首屏只请求 Task/Issue 与 Review Packet，不调用 messages/diff。
- 用户首次展开 Diff 或 Transcript 才请求；再次折叠/展开不重复请求。
- Drawer running 模式继续按 seq 增量请求消息。
- Packet、Diff、Transcript 各自有 loading/error/retry，不因一个失败清空整页。

#### State and Action Matrix

| Condition | Page copy | Allowed actions |
|---|---|---|
| queued/dispatched/running | 排队中/执行中 | 取消、评论即指令、查看轨迹 |
| Task failed/cancelled | 执行失败/已取消 | 查看原因、重跑或人工接管 |
| completed + missing Report/branch/anchors | 交付材料不完整 | fresh-base 重新执行、人工接管 |
| Packet ready | 证据完整，可裁决 | 接受并合入、要求修改、人工接管 |
| verification not_configured/failed/partial | 验证未满足门槛 | 覆盖验证并合入、要求修改、人工接管 |
| integrity base_advanced/branch_moved | 证据已过期 | 从最新基线重新执行、人工接管 |
| integrity dirty | 工作树不干净 | 从最新基线重新执行、人工接管 |
| target workspace dirty/wrong branch | 用户工作区阻止合入 | 用户修复后刷新、人工接管 |
| Decision=changes_requested | 已要求修改 | 打开 follow-up Task |
| Decision=manual_takeover | 已转人工 | 查看记录、继续普通评论 |
| Decision approved + merge_conflict | 已批准但合入冲突 | 从最新基线重新执行、人工接管 |
| local merge + remote push failed | 本地已合入，远程未完成 | 仅重试推送、人工接管 |
| closed | 已成功合入 | 查看证据与历史，无重复主动作 |
| v1 legacy | 旧任务无结构化证据 | 保留旧 Diff、合入、打回、取消、评论 |

#### Review Action Dialogs

**Purpose:** 使用上下文动作而不是通用 Decision 下拉框。

**Key elements:**

- “要求修改”：feedback、feedback_scope、restart_mode。
- “覆盖验证并合入”：质量 blocker 摘要、二次确认、override_reason。
- “人工接管”：原因确认。
- “从最新基线重新执行”：说明不会 resume 旧 worktree，会创建新 Task 和新基线。

**States:**

- 提交中：所有动作禁用并有 loading；同步 ref 防同帧双击。
- 失败：保留输入并显示机器码对应的唯一恢复动作。
- changes_requested 成功：显示 follow-up Task 或 merged_into_pending。
- remote push 失败：只出现 retry-push，不再次显示 merge。

#### Error and Label Contract

- `labels.ts` 新增 REVIEW_PACKET_STATUS_LABELS、VERIFICATION_STATUS_LABELS、DECISION_LABELS、INTEGRATION_OUTCOME_LABELS、REVIEW_ERROR_COPY。
- API 封装新增结构化 `ApiError { status, code, message, details, retryable }`；Review Packet 的 live-check 失败走 200 + `live_check_error`。
- Task/Issue 404、首次加载失败、部分数据失败均有独立页面状态。
- 每个机器码只对应一个主恢复动作，避免“返工”无法修复 base_advanced 之类的假动作。

#### Board Drawer and App Notification

- Drawer 待决策模式显示 Packet 状态、验证通过数/总数、风险/未知项数与“打开完整决策页”。
- App 级 notifier 订阅一次 `review.updated`，启动/重连补拉 action-required。
- v0 没有 unread；标题圆点和角标代表尚未解决的 action_required，进入页面不清除。
- WS connected/reconnected 状态可见；断线提示“数据可能不是最新”。

## 11. Data Models

#### Task extensions

| Field | Type | Required | Description |
|---|---|---:|---|
| delivery_contract_version | integer | Yes | v1=历史，v2=本 PRD |
| task_branch | text | No | Runner 创建/复用的任务分支 |
| target_branch | text | No | worktree 创建时目标分支 |
| base_commit | text(40) | No | 首次 worktree 的不可变基线 |
| head_commit | text(40) | No | Agent/追问结束后的任务 HEAD |
| worktree_clean | integer boolean | No | complete 时工作树是否干净 |
| verification_status | text | No | passed/failed/not_configured/partial/stale/dirty/legacy |
| verification_run_id | UUID | No | 最新 Verification Run |
| start_payload_hash | text | No | daemon start 幂等 |
| complete_payload_hash | text | No | daemon complete 幂等与响应重放 |

**Relationships:**

- One Task to zero or one Delivery Report。
- One Task to many Verification Runs；v0 正常路径只写一条。
- One Task to zero or one authoritative Review Decision（一对一语义，Decision 侧外键唯一）。
- One Task to many Integration Attempts（经 Decision 间接关联）。

**Indexes:**

- `(issue_id, delivery_contract_version, created_at)` — 查找最新可裁决 Task。

#### Task Delivery Report

| Field | Type | Required | Description |
|---|---|---:|---|
| task_id | UUID | Yes | PK/FK，Task 一对一 |
| schema_version | integer | Yes | 当前为 1 |
| report_head_commit | text(40) | Yes | Agent 提交报告时的 HEAD |
| problem_understanding | text | Yes | Agent 对问题的理解，≤4,000 字符 |
| solution_summary | text | Yes | Agent 方案摘要，≤4,000 字符 |
| changed_areas_json | text JSON | Yes | 最多 50 项 path+summary |
| risks_json | text JSON | Yes | 最多 20 项 level+summary+mitigation |
| unresolved_json | text JSON | Yes | 最多 20 项 |
| submitted_at | timestamp UTC | Yes | 首次提交时间 |
| updated_at | timestamp UTC | Yes | 幂等更新 |

**Relationships:**

- One-to-one with Task。

**Indexes:**

- Primary key `task_id`。

#### Verification Run

| Field | Type | Required | Description |
|---|---|---:|---|
| id | UUID | Yes | Primary key |
| task_id | UUID | Yes | FK → Task |
| schema_version | integer | Yes | 当前为 1 |
| policy_source | text | Yes | ANVIL.verify.json 或 none |
| policy_hash | text | No | 基线策略 SHA-256 |
| base_commit | text(40) | Yes | 与 Task start 一致 |
| verification_sha | text(40) | No | 验证代码版本 |
| status | text | Yes | passed/failed/not_configured/partial/stale/dirty/legacy |
| started_at | timestamp UTC | No | 验证开始 |
| completed_at | timestamp UTC | Yes | 验证结束 |
| created_at | timestamp UTC | Yes | 记录创建 |

**Relationships:**

- Many-to-one with Task。
- One-to-many with Verification Check。

**Indexes:**

- `(task_id, created_at DESC)` — 最新验证。

#### Verification Check

| Field | Type | Required | Description |
|---|---|---:|---|
| id | UUID | Yes | Primary key |
| verification_run_id | UUID | Yes | FK → Verification Run |
| seq | integer | Yes | 策略顺序 |
| check_id | text | Yes | 策略内唯一 id |
| label | text | Yes | 中文名称 |
| command | text | Yes | 实际执行命令，≤500 字符 |
| required | integer boolean | Yes | 是否阻塞普通批准 |
| status | text | Yes | passed/failed/timed_out/skipped |
| exit_code | integer | No | 进程退出码 |
| duration_ms | integer | Yes | 执行耗时 |
| output_excerpt | text | No | 脱敏摘要，≤8KB |

**Relationships:**

- Many-to-one with Verification Run。

**Indexes:**

- Unique `(verification_run_id, seq)`。
- Unique `(verification_run_id, check_id)`。

#### Review Decision

| Field | Type | Required | Description |
|---|---|---:|---|
| id | UUID | Yes | Primary key |
| client_request_id | UUID | Yes | 幂等键，Unique |
| workspace_id | UUID | Yes | FK → Workspace |
| issue_id | UUID | Yes | FK → Issue |
| task_id | UUID | Yes | FK → Task |
| decision | text | Yes | approve/approve_override/changes_requested/manual_takeover |
| feedback | text | No | 返工或接管原因 |
| feedback_scope | text | No | one_time/project_rule/automated_test |
| override_reason | text | No | 覆盖质量 Gate 的理由 |
| evidence_status | text | Yes | 决策时 Packet 状态快照 |
| restart_mode | text | No | resume/fresh_base，仅 changes_requested |
| review_started_at | timestamp UTC | No | 客户端打开时间 |
| active_review_ms | integer | Yes | 主动验收时间 |
| opened_transcript | integer boolean | Yes | 是否展开原始轨迹 |
| opened_full_diff | integer boolean | Yes | 是否打开完整 Diff |
| created_by | UUID | Yes | 当前 member |
| created_at | timestamp UTC | Yes | 决策时间 |

**Relationships:**

- One-to-one with Task；many-to-one with Issue。
- One-to-zero-or-many with Improvement Candidate；v0 每种 kind 最多一条。
- One-to-many with Integration Attempt；只有 approve/approve_override 可产生。

**Indexes:**

- Unique `client_request_id`。
- Unique `task_id` — 每个 Task 只有一条权威 Decision。
- `(task_id, created_at)`。
- `(issue_id, created_at)`。

#### Integration Attempt

| Field | Type | Required | Description |
|---|---|---:|---|
| id | UUID | Yes | Primary key |
| client_request_id | UUID | Yes | retry-push 等操作幂等键 |
| review_decision_id | UUID | Yes | FK → Review Decision |
| attempt_no | integer | Yes | 同 Decision 下递增 |
| operation | text | Yes | merge_and_push/retry_push |
| status | text | Yes | running/succeeded/failed |
| outcome_code | text | Yes | merge_succeeded/merge_conflict/remote_push_succeeded/remote_push_failed/remote_non_fast_forward |
| target_branch | text | Yes | 目标分支 |
| merge_commit | text(40) | No | 本地 merge 成功后的 commit |
| remote_ref | text | No | 例如 refs/heads/main |
| error | text | No | 脱敏错误 |
| started_at | timestamp UTC | Yes | 操作开始 |
| completed_at | timestamp UTC | No | 操作结束 |

**Relationships:**

- Many-to-one with Review Decision。

**Indexes:**

- Unique `client_request_id`。
- Unique `(review_decision_id, attempt_no)`。
- `(review_decision_id, started_at)`。

#### Improvement Candidate

| Field | Type | Required | Description |
|---|---|---:|---|
| id | UUID | Yes | Primary key |
| workspace_id | UUID | Yes | FK → Workspace |
| issue_id | UUID | Yes | FK → Issue |
| task_id | UUID | Yes | FK → Task |
| review_decision_id | UUID | Yes | FK → Review Decision |
| kind | text | Yes | project_rule/automated_test |
| title | text | Yes | 从反馈生成的可读标题 |
| body | text | Yes | 原始反馈与上下文 |
| status | text | Yes | proposed/accepted/rejected/converted_to_issue |
| created_issue_id | UUID | No | 转为 backlog Issue 后的回链 |
| created_at | timestamp UTC | Yes | 创建时间 |
| resolved_at | timestamp UTC | No | 处理时间 |

**Relationships:**

- Many-to-one with Review Decision。
- Optional link to created Issue。

**Indexes:**

- Unique `(review_decision_id, kind)`。
- `(workspace_id, status, created_at)`。


## 12. Integration Points

#### Local Git

**Purpose:** worktree 隔离、版本锚点、Diff、merge、远程 push。

**Integration type:** CLI。

**Data exchanged:**

- Inbound: branch、commit SHA、status、diff stat、fetch/merge/push 输出。
- Outbound: worktree add、rev-parse、show、status、diff、fetch、merge、push、abort、cleanup。

**Authentication:** 本地 Git 配置或现有凭据；Runner 不弹交互式凭据窗口。

**Rate limits:** 无外部配额；同一规范化 repo_ref 的 fetch/merge/push 必须共用仓库级互斥锁，本地路径的只读检查不持锁跨越用户等待。

**Fallback behavior:** URL 仓库在 Gate 与 retry-push 前先 fetch；Git 不可用、路径不正确、分支过期、远端非 fast-forward 或工作区不干净时阻止写操作并保留持久化 Packet。

#### Kimi Code CLI

**Purpose:** 执行编码任务并提交 Agent Delivery Report。

**Integration type:** Headless CLI + HTTP callback。

**Data exchanged:**

- Inbound: 目标、原始问题、验收标准、评论、`ANVIL.md`、Delivery Report 回调说明。
- Outbound: 流式消息、代码提交、Agent 判断材料、blocked/in_review 意图。

**Authentication:** 单次 task token；daemon token 不下放。

**Rate limits:** 由现有并发与 idle timeout 控制。

**Fallback behavior:** 不提交 Report 时同会话追问最多 2 轮；仍失败则 undelivered，不进入可审查状态。

#### ANVIL.verify.json

**Purpose:** 为 Runner 提供版本化、机器可读的强制验证命令。

**Integration type:** Repository contract file。

**Data exchanged:**

- Inbound: version、commands、required、timeout。
- Outbound: policy_hash、实际检查结果。

**Execution semantics:** Windows 通过 `%SystemRoot%/System32/cmd.exe /d /s /c`，POSIX 通过 `/bin/sh -lc`；cwd 固定为 Task worktree。继承普通 Runner 环境并剔除 Anvil token 与已知 secret，但不提供文件系统、网络或本机凭据沙箱。

**Authentication:** 用户信任的 Git 仓库内容。

**Rate limits:** 最多 8 条命令，每条最长 30 分钟。

**Fallback behavior:** 文件不存在或非法时 verification=not_configured/failed；不得伪装 passed，可走人工覆盖或接管。

## 13. Edge Cases & Error Handling

### Edge Cases

| Scenario | Expected Behavior |
|---|---|
| Agent 先提交 Delivery Report，随后进程失败 | 保留 Report 供审计，Task failed，不生成可批准 Packet |
| Delivery Report 网络重试 | 按 Task upsert；相同内容不重复写评论或更新时间线事件 |
| Agent 未提交 Report | 最多追问 2 轮；Task 可 completed/undelivered，Issue 不进入 in_review |
| Report SHA 缺失或与最终 HEAD/verification SHA 不同 | Packet incomplete/stale；普通批准与覆盖批准都禁用 |
| `ANVIL.verify.json` 不存在 | verification=not_configured；普通批准禁用，可带理由覆盖或接管 |
| 策略 JSON 非法 | verification=failed，error_code=invalid_policy；不执行部分命令 |
| required 检查失败/超时 | verification=failed；普通批准禁用 |
| optional 检查失败 | verification=partial；普通批准策略由 Gate 定义为质量 blocker，可带理由覆盖 |
| 验证命令生成文件导致 dirty | verification=dirty；完整性 blocker，不允许覆盖 |
| Agent 完成后未 commit | worktree_clean=false 或 head 无预期变化；不能普通合入 |
| 验证后 Task 分支被改写 | 当前 HEAD ≠ verification_sha；Packet stale，禁止覆盖 |
| main 在执行期间前进 | current target ≠ base_commit；Packet integrity_blocked，v0 不自动 rebase/reverify；允许 fresh-base 新 Task或人工接管 |
| 用户读取旧 Task | Review Packet 仍返回 200 快照；提交 Decision 时返回 409 stale_task，不对新 Task 产生副作用 |
| changes_requested 时已有 pending Task | 反馈合并进 pending Task，返回其 id，不创建第二条 |
| changes_requested 时已有更新 running Task | 返回 stale_task，防止把旧反馈注入新执行 |
| 重复 approve | client_request_id 幂等，返回原 Decision 和首个 Integration Attempt；不产生第二条 Decision |
| merge 冲突 | merge --abort；Decision 保持不变，追加 outcome_code=merge_conflict 的 Attempt；Issue 保持 in_review |
| URL 仓库本地 merge 成功、远程 push 失败 | Decision 保持不变，追加 remote_push_failed Attempt；Packet remote_push_pending，Issue 保持 in_review；重试只 push 不重复 merge |
| retry-push 时远端已前进 | fetch 后追加 remote_non_fast_forward Attempt；不改本地 merge commit，不关闭 Issue |
| 目标仓库当前分支不是 target_branch | integrity blocker；不切换用户工作区、不 merge |
| 目标仓库有用户未提交修改 | integrity blocker；不触碰用户改动 |
| task token 在 Task 终态后提交 Report | 401/409，不更新记录 |
| Agent 使用 task token 调用 start/complete/fail | 401/403；不写 Git 或验证事实 |
| Runner start/complete 响应丢失 | 同 payload hash 重试返回原响应；不同 payload 409，不依赖 task token |
| Report/Verification 超限 | 400 payload_too_large；不截断后静默接受结构化 JSON |
| 未知枚举或 schema_version | 400 invalid_schema |
| 历史 v1 Task | 显示 legacy；保留旧查看能力，不声称有独立验证 |
| manual_takeover | Issue → in_progress、assignee → member；不创建 Task |
| Candidate 转 Issue | 创建 backlog、无 Agent assignee，并回链 Candidate |

### Error Handling Strategy

- **User-facing errors:** 使用稳定机器码映射唯一中文文案与恢复动作；不只显示 HTTP 状态。
- **System errors:** Server 结构化日志带 task_id、issue_id、decision_id；Runner 日志带 verification_run_id。
- **Retry logic:** Delivery/Complete/Decision 幂等；验证命令本身 v0 不自动重试，避免掩盖不稳定测试。
- **Graceful degradation:** Git 实时核验失败时仍展示持久化 Packet 快照，但禁用合入；Diff/Transcript 单独失败不影响其他材料。
- **No silent success:** 任何验证、merge、push 或 Candidate 操作失败都必须进入响应、Verification/Integration Attempt 事实或时间线；不得回写或篡改已记录 Decision。

## 14. Testing Requirements

#### Unit Tests

- Core Delivery Report 校验：合法、超长、未知 schema、重复 path、风险枚举。
- Core Verification Policy 校验与 verification status 派生。
- Core TaskResult 安全解析：旧 JSON、非法 JSON、缺失字段。
- Runner policy 读取：从 base_commit 读取而非任务分支工作树。
- Runner 输出脱敏、8KB 截断、总载荷上限。
- Web Review Packet presenter：generating/ready/incomplete/verification_blocked/integrity_blocked/legacy/decision_recorded/integration_failed/remote_push_pending/closed。
- Web Decision Gate presenter：普通批准、覆盖、不可覆盖。
- Metrics 纯函数：p50、比例、sample_warning。
- Review Packet `activity[]` 稳定排序：occurred_at/source_order/id 相同输入得到相同结果。

#### Integration Tests

- Drizzle migration 从现有 0000–0002 数据库升级；历史 v1 数据不丢。
- v2 start 使用 daemon token 写入 base/target；daemon_id 与 Task runtime 不匹配时 403；Agent task token 永远不能写入。
- start/complete/fail 同 payload hash 重放原响应，不同 payload 409；complete 后 task token 清除不影响 daemon 重放。
- 续跑和自动重试继承原始基线；fresh_base 返工创建全新 worktree、Task 与当前目标分支基线。
- Delivery Report 鉴权、校验、幂等、事务与 token 脱敏。
- 缺少或不匹配的 report_head_commit 触发追问；最终 Report/HEAD/verification SHA 不同阻止批准。
- Complete 原子写 Task、Verification Run、Checks，并正确派生 Packet 状态；Git 实时检查失败时 Packet GET 仍返回 200 快照与 live_check_error。
- v2 无 Report、未 delivered、验证失败、dirty、branch moved、base advanced、stale Task 均阻止普通合入。
- override 无理由失败；质量 blocker 有理由可合入；完整性 blocker 永远不可覆盖。
- v2 Agent 请求 `issue-status=done|in_review` 被拒绝，blocked 保留；v1 回调行为不变。
- approve 只创建一条不可变 Decision；merge/push 结果追加 Integration Attempt，失败不得改写 Decision。
- URL push 失败不 done，retry-push 不重复 merge；fetch 后 non-fast-forward 可恢复且可审计。
- changes_requested 只产生一个 pending Task，反馈进入下一次 Prompt。
- manual_takeover 不入队并把 assignee 交给 member。
- 旧 `/api/tasks/:id/merge` 对 v2 委托同一 Gate，不能绕过。
- v1 Packet 返回 200 legacy，旧 Diff、merge、rerun、cancel、comment 全部回归通过。
- `review.updated` 与 action-required 在应用启动、断线重连后可重建相同待办集合。

#### Runner Tests

- 新 worktree 正确采集 target/base/head/clean。
- 已 commit 的任务 Diff stat 使用固定 `base_commit..head_commit`，不再因 `git diff HEAD` 为空。
- 验证命令通过、失败、超时、spawn 失败、输出超限。
- 验证前后 HEAD 变化与 dirty 检测。
- 验证进程环境不包含 daemon/task token。
- Windows 命令经 cmd.exe `/d /s /c`、POSIX 经 `/bin/sh -lc`，cwd 始终是 Task worktree。
- Agent 未提交 Report 触发最多 2 轮追问。
- Agent Report SHA 与追问后 HEAD 不同会继续追问并最终标记 stale/incomplete。
- 单任务验证异常不上抛到 poller，daemon 继续运行。
- Windows 进程树终止、Git PATH 探测回归。

#### Web Component Tests

- 决策页展示 Issue description/acceptance、Agent 判断、Runner 证据、Git 事实。
- Packet 缺失、获取失败、live-check 失败、过期不静默消失。
- Verification passed/failed/partial/not_configured/stale/dirty/legacy 文案与图标。
- 普通合入 Gate、override 理由与二次确认。
- approve/changes_requested/manual_takeover 同帧双击只发送一次。
- 返工失败保留反馈；成功切换 follow-up Task 或显示 merged_into_pending。
- 执行轨迹默认折叠，展开继续复用 trace presenter。
- page mode 首屏不请求 messages/diff；首次展开请求一次并缓存，失败有独立重试；drawer running 仍按 seq 增量更新。
- queued/dispatched/running 的取消、评论、Enter 提交、失败草稿保留与同帧防重复回归通过。
- 通知在 Board、Agents、TaskDetail 路由均可触发并跳转 `/tasks/:id`。
- 断线显示“数据可能不是最新”，重连后 action-required 补拉且不产生 unread 副状态。
- 键盘与可访问性：动作是 Button/Link，焦点可见，Dialog 标签完整。

#### Service/Runner End-to-End Tests

当前仓库没有 Playwright/Cypress；v0 的自动端到端覆盖使用 Vitest、`buildApp`、临时 Git 仓库与 Fake CLI。浏览器真实交互与视觉检查列入 Manual Dogfood，不为了本 PRD 引入新的浏览器测试栈。

**Happy path:**

```text
创建 Issue
→ daemon claim
→ Fake Agent commit 并提交 Delivery Report
→ Runner 执行 ANVIL.verify.json 且全部通过
→ complete 固化 base/head/verification
→ Review Packet ready
→ 人类 approve
→ main 包含 merge commit
→ Issue done
→ Review Decision 与 Integration Attempt 分别可追溯
```

**Negative paths:**

- required check 失败 → 普通合入受阻 → approve_override 必须有理由并计入 off-ramp。
- verification_sha 不等于分支 HEAD → override 也禁止。
- changes_requested → 只创建/合并一个 pending Task → 下一次 claim 获得结构化反馈。
- URL push 失败 → Issue 不 done → 重试只 push。
- base advanced → 普通/覆盖批准均受阻 → fresh-base 新 Task 或人工接管。

#### Performance Tests

- 1,000 条 Task Message、8 个当前 Verification Check、20 条历史 Integration Attempt 时 Review Packet API p95 <500ms；固定测试机型、热身后重复 30 次并记录 p95。
- 决策页不请求 Transcript/Diff 时首屏 p95 <1.5s。
- 64KB 合法 Report/Verification 请求在本地 1 秒内完成校验和持久化。

#### Manual Dogfood

- 先在旧验收 UI 上以前瞻方式记录 10 个真实 v1/旧流程任务基线，使用与 v2 相同的 Review Timer；不回填历史 Task。
- 连续执行至少 10 个真实 v2 任务。
- 人工核对每个 Packet 的 SHA、命令与退出码。
- 记录是否打开 Transcript、主动验收时间、Decision、override 和 off-ramp。
- 手工覆盖 Chrome/Edge 的任务深链接、Dialog 键盘流、浅色/深色和窄屏 Drawer；确认 Diff/Transcript 未在首屏预取。
- 出现一次错误通过、过期合入或未授权规则修改即停止发布。

## 15. Implementation Notes for AI

### Build Order

1. **P0-A / 证据核心：** 在 `packages/core` 定义版本化类型、枚举、大小限制、状态派生、Gate 与 TaskResult 安全解析纯函数。
2. 修改 Server Drizzle schema，生成新迁移；先完成迁移、Decision/Attempt 约束和历史 v1 兼容测试。
3. 把 start/complete/fail 迁移到 daemon 鉴权与 runtime ownership 校验，加入稳定 payload hash 幂等；task token 权限不扩大。
4. 扩展 Runner worktree 准备与 start 协议，固化 target_branch/base_commit；实现基线策略读取、命令执行、超时、进程树终止、输出脱敏和 Git 新鲜度检查。
5. 实现 Delivery Report 服务；更新 Prompt、report_head_commit 校验与最多两轮追问条件。
6. 扩展 complete transaction，持久化 Verification Run/Checks，派生 v2 Packet；限制 v2 Agent issue-status 回调。
7. 在旧验收 UI 加入同一 `useReviewTimer`，前瞻采集 10 条基线；用至少 3 个 v2 任务 dogfood P0-A 的 SHA、权限和验证证据。P0-A 有完整性错误时停止。
8. **P0-B / 决策 Gate：** 实现 Review Packet、稳定 activity、action-required 与机器码；重构 review service，将一条 Decision 与多个 Integration Attempts 分离，加入仓库锁、fresh-base 与 retry-push。
9. 实现 Web API 类型与共享 `useTaskDetail`，拆分 ReviewPacket、VerificationEvidence、DecisionActions、ExecutionTrace、ActivityTimeline；升级 `/tasks/:id`，再把侧栏改为摘要模式。
10. 验证首屏不预取 Diff/Transcript，保留 active Task 交互和 v1 全链路；完成剩余 10 个 v2 dogfood 样本与 P0 Go/No-go。
11. P0 通过后依次实现 P1 Candidate 记录、Metrics 聚合与统一通知；P2 Candidate 管理/异常工作台不在本轮实施范围。
12. 每个落地阶段更新 `ANVIL.md`、`docs/GUIDE.md`、`docs/PROGRESS.md`、`docs/ROADMAP.md` 与 test-craft 用例。

### File Structure Suggestion

```text
packages/core/src/
  models.ts
  protocol.ts
  delivery.ts                 # 校验、派生与安全解析纯函数

apps/server/src/
  db/schema.ts
  services/delivery.ts        # Delivery Report + Verification 持久化
  services/review-packet.ts   # 聚合与 Gate
  services/review.ts          # merge/push
  services/review-decisions.ts
  services/integration-attempts.ts
  lib/repo-lock.ts
  services/metrics.ts
  routes/daemon.ts
  routes/review.ts

apps/runner/src/
  verification.ts
  worktree.ts
  executor.ts
  client.ts

apps/web/src/
  api.ts
  hooks/useTaskDetail.ts
  hooks/useReviewTimer.ts
  lib/review-packet-presenter.ts
  components/review/ReviewPacket.tsx
  components/review/VerificationEvidence.tsx
  components/review/DecisionActions.tsx
  components/review/ExecutionTrace.tsx
  components/review/ActivityTimeline.tsx
  components/TaskPanel.tsx
  pages/TaskDetailPage.tsx
```

### Critical Implementation Details

- **Do not add a generic Loop table.** Issue 是闭环实例，Task 是执行尝试；先证明一个具体闭环。
- **Evidence provenance is mandatory.** Agent、Runner、Git、Human 与 Integration Attempt 的来源必须在类型和 UI 中可区分。
- **Keep credential planes separate.** start/complete/fail 与 Runner 证据只用 daemon token 并校验 runtime ownership；Agent task token 只用于消息、Report 与兼容状态意图。
- **Bind the report to code.** `report_head_commit`、最终 `head_commit` 与 `verification_sha` 必须全部相等，任一缺失或不一致都不能批准。
- **Read policy from base.** `ANVIL.verify.json` 必须来自 base_commit；不要从 Agent 可修改的当前工作树读取。
- **Complete is not approval.** 不新增含混的 verifying/approved Task 状态；Verification 与 Decision 使用独立记录。
- **Decision is not integration.** 每 Task 只有一条不可变 Decision；merge/push/retry-push 只追加 Integration Attempt，失败不能改写人的选择。
- **Preserve delivered_at.** 进程结束不等于交付；v2 的 Delivery Report 与 delivered_at 条件同时满足后才可审查。
- **Prevent old-route bypass.** v2 的旧 merge API 必须调用同一个 Gate。
- **Keep pending uniqueness.** 返工继续尊重同 Issue 最多一个 queued/dispatched Task；唯一索引冲突不是系统异常。
- **Version every payload.** Delivery Report、Verification、TaskResult 均带 schema_version；未知版本明确拒绝。
- **No automatic second-order mutation.** Candidate 只记录和转 Issue，永不直接改仓库。
- **Remote push defines closure.** URL 仓库远程 push 未成功时不 done。
- **Do not hide live-check failure.** Task 存在时 Packet GET 始终返回 200 快照；实时 Git 错误放入 `live_check_error`，写请求才用 409 阻止动作。
- **Preserve v1 behavior.** v1 Packet 为 legacy，但旧 Diff、merge、rerun、cancel、comment 与日志必须可用。
- **Preserve Windows code.** 不清理 PATH 探测、SystemRoot taskkill 和 `windowsHide`。
- **No empty JSON POST regression.** Web 无 body 请求不要带 content-type；新增有 body 接口正常带 JSON。

### Code Style Preferences

- TypeScript strict，协议类型唯一来源为 `@anvil/core`。
- 文件、类型和 API 使用英文命名；代码注释、UI 文案、提交信息和文档使用中文。
- Web 导入保留显式 `.js` 后缀与现有 `@/` 别名。
- 复杂状态判断提取为纯函数，组件只负责布局和事件。
- 精确 SQL、部分索引、原子更新继续使用 `db.$client.prepare()`；简单 CRUD 使用 Drizzle。
- 所有日期存 UTC ISO 8601，UI 转本地时间。

### Libraries to Use

- 现有 Node `child_process` 执行验证命令 — 与 Runner 进程管理一致。
- 现有 `crypto` 计算 SHA-256 policy_hash — 无需新依赖。
- 现有 Fastify、better-sqlite3、Drizzle — 保持服务层模式。
- 现有 Vitest、Testing Library、Fake CLI — 覆盖纯函数、集成与 E2E。
- 现有 shadcn 风格组件与 Lucide — 保持视觉和可访问性。

### Libraries to Avoid

- Workflow/DAG 引擎 — 当前只有一个固定软件交付闭环。
- Bull/Redis/消息队列 — 单机现有调度足够。
- 新状态管理库 — 现有 React state/hooks 足够。
- 新 schema 运行时依赖 — v0 使用 core 纯函数校验，避免扩大 bundle。
- Markdown/日志解析器推断验证结果 — 验证必须来自 Runner 实际执行。
- 自动 Agent 评审或固定 tester Agent — 不把传统职能组织复制成 Agent 组织。

### Common Pitfalls

- 把 Agent Report 中的“测试通过”显示成 Runner passed。
- Runner 从任务工作树读取被修改后的验证策略。
- complete 清 token 后再要求 Agent 上传 Report。
- 让 Agent task token 获得 start/complete/fail 或 Verification 写权限。
- 只比较 Report 是否存在，不比较 report/head/verification 三个 SHA。
- 使用验收时动态 merge-base 代替记录的 base/head。
- 允许旧 `/merge` 绕过 v2 Gate。
- approve 后先标 done，再发现 merge/push 失败。
- 把 merge/push 失败写回 Decision，导致权威人类选择可变。
- changes_requested 同时调用 comment auto-enqueue 和 rerun，撞 pending 唯一索引。
- URL push 重试时再次执行 merge。
- base advanced 时复用旧 worktree resume，继续使用过期基线。
- 把完整 Diff 或 Transcript 塞进 Review Packet，导致首屏和 DB 膨胀。
- 把 Candidate 当作已应用规则，或未经人审写入项目。
- 为了“控制室”重做全部导航，稀释 P0 证据管线。

### Testing Approach

- Core 规则和 Gate 先写失败测试，再实现纯函数。
- Server 使用 `:memory:` SQLite + `buildApp` + `app.inject` 覆盖事务和状态迁移。
- Runner 使用临时 Git 仓库和 Fake CLI，真实执行短命令验证 SHA/dirty/timeout。
- Web 沿用 API/WS mock 与 MemoryRouter；每个阻塞状态至少一条组件测试。
- 现阶段不新增 Playwright/Cypress；完整服务—Runner 自动闭环使用 Fake CLI，浏览器行为在 dogfood 清单验证。
- 全量门槛：`pnpm test` 全绿 + 四包 `tsc --noEmit` 零错。
- Web 测试文件不在 tsc include 中，类型相关逻辑必须同时通过 Vitest。

### Release Go / No-go

**Go:**

- 连续 10 个真实 v2 Task 无错误通过、无过期证据合入。
- 必选验证失败时普通接受入口被阻止；人工覆盖/接管有审计记录。
- approve、merge_succeeded、merge_conflict、remote_push_failed 可区分。
- v1 旧流程、active Task 取消/评论和 page lazy-loading 均无回归。
- 返工不制造第二个 pending Task。
- Packet 完整率 ≥90%，无需 Transcript 裁决比例 ≥80%。
- 全量测试、四包 tsc 和 test-craft 用例全部通过。

**No-go:**

- 任意一次实际失败却显示 passed。
- SHA 已变化仍允许普通或覆盖合入。
- Candidate 未经明确批准修改项目。
- 新接口扩大 task token 权限或泄露敏感输出。
- 同一 Task 产生第二条权威 Decision，或 retry-push 重复执行 merge。
- active review time 相对基线上升 >20%。
- 超过 20% 的真实任务无法生成完整 Packet；此时先修证据管线，不扩建工作台或通用 Loop。

### Assumptions

- 当前部署继续是单机单用户，Server 与 Runner 可访问同一本地 Git/缓存；本 PRD 不进一步强化该假设，未来远程 Runner 需要把 Git outcome 服务下沉到 Runner。
- 用户信任目标仓库中的验证命令，且 Anvil 本身会新增 `ANVIL.verify.json` 用于 dogfood。
- 现有 Kimi Agent 能在 Task active 期间执行 HTTP callback；失败时由 Runner 同会话追问。
- 当前 187 条测试和四包 TypeScript 构建继续作为 Anvil 仓库的合并门槛。

### Key decisions

| Decision | Choice | Reason |
|---|---|---|
| 产品定位 | 交付证据与反馈闭环 v0 | 不夸大为完整 Software Factory |
| 顶层对象 | 继续使用 Issue/Task | 避免过早建设通用 Loop/DAG |
| 验证来源 | Runner 实际执行 | Agent 自述不能作为独立可信证据 |
| 验证策略 | 基线版本 ANVIL.verify.json | 机器可读、版本化、不可被本次任务弱化 |
| 人工 Gate | 合入前一次 | 避免计划/测试/合入多重人工交接 |
| 反馈学习 | 只创建 Candidate | 防止自动二阶反馈劣化循环 |
| UI 策略 | 升级 TaskDetail，侧栏摘要 | 证明价值前不重做首页 |
| 完整闭环终点 | 成功 merge/push | 部署、线上结果、客户回流留待后续 |

### Follow-up questions for later iterations

- 第二个真实 Loop 是否复用同样的 Evidence/Decision/Candidate 原语？
- 如何把部署、监控和客户来源接入结果闭环？
- 目标分支前进时是否由 Runner 自动重建 worktree、rebase 并重新验证？
- Candidate 如何批量聚类、评审、转化为 Contract/Test，并衡量复发率变化？
- 何时把默认首页从看板升级为异常优先工作台？
