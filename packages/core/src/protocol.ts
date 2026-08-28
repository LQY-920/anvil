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

export interface TaskDiffResponse { branch: string; base: string; diff_stat: string; diff_text: string; truncated: boolean; }
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

/** Verification 单条检查(FR-001 §9 complete.body.verification.checks[])。 */
export interface VerificationCheck {
  id: string;
  label: string;
  command: string;
  required: boolean;
  status: VerificationCheckStatus;
  exit_code: number | null;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  output_excerpt: string;
}

/** Verification Run 整体记录(FR-001 §9 complete.body.verification)。
 *  字段同时支持 not_configured(无策略文件)与已执行两种形态:
 *  - not_configured: policy_source="none"、policy_hash=null、verification_sha=null、
 *    started_at=null;但 completed_at 仍是检测完成时间的 ISO 字符串,
 *    因为"决定有没有策略"这个事实也必须有时间戳,server 端在派生 Packet 状态时使用
 *  - 已执行:所有字段非空,checks 至少 1 条
 */
export interface VerificationRun {
  schema_version: 1;
  policy_source: "ANVIL.verify.json" | "none";
  policy_hash: string | null;
  base_commit: string;
  verification_sha: string | null;
  status: VerificationStatus;
  started_at: string | null;
  completed_at: string;
  checks: VerificationCheck[];
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

/** v2 Fail:Runner 终检失败或执行失败时上报(FR-001)。 */
export interface V2FailRequest {
  daemon_id: string;
  failure_reason: FailureReason;
  error: string;
  work_dir: string | null;
  head_commit: string | null;
  worktree_clean: boolean;
  delivery_contract_version: 2;
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
