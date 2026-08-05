import type { Agent, Comment, CreateIssueRequest, Issue, IssueWithTask, MergeResponse, Runtime, Task, TaskDiffResponse, UpdateIssueRequest } from "@anvil/core";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // 注意：无 body 时不能带 content-type: application/json，否则 fastify 会因空 JSON body 返回 400
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try { const j = await res.json(); if (j && typeof j.error === "string") detail = ` — ${j.error}`; } catch { /* ignore */ }
    throw new Error(`${method} ${path} → ${res.status}${detail}`);
  }
  return res.json() as Promise<T>;
}

export interface Bootstrap { workspace: { id: string; name: string; slug: string }; user: { id: string; name: string }; }
export interface IssueDetail { issue: Issue; comments: Comment[]; }
export interface TaskDetail { task: Task; issue: Issue; }

export const bootstrap = () => req<Bootstrap>("GET", "/api/bootstrap");
export const listIssues = (workspaceId: string) => req<IssueWithTask[]>("GET", `/api/issues?workspace_id=${workspaceId}`);
export const createIssue = (body: CreateIssueRequest) => req<Issue>("POST", "/api/issues", body);
export const updateIssue = (id: string, body: UpdateIssueRequest) => req<Issue>("PATCH", `/api/issues/${id}`, body);
export const rerunIssue = (id: string) => req<Task>("POST", `/api/issues/${id}/rerun`);
export const getIssueDetail = (id: string) => req<IssueDetail>("GET", `/api/issues/${id}`);
export const getIssueTasks = (id: string) => req<Task[]>("GET", `/api/issues/${id}/tasks`);
export const addComment = (id: string, body: string) => req("POST", `/api/issues/${id}/comments`, { body });
export const getTask = (id: string) => req<TaskDetail>("GET", `/api/tasks/${id}`);
export const getTaskMessages = (id: string, afterSeq = -1) =>
  req<{ seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null }[]>(
    "GET", `/api/tasks/${id}/messages?after_seq=${afterSeq}`,
  );
export const cancelTask = (id: string) => req("POST", `/api/tasks/${id}/cancel`);
export const getTaskDiff = (id: string) => req<TaskDiffResponse>("GET", `/api/tasks/${id}/diff`);
export const mergeTask = (id: string) => req<MergeResponse>("POST", `/api/tasks/${id}/merge`);
export const listAgents = () => req<Agent[]>("GET", "/api/agents");
export const createAgent = (body: { name: string; provider: string; max_concurrent_tasks?: number }) =>
  req<Agent>("POST", "/api/agents", body);
export const listRuntimes = () => req<Runtime[]>("GET", "/api/runtimes");
export const createDaemonToken = (label: string) => req<{ id: string; token: string }>("POST", "/api/daemon-tokens", { label });
