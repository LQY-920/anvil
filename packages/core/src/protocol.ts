import type {
  DeliveryReportSchemaVersion, FailureReason, Issue, IssueStatus,
  Priority, ReviewPacketStatus, RiskLevel, Task, TaskStatus,
  VerificationCheckStatus, VerificationStatus,
} from "./models.js";
import type { AgentMessage } from "./messages.js";

export interface DaemonRegisterRequest { daemon_id: string; runtimes: { provider: string; version: string | null }[]; }
export interface DaemonHeartbeatRequest { daemon_id: string; }
export interface ClaimRequest { daemon_id: string; max_tasks?: number; }
/** issue 的最近评论摘要，随任务包下发给 runner 组 prompt。 */
export interface TaskComment { author_type: string; body: string; created_at: string; }
export interface TaskPackage {
  task: Task;
  issue: Issue;
  prior_work_dir: string | null;
  task_token: string;
  comments: TaskComment[];
}
export interface ClaimResponse { tasks: TaskPackage[]; }

/** 看板卡片上的最新任务摘要（GET /api/issues 随 issue 返回）。 */
export interface LatestTaskSummary {
  id: string; status: TaskStatus; attempt: number; max_attempts: number;
  failure_reason: string | null; error: string | null; result_json: string | null;
}
export interface IssueWithTask extends Issue { latest_task: LatestTaskSummary | null; }

export interface TaskDiffResponse {
  branch: string; base: string; diff_stat: string; diff_text: string; truncated: boolean;
  /** v1 为历史浮动比较；v2 的全文与统计均来自保存的完整提交。 */
  delivery_contract_version?: 1 | 2;
  base_commit?: string | null;
  head_commit?: string | null;
}
export interface MergeResponse { ok: true; merged_branch: string; target: string; }

export interface MessageBatchItem extends AgentMessage { seq: number; }
export interface AppendMessagesRequest { messages: MessageBatchItem[]; }
export interface AppendMessagesResponse { last_seq: number; }

export interface StartRequest { work_dir: string; }
export interface CompleteRequest { branch?: string; diff_stat?: string; work_dir?: string; session_id?: string; }
export interface FailRequest { failure_reason: FailureReason; error: string; work_dir?: string; }
export interface IssueStatusRequest { status: "in_review" | "done" | "blocked"; note?: string; }

export type ServerEventType = "issue.updated" | "task.updated" | "task.message" | "runtime.updated" | "task.available";
export interface ServerEvent { type: ServerEventType; data: unknown; }

export interface CreateIssueRequest {
  title: string; description?: string; acceptance?: string; priority?: Priority;
  assignee_type?: "member" | "agent"; assignee_id?: string; repo_path?: string;
}
export interface UpdateIssueRequest {
  title?: string; description?: string; acceptance?: string; status?: IssueStatus; priority?: Priority;
  assignee_type?: "member" | "agent" | null; assignee_id?: string | null; repo_path?: string | null;
}

// ----------------------------------------------------------------------------
// A01 · v2 交付证据与反馈闭环 —— 协议类型
//
// 这些类型对应 PRD §9 描述的新端点。A01 只声明类型,具体的路由、权限校验、
// 事务、副作用由 server/runner 在 A03+ 引入。
// ----------------------------------------------------------------------------

/** v2 Start:Runner 锁定不可变 Git 锚点(FR-001 AC 1–4)。
 *  contract_version 固定为字面量 2:Server 只接受 v2 新建或续跑请求,
 *  迁移前 v1 历史 Task 通过旧路径(非 v2 端点)处理,本类型不参与。 */
export interface V2StartRequest {
  daemon_id: string;
  work_dir: string;
  task_branch: string;
  target_branch: string;
  base_commit: string;
  delivery_contract_version: 2;
}
export interface V2StartResponse {
  ok: true;
  task_id: string;
  status: "running";
}

/** Verification Policy 文档原始 JSON 形状(在写入 `ANVIL.verify.json` 时使用)。
 *  version 固定为字面量 1 —— 后续扩展时单独 bump 至 2 并保留 v1 解析器。 */
