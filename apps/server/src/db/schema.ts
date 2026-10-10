import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ----------------------------------------------------------------------------
// A02 · v2 交付证据与反馈闭环 —— 数据模型增量
//
// 本节只声明 P0-A 需要的存储结构(D-002 / D-003 / D-007):
// - tasks 表新增 v2 字段(evidence / version / Git anchor / idempotency)
// - task_delivery_reports(FR-002)
// - verification_runs / verification_checks(FR-001)
// - review_measurements(D-002,只测量基础设施,不属于 P0-B Decision 概念)
//
// 明确不在此处出现:continuation_mode(0004)、review_decisions / integration_attempts
// (0004)、improvement_candidates(0005)。
// ----------------------------------------------------------------------------

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  settings_json: text("settings_json").notNull().default("{}"),
  created_at: text("created_at").notNull(),
});

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  password_hash: text("password_hash"),
  created_at: text("created_at").notNull(),
});

export const workspaceMembers = sqliteTable("workspace_members", {
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  user_id: text("user_id").notNull().references(() => users.id),
  role: text("role").notNull(), // owner | admin | member
}, (t) => [
  primaryKey({ columns: [t.workspace_id, t.user_id] }),
]);

export const issues = sqliteTable("issues", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  title: text("title").notNull(),
  description: text("description"),
  acceptance: text("acceptance"), // 验收标准：Agent 自验 + 平台追问的依据
  status: text("status").notNull().default("todo"),
  priority: text("priority").notNull().default("medium"),
  assignee_type: text("assignee_type"), // member | agent | null
  assignee_id: text("assignee_id"),
  creator_type: text("creator_type").notNull(),
  creator_id: text("creator_id").notNull(),
  repo_path: text("repo_path"),
  position: real("position").notNull().default(0),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (t) => [
  index("issues_ws_status").on(t.workspace_id, t.status),
]);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  provider: text("provider").notNull(), // 初版仅 'kimi'
  status: text("status").notNull().default("idle"),
  max_concurrent_tasks: integer("max_concurrent_tasks").notNull().default(1),
  runtime_id: text("runtime_id"),
  created_at: text("created_at").notNull(),
}, (t) => [
  index("agents_ws").on(t.workspace_id),
]);

// ----------------------------------------------------------------------------
// verification_runs 在 tasks 之前声明,tasks.verification_run_id 通过闭包反向引用,
// 解决 SQLite 双向 FK 引用导致的 TypeScript 循环依赖问题。
// 运行时:drizzle 的 .references() 接受回调,SQL 生成时才取值。
// ----------------------------------------------------------------------------

export const verificationRuns = sqliteTable("verification_runs", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull().references((): AnySQLiteColumn => tasks.id),
  schema_version: integer("schema_version").notNull(),
  policy_source: text("policy_source").notNull(), // "ANVIL.verify.json" | "none"
  policy_hash: text("policy_hash"), // nullable: not_configured 或 base_commit 上文件不存在
  base_commit: text("base_commit").notNull(),
  verification_sha: text("verification_sha"), // nullable: not_configured
  status: text("status").notNull(), // VerificationStatus
  started_at: text("started_at"), // nullable: not_configured 时 Runner 还没启动
  completed_at: text("completed_at").notNull(), // 必填:not_configured 也记录检测完成时间
  created_at: text("created_at").notNull(),
}, (t) => [
  index("verification_runs_task_id_created_at").on(t.task_id, t.created_at),
]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  issue_id: text("issue_id").notNull().references(() => issues.id),
  agent_id: text("agent_id").notNull().references(() => agents.id),
  runtime_id: text("runtime_id"),
  status: text("status").notNull().default("queued"),
  priority: integer("priority").notNull().default(20), // priorityWeight
  attempt: integer("attempt").notNull().default(1),
  max_attempts: integer("max_attempts").notNull().default(3),
  parent_task_id: text("parent_task_id"),
  failure_reason: text("failure_reason"),
  session_id: text("session_id"),
  work_dir: text("work_dir"),
  task_token_hash: text("task_token_hash"),
  result_json: text("result_json"),
  error: text("error"),
  lease_expires_at: text("lease_expires_at"),
  dispatched_at: text("dispatched_at"),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  delivered_at: text("delivered_at"), // Agent 回调 issue-status 成功的时间;进程结束 ≠ 交付
  // ---- A02 · v2 增量字段 ----
  // delivery_contract_version:历史 v1(0..n)+ 当前 v2。default 1 允许迁移前历史
  // 任务自动回填 v1(D-007);所有生产 v2 创建入口必须显式写 2,不能依赖 DB 默认值。
  delivery_contract_version: integer("delivery_contract_version").notNull().default(1),
  // Git anchor 与 v2 状态。start 前允许 null:Runner 在 start 时写入。
  task_branch: text("task_branch"),
  target_branch: text("target_branch"),
  base_commit: text("base_commit"),
  head_commit: text("head_commit"),
  worktree_clean: integer("worktree_clean", { mode: "boolean" }),
  verification_status: text("verification_status"),
  verification_run_id: text("verification_run_id").references((): AnySQLiteColumn => verificationRuns.id),
  // D-003 幂等键:daemon start/complete/fail 同 Task 同 operation 同 hash 返回原响应。
  // 响应丢失重放时不依赖 task token。
  start_payload_hash: text("start_payload_hash"),
  start_response_json: text("start_response_json"),
  complete_payload_hash: text("complete_payload_hash"),
  complete_response_json: text("complete_response_json"),
  fail_payload_hash: text("fail_payload_hash"),
  fail_response_json: text("fail_response_json"),
  created_at: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("tasks_one_pending_per_issue").on(t.issue_id).where(sql`status IN ('queued','dispatched')`),
  index("tasks_claim").on(t.status, t.priority, t.created_at),
  // A02-FIX · PRD 要求的 v2 历史/契约查询索引:同 issue 下的 v1/v2 Task 按时间倒序。
  // 注意:不是 UNIQUE —— 同一个 issue 同一 contract version 可以有历史多条。
  index("tasks_issue_contract_created").on(t.issue_id, t.delivery_contract_version, t.created_at),
]);

