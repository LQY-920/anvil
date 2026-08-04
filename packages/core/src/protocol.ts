import type { FailureReason, Issue, IssueStatus, Priority, Task } from "./models.js";
import type { AgentMessage } from "./messages.js";

export interface DaemonRegisterRequest { daemon_id: string; runtimes: { provider: string; version: string | null }[]; }
export interface DaemonHeartbeatRequest { daemon_id: string; }
export interface ClaimRequest { daemon_id: string; max_tasks?: number; }
export interface TaskPackage {
  task: Task;
  issue: Issue;
  prior_work_dir: string | null;
  task_token: string;
}
export interface ClaimResponse { tasks: TaskPackage[]; }

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
  title: string; description?: string; priority?: Priority;
  assignee_type?: "member" | "agent"; assignee_id?: string; repo_path?: string;
}
export interface UpdateIssueRequest {
  title?: string; description?: string; status?: IssueStatus; priority?: Priority;
  assignee_type?: "member" | "agent" | null; assignee_id?: string | null; repo_path?: string | null;
}