export interface VerificationCommandSpec {
  id: string;
  label: string;
  command: string;
  required: boolean;
  timeout_ms: number;
}
export interface VerificationPolicyDoc {
  version: 1;
  commands: VerificationCommandSpec[];
}

/** Verification 单条检查(FR-001 §9 complete.body.verification.checks[])。
 *  字段集合与 PRD Complete 请求的 checks 项严格对齐;`started_at` /
 *  `completed_at` 只在 Run 顶层记录,不要求每条 check 重复提交时间戳。 */
export interface VerificationCheck {
  id: string;
  label: string;
  command: string;
  required: boolean;
  status: VerificationCheckStatus;
  exit_code: number | null;
  duration_ms: number;
  output_excerpt: string;
}

/** Runner 提交 DTO 允许的 verification.status 子集。
 *  R1-FIX2:只排除 `legacy`,它仅由 server 从历史 v1 `result_json` 派生,
 *  不允许新 Runner 主动提交。`not_configured` 属于 Runner 终检事实之一:
 *  ANVIL.verify.json 不存在时,Runner 实际从未执行任何命令,
 *  在 Complete 请求里提交 `status="not_configured"` + `policy_source="none"`
 *  + 空 `checks` 才是真实证据。Server 接收后根据该事实生成 verification_blocked /
 *  incomplete Packet。
 *
 *  两种典型形态:
 *  - not_configured:policy_source="none"、policy_hash=null、verification_sha=null、
 *    started_at=null、checks=[]
 *  - 已执行:policy_source="ANVIL.verify.json"、policy_hash 非空、checks 至少 1 条
 */
export type RunnerSubmittableVerificationStatus = Exclude<VerificationStatus, "legacy">;

/** Verification Run 整体记录(FR-001 §9 complete.body.verification)。
 *  R1-FIX2:`base_commit` 不在此处重复,只存在于 `V2CompleteRequest` 顶层;
 *  `status` 可以是 `not_configured`(Runner 在未找到策略文件时提交的真实证据)
 *  或已执行形态(passed/failed/dirty/stale/partial),但 `legacy` 仅由 server
 *  从 v1 `result_json` 派生,Runner 不得提交。
 *  字段同时支持 not_configured 与已执行两种形态:
 *  - not_configured:Runner 真实提交,policy_source="none"、checks=[]
 *  - 已执行:所有字段非空,checks 至少 1 条 */
export interface VerificationRun {
  schema_version: 1;
  policy_source: "ANVIL.verify.json" | "none";
  policy_hash: string | null;
  verification_sha: string | null;
  status: RunnerSubmittableVerificationStatus;
  started_at: string | null;
  completed_at: string;
  checks: VerificationCheck[];
  /** 策略非法或终检基础设施异常；没有执行检查也不能误报未配置。 */
  error_code?: "invalid_policy" | "verification_error";
}

/** v2 Complete:Runner 原子提交 Task 终态、Git 事实与验证证据(FR-001 AC 13,FR-002)。
 *  响应里返回 `review_packet_status`,使客户端在不另发 GET review-packet 时
 *  就能判断当前 Task 进入哪个 Packet 阶段(已 ready、incomplete、blocked 等)。 */
export interface V2CompleteRequest {
  daemon_id: string;
  branch: string;
  work_dir: string;
  base_commit: string;
  head_commit: string;
  worktree_clean: boolean;
  verification: VerificationRun;
}
export interface V2CompleteResponse {
  ok: true;
  task_id: string;
  status: "completed";
  review_packet_status: ReviewPacketStatus;
}

