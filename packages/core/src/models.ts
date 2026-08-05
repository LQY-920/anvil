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