export const taskMessages = sqliteTable("task_messages", {
  id: text("id").primaryKey(),
  task_id: text("task_id").notNull().references(() => tasks.id),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  tool: text("tool"),
  content: text("content"),
  input_json: text("input_json"),
  output: text("output"),
  created_at: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("task_messages_task_seq").on(t.task_id, t.seq),
]);

export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  issue_id: text("issue_id").notNull().references(() => issues.id),
  author_type: text("author_type").notNull(),
  author_id: text("author_id").notNull(),
  type: text("type").notNull().default("comment"),
  body: text("body").notNull(),
  created_at: text("created_at").notNull(),
}, (t) => [
  index("comments_issue").on(t.issue_id, t.created_at),
]);

export const runtimes = sqliteTable("runtimes", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  daemon_id: text("daemon_id").notNull(),
  provider: text("provider").notNull(),
  version: text("version"),
  status: text("status").notNull().default("offline"),
  last_seen_at: text("last_seen_at"),
}, (t) => [
  uniqueIndex("runtimes_ws_daemon_provider").on(t.workspace_id, t.daemon_id, t.provider),
]);

export const daemonTokens = sqliteTable("daemon_tokens", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  token_hash: text("token_hash").notNull().unique(),
  label: text("label").notNull(),
  revoked_at: text("revoked_at"),
  created_at: text("created_at").notNull(),
}, (t) => [
  index("daemon_tokens_ws").on(t.workspace_id),
]);

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull().references(() => workspaces.id),
  name: text("name").notNull(),
  description: text("description"),
  content: text("content").notNull(),
  config_json: text("config_json").notNull().default("{}"),
}, (t) => [
  uniqueIndex("skills_ws_name").on(t.workspace_id, t.name),
]);

export const skillFiles = sqliteTable("skill_files", {
  id: text("id").primaryKey(),
  skill_id: text("skill_id").notNull().references(() => skills.id),
  path: text("path").notNull(),
  content: text("content").notNull(),
}, (t) => [
  index("skill_files_skill").on(t.skill_id),
]);

export const agentSkills = sqliteTable("agent_skills", {
  agent_id: text("agent_id").notNull().references(() => agents.id),
  skill_id: text("skill_id").notNull().references(() => skills.id),
}, (t) => [
  primaryKey({ columns: [t.agent_id, t.skill_id] }),
]);

// ----------------------------------------------------------------------------
// A02 · v2 证据表
// ----------------------------------------------------------------------------

/** Agent 交付报告(FR-002)。Task 一对零或一,by task_id PRIMARY KEY 自带唯一性。 */
export const taskDeliveryReports = sqliteTable("task_delivery_reports", {
  task_id: text("task_id").primaryKey().references(() => tasks.id),
  schema_version: integer("schema_version").notNull(),
  report_head_commit: text("report_head_commit").notNull(),
  problem_understanding: text("problem_understanding").notNull(),
  solution_summary: text("solution_summary").notNull(),
  changed_areas_json: text("changed_areas_json").notNull(),
  risks_json: text("risks_json").notNull(),
  unresolved_json: text("unresolved_json").notNull(),
  submitted_at: text("submitted_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

/** Verification Run 整体记录(FR-001 §9 complete.body.verification)。
 *  一个 Task 多个 Run(多次执行/重新执行),所以 task_id 上只是普通索引。 */
export const verificationChecks = sqliteTable("verification_checks", {
  id: text("id").primaryKey(),
  verification_run_id: text("verification_run_id").notNull().references(() => verificationRuns.id),
  seq: integer("seq").notNull(),
  check_id: text("check_id").notNull(),
  label: text("label").notNull(),
  command: text("command").notNull(),
  required: integer("required", { mode: "boolean" }).notNull(),
  status: text("status").notNull(),
  exit_code: integer("exit_code"),
  duration_ms: integer("duration_ms").notNull(),
  output_excerpt: text("output_excerpt"),
}, (t) => [
  uniqueIndex("verification_checks_run_id_seq_unique").on(t.verification_run_id, t.seq),
  uniqueIndex("verification_checks_run_id_check_id_unique").on(t.verification_run_id, t.check_id),
]);

/** Review Timer 测量(D-002)。每个 Task 最多一条,用 task_id 作主键支持 upsert 幂等。 */
export const reviewMeasurements = sqliteTable("review_measurements", {
  task_id: text("task_id").primaryKey().references(() => tasks.id),
  ui_version: text("ui_version").notNull(),
  review_started_at: text("review_started_at"),
  active_review_ms: integer("active_review_ms"),
  opened_transcript: integer("opened_transcript", { mode: "boolean" }).notNull(),
  opened_full_diff: integer("opened_full_diff", { mode: "boolean" }).notNull(),
  recorded_at: text("recorded_at").notNull(),
});