/** v2 Fail:Runner 终检失败或执行失败时上报(FR-001)。
 *  字段集合严格对齐 PRD Fail 请求,只包含:
 *  - `daemon_id`                  (必填,Runner plane 鉴权)
 *  - `failure_reason`             (必填,`FailureReason` 枚举)
 *  - `error`                      (必填,Runner 自由文本,持久化前必须脱敏)
 *  - `work_dir`                   (可选,失败时的 worktree 路径)
 *  Runner 不得在 Fail 请求里夹带 `head_commit` / `worktree_clean` /
 *  `delivery_contract_version` 等其他字段;Git 锚点由 `result_json`
 *  派生或由 complete 端点提交,不在 Fail 的 wire DTO 内。 */
export interface V2FailRequest {
  daemon_id: string;
  failure_reason: FailureReason;
  error: string;
  work_dir?: string | null;
}
export interface V2FailResponse {
  ok: true;
  task_id: string;
  status: "failed";
}

/** Agent Delivery Report 请求体(FR-002 §9 PUT /api/daemon/tasks/:id/delivery-report)。 */
export interface DeliveryReportSubmission {
  schema_version: DeliveryReportSchemaVersion;
  report_head_commit: string;
  problem_understanding: string;
  solution_summary: string;
  changed_areas: { path: string; summary: string }[];
  risks: { level: RiskLevel; summary: string; mitigation: string }[];
  unresolved: { description: string }[];
}

/** Agent Delivery Report 写入回执(§9)。 */
export interface DeliveryReportReceipt {
  ok: true;
  task_id: string;
  report_version: DeliveryReportSchemaVersion;
  report_head_commit: string;
  submitted_at: string;
}

/** Agent Delivery Report 重复提交幂等命中时返回。 */
export interface DeliveryReportReplay {
  ok: true;
  task_id: string;
  report_version: DeliveryReportSchemaVersion;
  report_head_commit: string;
  submitted_at: string;
  replay: true;
}
export type DeliveryReportResponse = DeliveryReportReceipt | DeliveryReportReplay;

/** Runner 询问 Agent 是否已交付(FR-002 §9 GET /api/daemon/tasks/:id/delivery)。 */
export interface DeliveryQueryResponse {
  delivered: boolean;
  report_submitted: boolean;
  report_schema_version: DeliveryReportSchemaVersion | null;
  report_head_commit: string | null;
  issue_status_requested: "in_review" | "done" | "blocked" | null;
}

/** 错误码联合类型 —— 仅包含 PRD §9 稳定机器码。
 *  route 在内部验证失败时把原因放进 `details` 字段;本联合是公开 API 的契约。 */
export type AnvilErrorCode =
  | "invalid_schema"
  | "invalid_git_anchor"
  | "payload_too_large"
  | "invalid_verification"
  | "runtime_ownership_mismatch"
  | "invalid_transition"
  | "base_mismatch"
  | "idempotency_conflict"
  | "task_not_active";

/** 公开 `AnvilErrorCode` 的运行时值集合(供测试与运行时校验使用)。 */
export const ANVIL_ERROR_CODE_VALUES: readonly AnvilErrorCode[] = [
  "invalid_schema",
  "invalid_git_anchor",
  "payload_too_large",
  "invalid_verification",
  "runtime_ownership_mismatch",
  "invalid_transition",
  "base_mismatch",
  "idempotency_conflict",
  "task_not_active",
] as const;

/** 统一错误响应体(A01 引入,各 route 共用)。 */
export interface AnvilErrorResponse {
  code: AnvilErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** A08：旧 UI 的最终验收测量。null 成对表示该 Task 的样本已失效，后续不能恢复为有效样本。 */
export interface ReviewMeasurementRequest {
  ui_version: "legacy";
  review_started_at: string | null;
  active_review_ms: number | null;
  opened_transcript: boolean;
  opened_full_diff: boolean;
}
export interface ReviewMeasurement extends ReviewMeasurementRequest {
  task_id: string;
  recorded_at: string;
}
/** 计时保存结果不确定时，随原裁决动作同步排除对应 Task，防止响应丢失的样本被误用。
 * Server 在 result_json.review_measurement_excluded 保存独立标记；基线查询必须排除该标记。 */
export interface ReviewMeasurementFailure {
  review_measurement_failed_for: string;
}
