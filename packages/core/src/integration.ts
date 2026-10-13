/** T01 公共契约：Git/远端事实、人工裁决与执行结果分别保存。 */
export type RepositoryMode = "local_git" | "github_pr";
export interface RepositoryIdentity { real_path: string; dev: string; ino: string; }
export interface Repository {
  id: string; workspace_id: string; mode: RepositoryMode;
  host: string; external_id: string; full_name: string; clone_url: string;
  target_branch: string; checkout_path: string; identity: RepositoryIdentity;
  connection_login: string | null; can_push: boolean;
  connection_status: "connected" | "unavailable" | "renamed" | "permission_denied";
  last_synced_at: string | null; next_sync_at: string | null; error: string | null;
  version: number; created_at: string; updated_at: string;
}
export interface RepositorySnapshot {
  schema_version: 1; repository_id: string; mode: RepositoryMode;
  host: string; external_id: string; full_name: string; clone_url: string;
  target_branch: string; checkout_path: string; identity: RepositoryIdentity;
  source_snapshot_id: string | null;
  /** 开放 PR 返工从已记录的交付提交新建工作树，绝不复用旧工作目录。 */
  starting_commit?: string;
  input: { title: string; description: string | null; acceptance: string | null };
}
export interface BindRepositoryRequest {
  mode: RepositoryMode; repo: string; checkout_path?: string; target_branch?: string;
  /** 外部稳定 ID 相同但名称变化时由用户明确确认。 */
  confirm_rename?: boolean;
}
export interface SourceSnapshot {
  id: string; repository_id: string; external_id: string; issue_number: number;
  url: string; title: string; body: string; state: "open" | "closed";
  source_updated_at: string; hash: string; created_at: string;
}
export interface IssueSource {
  repository_id: string; external_id: string; issue_number: number; url: string;
  accepted: SourceSnapshot; latest: SourceSnapshot; changed: boolean;
}
export interface GateBlocker { code: string; message: string; kind: "integrity" | "quality"; }
export interface ReviewGate {
  task_id: string; expected_head: string | null; evidence_version: string;
  mode: RepositoryMode | null; repository: Repository | null;
  blockers: GateBlocker[]; can_approve: boolean; can_override: boolean;
  stable_evidence_version?: string;
}
export type DecisionResult = "approved" | "overridden" | "rejected";
export interface ReviewDecision {
  id: string; task_id: string; actor_id: string; result: DecisionResult; reason: string;
  head_commit: string; evidence_version: string; request_key: string; created_at: string;
}
export interface SubmitDecisionRequest {
  result: DecisionResult; reason?: string; confirmed?: boolean;
  expected_head: string; expected_version: string;
  review_measurement_failed_for?: string;
}
export interface PullRequestRecord {
  id: string; repository_id: string; task_id: string; external_id: string; number: number; url: string;
  head_ref: string; head_sha: string; base_ref: string; state: "open" | "closed" | "merged";
  merge_commit: string | null; last_synced_at: string; checks: GitHubCheck[];
}
export interface GitHubCheck { name: string; status: string; conclusion: string | null; url: string | null; }
export interface DeliveryOperation {
  id: string; task_id: string; repository_id: string; decision_id: string | null;
  action: "local_merge" | "pull_request";
  state: "prepared" | "unknown" | "failed" | "succeeded";
  expected_head: string; request_key: string; result_json: string | null; error: string | null;
  expected_version?: string;
  created_at: string; updated_at: string;
}
export interface TaskIntegration {
  gate: ReviewGate; decision: ReviewDecision | null; pull_request: PullRequestRecord | null;
  operations: DeliveryOperation[]; source: IssueSource | null;
  last_synced_at: string | null; next_sync_at: string | null; sync_error: string | null;
}
export interface IntegrationActionRequest { expected_head: string; expected_version: string; }

/** 严格区分历史未绑定与损坏快照，避免解析失败后静默使用浮动 Issue。 */
export function parseRepositorySnapshot(value: string | null | undefined): RepositorySnapshot | null {
  if (value == null) return null;
  let parsed: any;
  try { parsed = JSON.parse(value); } catch { throw new Error("仓库快照无法解析"); }
  const strings = ["repository_id", "host", "external_id", "full_name", "target_branch", "checkout_path"];
  if (parsed?.schema_version !== 1 || !["local_git", "github_pr"].includes(parsed.mode)
    || strings.some((key) => typeof parsed[key] !== "string" || !parsed[key])
    || typeof parsed.clone_url !== "string" || !parsed.clone_url || typeof parsed.identity?.real_path !== "string" || !parsed.identity.real_path
    || typeof parsed.identity?.dev !== "string" || typeof parsed.identity?.ino !== "string"
    || !/^\d+$/.test(parsed.identity.dev) || !/^\d+$/.test(parsed.identity.ino)
    || typeof parsed.input?.title !== "string"
    || !(parsed.starting_commit === undefined || typeof parsed.starting_commit === "string" && /^[a-f0-9]{40}$/i.test(parsed.starting_commit))
    || !["description", "acceptance"].every((key) => parsed.input[key] === null || typeof parsed.input[key] === "string")
    || !(parsed.source_snapshot_id === null || typeof parsed.source_snapshot_id === "string")) throw new Error("仓库快照字段不完整");
  return parsed as RepositorySnapshot;
}
