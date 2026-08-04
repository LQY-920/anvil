import { eq } from "drizzle-orm";
import { newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { priorityWeight, type CreateIssueRequest, type Issue, type Task, type UpdateIssueRequest } from "@anvil/core";

function rowToIssue(r: typeof schema.issues.$inferSelect): Issue {
  return r as unknown as Issue;
}

export function getIssue(db: Db, id: string): Issue | null {
  const rows = db.select().from(schema.issues).where(eq(schema.issues.id, id)).all();
  return rows[0] ? rowToIssue(rows[0]) : null;
}

export function listIssues(db: Db, workspaceId: string): Issue[] {
  return db.select().from(schema.issues).where(eq(schema.issues.workspace_id, workspaceId)).all()
    .map(rowToIssue)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
}

/** 入队判定（spec §6 三个入口共用的唯一函数）：assignee 是 agent 且状态非 backlog 才入队。 */
export function enqueueForIssue(db: Db, issue: Issue, trigger: string): Task | null {
  if (issue.assignee_type !== "agent" || !issue.assignee_id) return null;
  if (issue.status === "backlog" || issue.status === "done" || issue.status === "cancelled") return null;
  const now = new Date().toISOString();
  const id = newId();
  try {
    db.insert(schema.tasks).values({
      id, workspace_id: issue.workspace_id, issue_id: issue.id,
      agent_id: issue.assignee_id, status: "queued",
      priority: priorityWeight(issue.priority), attempt: 1, max_attempts: 3,
      created_at: now,
    }).run();
  } catch (e: any) {
    // 部分唯一索引 tasks_one_pending_per_issue 冲突 = 已有 pending 任务。
    // better-sqlite3 对列索引报的 message 是 "UNIQUE constraint failed: tasks.issue_id"（不含索引名），两者都匹配。
    const msg = String(e?.message);
    if (msg.includes("tasks_one_pending_per_issue") || msg.includes("UNIQUE constraint failed: tasks.issue_id")) return null;
    throw e;
  }
  addComment(db, issue.id, { author_type: "system", author_id: "system", type: "system", body: `任务已入队（触发：${trigger}）` });
  return db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).all()[0] as unknown as Task;
}

export function addComment(
  db: Db, issueId: string,
  c: { author_type: string; author_id: string; type: string; body: string },
) {
  const id = newId();
  db.insert(schema.comments).values({
    id, issue_id: issueId, author_type: c.author_type, author_id: c.author_id,
    type: c.type, body: c.body, created_at: new Date().toISOString(),
  }).run();
  return id;
}

export function createIssueRow(db: Db, workspaceId: string, userId: string, req: CreateIssueRequest & { status?: string }): Issue {
  const now = new Date().toISOString();
  const id = newId();
  const status = (req.status as any) ?? "todo";
  db.insert(schema.issues).values({
    id, workspace_id: workspaceId, title: req.title, description: req.description ?? null,
    status, priority: req.priority ?? "medium",
    assignee_type: req.assignee_type ?? null, assignee_id: req.assignee_id ?? null,
    creator_type: "member", creator_id: userId,
    repo_path: req.repo_path ?? null,
    position: Date.now(), created_at: now, updated_at: now,
  }).run();
  return getIssue(db, id)!;
}

export function updateIssueRow(db: Db, id: string, req: UpdateIssueRequest): Issue | null {
  const cur = getIssue(db, id);
  if (!cur) return null;
  db.update(schema.issues).set({
    title: req.title ?? cur.title,
    description: req.description !== undefined ? req.description : cur.description,
    status: (req.status as any) ?? cur.status,
    priority: req.priority ?? cur.priority,
    assignee_type: req.assignee_type !== undefined ? req.assignee_type : cur.assignee_type,
    assignee_id: req.assignee_id !== undefined ? req.assignee_id : cur.assignee_id,
    repo_path: req.repo_path !== undefined ? req.repo_path : cur.repo_path,
    updated_at: new Date().toISOString(),
  }).where(eq(schema.issues.id, id)).run();
  return getIssue(db, id);
}

export function listTasksForIssue(db: Db, issueId: string): Task[] {
  return db.select().from(schema.tasks).where(eq(schema.tasks.issue_id, issueId)).all() as unknown as Task[];
}
