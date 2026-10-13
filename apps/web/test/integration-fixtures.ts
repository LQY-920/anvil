import type { Repository, ReviewDecision, Task, TaskIntegration, DeliveryOperation } from "@anvil/core";

export const head = "b".repeat(40);
export const repository: Repository = {
  id: "r1", workspace_id: "ws1", mode: "github_pr", host: "github.com", external_id: "42", full_name: "owner/repo", clone_url: "https://github.com/owner/repo.git", target_branch: "main", checkout_path: "D:/repo",
  identity: { real_path: "D:/repo/.git", dev: "1", ino: "2" }, connection_login: "owner", can_push: true, connection_status: "connected", last_synced_at: null, next_sync_at: null, error: null, version: 1, created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z",
};
export const task = { id: "t1", issue_id: "i1", status: "completed", delivery_contract_version: 2, repository_id: "r1", repository_snapshot_json: "{}", base_commit: "a".repeat(40), head_commit: head, target_branch: "main", verification_status: "passed", worktree_clean: true } as Task;
export const decision: ReviewDecision = { id: "d1", task_id: "t1", actor_id: "owner", result: "approved", reason: "检查通过", head_commit: head, evidence_version: "v1", request_key: "original", created_at: "2026-10-13T00:00:00Z" };
export const operation: DeliveryOperation = { id: "op1", task_id: "t1", repository_id: "r1", decision_id: "d1", action: "pull_request", state: "unknown", expected_head: head, request_key: "op-original", result_json: null, error: "网络中断，结果待查询", created_at: "2026-10-13T00:00:00Z", updated_at: "2026-10-13T00:00:00Z" };
export function integration(): TaskIntegration {
  return { gate: { task_id: "t1", expected_head: head, evidence_version: "v1", mode: "github_pr", repository, blockers: [], can_approve: true, can_override: false }, decision: null, pull_request: null, operations: [], source: null, last_synced_at: null, next_sync_at: null, sync_error: null };
}
