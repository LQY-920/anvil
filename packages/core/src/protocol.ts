import type { FailureReason, Issue, IssueStatus, Priority, Task, TaskStatus } from "./models.js";
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
