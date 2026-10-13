import type { Agent, Comment, CreateIssueRequest, Issue, IssueWithTask, MergeResponse, Runtime, Task, TaskDiffResponse, UpdateIssueRequest, ReviewMeasurement, ReviewMeasurementRequest, ReviewMeasurementFailure } from "@anvil/core";
import type { Repository, BindRepositoryRequest, IssueSource, TaskIntegration, SubmitDecisionRequest, ReviewDecision, IntegrationActionRequest, DeliveryOperation } from "@anvil/core";

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string, public readonly detail?: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** 兼容未返回固定版本字段的历史服务端。 */
export type ReviewDiffResponse = TaskDiffResponse;

export function apiErrorText(error: unknown): string {
  return error instanceof ApiError ? error.detail || error.message : error instanceof Error ? error.message : String(error);
}

async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    method,
    signal,
    // 注意：无 body 时不能带 content-type: application/json，否则 fastify 会因空 JSON body 返回 400
    headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail: string | undefined;
    let code: string | undefined;
    try {
      const j = await res.json();
      if (j && typeof j.error === "string") detail = j.error;
      if (j && typeof j.code === "string") code = j.code;
    } catch { /* 非 JSON 错误仍保留 HTTP 状态。 */ }
    throw new ApiError(`${method} ${path} → ${res.status}${detail ? ` — ${detail}` : ""}`, res.status, code, detail);
  }
  return res.json() as Promise<T>;
}

export interface Bootstrap { workspace: { id: string; name: string; slug: string }; user: { id: string; name: string }; recent_repos: string[]; }
export interface IssueDetail { issue: Issue; comments: Comment[]; }
export interface TaskDetail { task: Task; issue: Issue; }
/** 评论触发的入队结果（旧 server 不返回 trigger 字段） */
export interface CommentTrigger { enqueued: boolean; task_id?: string; reason?: "merged_into_pending" | "assignee_not_agent" | "status_inactive"; }

export const bootstrap = () => req<Bootstrap>("GET", "/api/bootstrap");
export const listIssues = (workspaceId: string) => req<IssueWithTask[]>("GET", `/api/issues?workspace_id=${workspaceId}`);
export const createIssue = (body: CreateIssueRequest) => req<Issue>("POST", "/api/issues", body);
/** ANVIL.md 指引预览：found 时 content 已被 server 截断（≤2000 字符） */
export type GuidanceResponse = { found: true; content: string; truncated: boolean } | { found: false };
export const getGuidance = (repo: string) => req<GuidanceResponse>("GET", `/api/guidance?repo=${encodeURIComponent(repo)}`);
export const updateIssue = (id: string, body: UpdateIssueRequest) => req<Issue>("PATCH", `/api/issues/${id}`, body);
export const rerunIssue = (id: string) => req<Task>("POST", `/api/issues/${id}/rerun`);
export const getIssueDetail = (id: string) => req<IssueDetail>("GET", `/api/issues/${id}`);
export const getIssueTasks = (id: string) => req<Task[]>("GET", `/api/issues/${id}/tasks`);
export const addComment = (id: string, body: string, measurementFailure?: ReviewMeasurementFailure) => req<{ id: string; trigger?: CommentTrigger }>("POST", `/api/issues/${id}/comments`, { body, ...measurementFailure });
export const getTask = (id: string) => req<TaskDetail>("GET", `/api/tasks/${id}`);
export const getTaskMessages = (id: string, afterSeq = -1) =>
  req<{ seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null; created_at: string }[]>(
    "GET", `/api/tasks/${id}/messages?after_seq=${afterSeq}`,
  );
export const cancelTask = (id: string) => req("POST", `/api/tasks/${id}/cancel`);
export const getTaskDiff = (id: string) => req<ReviewDiffResponse>("GET", `/api/tasks/${id}/diff`);
export const mergeTask = (id: string, measurementFailure?: ReviewMeasurementFailure) => req<MergeResponse>("POST", `/api/tasks/${id}/merge`, measurementFailure);
export async function saveReviewMeasurement(id: string, body: ReviewMeasurementRequest): Promise<ReviewMeasurement> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try { return await req<ReviewMeasurement>("PUT", `/api/tasks/${id}/review-measurement`, body, controller.signal); }
  finally { clearTimeout(timeout); }
}
export const listAgents = () => req<Agent[]>("GET", "/api/agents");
export const createAgent = (body: { name: string; provider: string; max_concurrent_tasks?: number }) =>
  req<Agent>("POST", "/api/agents", body);
export const listRuntimes = () => req<Runtime[]>("GET", "/api/runtimes");
export const createDaemonToken = (label: string) => req<{ id: string; token: string }>("POST", "/api/daemon-tokens", { label });
export interface DaemonTokenInfo { id: string; label: string; revoked_at: string | null; created_at: string; }
export const listDaemonTokens = () => req<DaemonTokenInfo[]>("GET", "/api/daemon-tokens");
export const revokeDaemonToken = (id: string) => req<{ ok: true }>("POST", `/api/daemon-tokens/${id}/revoke`);

export const listRepositories = () => req<Repository[]>("GET", "/api/repositories");
export const bindRepository = (body: BindRepositoryRequest) => req<Repository>("POST", "/api/repositories", body);
export const syncRepository = (id: string) => req<Repository>("POST", `/api/repositories/${id}/sync`);
export const importRepositoryIssue = (id: string, issueNumber: number, sourceUpdatedAt?: string) =>
  req<{ issue_id: string; source_snapshot_id: string; disposition: string }>("POST", `/api/repositories/${id}/import-issue`, { issue_number: issueNumber, ...(sourceUpdatedAt ? { source_updated_at: sourceUpdatedAt } : {}) });
export const getIssueSource = (id: string) => req<IssueSource | null>("GET", `/api/issues/${id}/source`);
export const acceptIssueSource = (id: string, snapshotId: string) => req<IssueSource>("POST", `/api/issues/${id}/accept-source`, { snapshot_id: snapshotId });
export const getTaskIntegration = (id: string) => req<TaskIntegration>("GET", `/api/tasks/${id}/integration`);
export const submitTaskDecision = (id: string, body: SubmitDecisionRequest, key: string) =>
  req<{ decision: ReviewDecision; next_task_id?: string }>("POST", `/api/tasks/${id}/decisions`, body, undefined, { "Idempotency-Key": key });
export const integrateTask = (id: string, body: IntegrationActionRequest, key: string) =>
  req<DeliveryOperation>("POST", `/api/tasks/${id}/integrate`, body, undefined, { "Idempotency-Key": key });
export const createTaskPullRequest = (id: string, body: IntegrationActionRequest, key: string) =>
  req<DeliveryOperation>("POST", `/api/tasks/${id}/pull-request`, body, undefined, { "Idempotency-Key": key });
export const recoverTaskOperation = (id: string, operationId: string, body: IntegrationActionRequest, key: string) =>
  req<DeliveryOperation>("POST", `/api/tasks/${id}/operations/${operationId}/recover`, body, undefined, { "Idempotency-Key": key });
