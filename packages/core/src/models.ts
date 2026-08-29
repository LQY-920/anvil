export const ISSUE_STATUSES = ["backlog","todo","in_progress","in_review","done","blocked","cancelled"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const TASK_STATUSES = ["queued","dispatched","running","completed","failed","cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const PRIORITIES = ["urgent","high","medium","low","none"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function priorityWeight(p: Priority): number {
  return { urgent: 40, high: 30, medium: 20, low: 10, none: 0 }[p];
}

export const FAILURE_REASONS = ["runtime_offline","idle_timeout","spawn_failed","non_zero_exit","lease_expired","cancelled_by_user"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const AGENT_STATUSES = ["idle","working","blocked","error","offline"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const PROVIDERS = ["kimi"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Workspace { id: string; name: string; slug: string; settings_json: string; created_at: string; }
export interface User { id: string; email: string; name: string; password_hash: string | null; created_at: string; }

export interface Issue {
  id: string; workspace_id: string; title: string; description: string | null;
  acceptance: string | null;
  status: IssueStatus; priority: Priority;
  assignee_type: "member" | "agent" | null; assignee_id: string | null;
  creator_type: "member" | "agent"; creator_id: string;
  repo_path: string | null; position: number;
  created_at: string; updated_at: string;
}

export interface Task {
  id: string; workspace_id: string; issue_id: string; agent_id: string;
  runtime_id: string | null; status: TaskStatus; priority: number;
  attempt: number; max_attempts: number; parent_task_id: string | null;
  failure_reason: FailureReason | null; session_id: string | null; work_dir: string | null;
  task_token_hash: string | null; result_json: string | null; error: string | null;
  lease_expires_at: string | null; dispatched_at: string | null;
  started_at: string | null; completed_at: string | null; delivered_at: string | null; created_at: string;
  // ---- A02 · v2 交付证据与反馈闭环 ----
  // D-007:历史 v1 与新 v2 共用字面量联合,新建 v2 Task 必须写 DELIVERY_CONTRACT_CURRENT_VERSION (=2)。
  delivery_contract_version: DeliveryContractVersion;
  // Git anchor + 终态字段。start / complete 前允许 null;Runner / 持久化层负责写入。
  task_branch: string | null;
  target_branch: string | null;
  base_commit: string | null;
  head_commit: string | null;
  worktree_clean: boolean | null;             // 运行时归一化:SQLite 0/1 → boolean;null 保持 null
  verification_status: VerificationStatus | null;
  verification_run_id: string | null;
  // D-003 幂等键 + 响应(daemon 丢失响应后仍可重放)。
  start_payload_hash: string | null;
  start_response_json: string | null;
  complete_payload_hash: string | null;
  complete_response_json: string | null;
  fail_payload_hash: string | null;
  fail_response_json: string | null;
}

export interface Comment {
  id: string; issue_id: string; author_type: "member" | "agent" | "system";
  author_id: string; type: "comment" | "status_change" | "progress_update" | "system";
  body: string; created_at: string;
}

export interface Agent {
  id: string; workspace_id: string; name: string; provider: Provider;
  status: AgentStatus; max_concurrent_tasks: number; runtime_id: string | null; created_at: string;
}

export interface Runtime {
  id: string; workspace_id: string; daemon_id: string; provider: Provider;
  version: string | null; status: "online" | "offline"; last_seen_at: string | null;
}

// ----------------------------------------------------------------------------
// A01 · v2 交付证据与反馈闭环 —— 协议枚举、版本常量与数据形状
//
// 本节定义「可信交付 v2」的版本化状态与字段。这些类型只描述形状与语义,
// 具体的存储、路由、权限面、生命周期逻辑由 server/runner/web 各自在 A02+ 引入。
// 这里只预声明后续任务会复用的枚举,严禁暴露未实现 API。
// ----------------------------------------------------------------------------

/** v2 Task 契约版本:历史 v1 与新 v2 共享的字面量联合(D-007,迁移前 v1 Task 保持可读)。 */
export type DeliveryContractVersion = 1 | 2;
/** 当前新建 v2 Task 必须显式写入的 contract_version(D-007:不能依赖 DB 默认值)。 */
export const DELIVERY_CONTRACT_CURRENT_VERSION = 2 as const;

/** Agent Delivery Report 当前唯一 schema 版本(FR-002)。 */
export const DELIVERY_REPORT_SCHEMA_VERSION = 1 as const;
export type DeliveryReportSchemaVersion = typeof DELIVERY_REPORT_SCHEMA_VERSION;

/** Verification Policy 文件(ANVIL.verify.json)唯一支持的 schema 版本。 */
export const VERIFICATION_POLICY_SCHEMA_VERSION = 1 as const;
export type VerificationPolicySchemaVersion = typeof VERIFICATION_POLICY_SCHEMA_VERSION;

/** 风险等级(FR-002);`level` 取值,非法值需在 Report 校验阶段拒绝。 */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Verification 终态(FR-001 §8 state taxonomy,严格对齐 PRD)。 */
export const VERIFICATION_STATUSES = [
  "not_configured",
  "passed",
  "failed",
  "partial",
  "stale",
  "dirty",
  "legacy",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** 单条 Verification Check 的本地状态(用于 verification.checks[].status)。 */
export const VERIFICATION_CHECK_STATUSES = [
  "passed",
  "failed",
  "timed_out",
  "skipped",
] as const;
export type VerificationCheckStatus = (typeof VERIFICATION_CHECK_STATUSES)[number];

/** Review Packet 状态(FR-002 §8 state taxonomy;纯枚举,响应/请求体留给 B01)。 */
export const REVIEW_PACKET_STATUSES = [
  "generating",
  "ready",
  "incomplete",
  "verification_blocked",
  "integrity_blocked",
  "legacy",
  "decision_recorded",
  "integration_failed",
  "remote_push_pending",
  "closed",
] as const;
export type ReviewPacketStatus = (typeof REVIEW_PACKET_STATUSES)[number];

/** Task 延续模式(D-004)。 */
export const CONTINUATION_MODES = ["initial", "resume", "fresh_base"] as const;
export type ContinuationMode = (typeof CONTINUATION_MODES)[number];

/** Human Decision 类型(FR-003;P0-B 复用枚举,A01 仅声明)。 */
export const DECISION_TYPES = [
  "approve",
  "approve_override",
  "changes_requested",
  "manual_takeover",
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

/** 重启模式(FR-003 changes_requested 的 restart_mode)。 */
export const RESTART_MODES = ["resume", "fresh_base"] as const;
export type RestartMode = (typeof RESTART_MODES)[number];

/** 反馈范围(FR-004;P1 复用枚举,A01 仅声明)。 */
export const FEEDBACK_SCOPES = ["one_time", "project_rule", "automated_test"] as const;
export type FeedbackScope = (typeof FEEDBACK_SCOPES)[number];

/** Integration Attempt 终态(FR-003 §8 state taxonomy;纯枚举,响应体留给 B01)。 */
export const INTEGRATION_ATTEMPT_STATUSES = [
  "merge_succeeded",
  "merge_conflict",
  "remote_push_succeeded",
  "remote_push_failed",
  "remote_non_fast_forward",
] as const;
export type IntegrationAttemptStatus = (typeof INTEGRATION_ATTEMPT_STATUSES)[number];

/** 64KB、8KB、4000 字符等限额与 SHA 长度常量的唯一来源(A01 引入,所有包复用)。 */
export const LIMITS = {
  /** FR-002:Delivery Report 请求体上限。 */
  REPORT_BODY_BYTES: 64 * 1024,
  /** FR-002:problem_understanding / solution_summary 各自字符上限。 */
  REPORT_TEXT_FIELD_CHARS: 4_000,
  /** FR-002:changed_areas 上限。 */
  CHANGED_AREAS: 50,
  /** FR-002:risks 上限。 */
  RISKS: 20,
  /** FR-002:unresolved 上限。 */
  UNRESOLVED: 20,
  /** FR-001:Verification 策略命令上限(8)。 */
  VERIFICATION_COMMANDS: 8,
  /** FR-001:单条验证输出摘录上限(8KB)。 */
  CHECK_EXCERPT_BYTES: 8 * 1024,
  /** FR-001:验证载荷总摘录上限(64KB)。 */
  VERIFICATION_TOTAL_BYTES: 64 * 1024,
  /** FR-001:单条 verification 命令字符串长度上限(500 字符)。
   *  与 PRD §6 FR-001 "ANVIL.verify.json 命令" 安全契约对齐:
   *  限制命令长度,避免被恶意/手误塞入长字符串影响 shell 调用可读性。 */
  VERIFICATION_COMMAND_CHARS: 500,
  /** FR-001:timeout 下界(ms)。 */
  MIN_VERIFICATION_TIMEOUT_MS: 1_000,
  /** FR-001:timeout 上界(ms)。 */
  MAX_VERIFICATION_TIMEOUT_MS: 1_800_000,
} as const;
