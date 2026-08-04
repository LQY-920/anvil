import type { Agent, Comment, CreateIssueRequest, Issue, Runtime, Task, UpdateIssueRequest } from "@anvil/core";

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export interface Bootstrap { workspace: { id: string; name: string; slug: string }; user: { id: string; name: string }; }
export interface IssueDetail { issue: Issue; comments: Comment[]; }
export interface TaskDetail { task: Task; issue: Issue; }

export const bootstrap = () => req<Bootstrap>("GET", "/api/bootstrap");
export const listIssues = (workspaceId: string) => req<Issue[]>("GET", `/api/issues?workspace_id=${workspaceId}`);
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
export const listAgents = () => req<Agent[]>("GET", "/api/agents");
export const createAgent = (body: { name: string; provider: string; max_concurrent_tasks?: number }) =>
  req<Agent>("POST", "/api/agents", body);
export const listRuntimes = () => req<Runtime[]>("GET", "/api/runtimes");
export const createDaemonToken = (label: string) => req<{ id: string; token: string }>("POST", "/api/daemon-tokens", { label });
