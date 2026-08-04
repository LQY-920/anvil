import crypto from "node:crypto";
import { newId, type Db } from "../db/client.js";
import { sha256Hex } from "../lib/hash.js";
import { getIssue, addComment } from "./issues.js";
import type { Task, TaskPackage } from "@anvil/core";

export const LEASE_MS = 2 * 60 * 1000;

export function getTask(db: Db, id: string): Task | null {
  const row = db.$client.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
  return row ?? null;
}

/**
 * 原子认领：候选按 priority DESC, created_at ASC 排序；
 * 逐个用单条 UPDATE ... WHERE status='queued' 判赢（better-sqlite3 同步执行 + SQLite 单写者，
 * 语义等价 FOR UPDATE SKIP LOCKED）。认领前检查 agent 并发上限。
 */
export function claimTasks(db: Db, workspaceId: string, daemonId: string, maxTasks: number): TaskPackage[] {
  const providers = (db.$client
    .prepare(`SELECT provider FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND status = 'online'`)
    .all(workspaceId, daemonId) as any[]).map((r) => r.provider);
  if (providers.length === 0) return [];

  const out: TaskPackage[] = [];
  const candidates = db.$client
    .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND status = 'queued'
              ORDER BY priority DESC, created_at ASC LIMIT 50`)
    .all(workspaceId) as any[];

  for (const cand of candidates) {
    if (out.length >= maxTasks) break;
    const agent = db.$client.prepare(`SELECT * FROM agents WHERE id = ?`).get(cand.agent_id) as any;
    if (!agent || !providers.includes(agent.provider)) continue;
    const running = db.$client
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('dispatched','running')`)
      .get(cand.agent_id) as any;
    if (running.n >= agent.max_concurrent_tasks) continue;

    const runtime = db.$client
      .prepare(`SELECT * FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND provider = ? AND status = 'online'`)
      .get(workspaceId, daemonId, agent.provider) as any;
    const taskToken = `atk_${crypto.randomBytes(24).toString("hex")}`;
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const now = new Date().toISOString();
    const res = db.$client
      .prepare(`UPDATE tasks SET status='dispatched', runtime_id=?, task_token_hash=?, lease_expires_at=?, dispatched_at=?
                WHERE id=? AND status='queued'`)
      .run(runtime.id, sha256Hex(taskToken), lease, now, cand.id);
    if (res.changes !== 1) continue; // 被别人抢先

    // 同 issue 上一次完成任务的 work_dir，用于会话连续性
    const prior = db.$client
      .prepare(`SELECT work_dir FROM tasks WHERE issue_id = ? AND id != ? AND work_dir IS NOT NULL
                ORDER BY created_at DESC LIMIT 1`)
      .get(cand.issue_id, cand.id) as any;
    const task = getTask(db, cand.id)!;
    const issue = getIssue(db, cand.issue_id)!;
    out.push({ task, issue, prior_work_dir: prior?.work_dir ?? null, task_token: taskToken });
  }
  return out;
}

/** 失败落库 + 有限重试：attempt 未满则派生子任务重新入队。 */
export function failTaskInternal(db: Db, taskId: string, reason: string, error: string, workDir: string | null) {
  const task = getTask(db, taskId);
  if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;
  const now = new Date().toISOString();
  db.$client
    .prepare(`UPDATE tasks SET status='failed', failure_reason=?, error=?, completed_at=?, work_dir=COALESCE(?, work_dir),
              task_token_hash=NULL, lease_expires_at=NULL WHERE id=?`)
    .run(reason, error, now, workDir, taskId);
  if (task.attempt < task.max_attempts) {
    db.$client
      .prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts, parent_task_id, created_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(newId(), task.workspace_id, task.issue_id, task.agent_id, task.priority, task.attempt + 1, task.max_attempts, task.id, now);
    addComment(db, task.issue_id, {
      author_type: "system", author_id: "system", type: "system",
      body: `任务失败（${reason}），自动重试 ${task.attempt + 1}/${task.max_attempts}`,
    });
  }
}

export function startTask(db: Db, taskId: string, workDir: string): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='running', started_at=?, work_dir=? WHERE id=? AND status='dispatched'`)
    .run(now, workDir, taskId);
  return res.changes === 1;
}

export function completeTask(db: Db, taskId: string, result: { branch?: string; diff_stat?: string; work_dir?: string; session_id?: string }): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='completed', result_json=?, completed_at=?,
              work_dir=COALESCE(?, work_dir), session_id=COALESCE(?, session_id),
              task_token_hash=NULL, lease_expires_at=NULL
              WHERE id=? AND status IN ('dispatched','running')`)
    .run(JSON.stringify(result), now, result.work_dir ?? null, result.session_id ?? null, taskId);
  return res.changes === 1;
}

/** 租约清扫：dispatched 且租约过期 → 回 queued，token 作废，等待重新认领。 */
export function sweepExpiredLeases(db: Db, nowIso: string): number {
  const res = db.$client
    .prepare(`UPDATE tasks SET status='queued', runtime_id=NULL, task_token_hash=NULL,
              lease_expires_at=NULL, dispatched_at=NULL
              WHERE status='dispatched' AND lease_expires_at < ?`)
    .run(nowIso);
  return res.changes;
}

/** 看板取消：置 cancelled + failure_reason=cancelled_by_user。保留 token 让 runner 轮询能读到终态。 */
export function cancelTask(db: Db, taskId: string): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='cancelled', failure_reason='cancelled_by_user', completed_at=?, lease_expires_at=NULL
              WHERE id=? AND status IN ('queued','dispatched','running')`)
    .run(now, taskId);
  return res.changes === 1;
}

/** Agent 回调推进 issue 状态（spec §6：平台不替 Agent 做决定，只提供端点）。 */
export function setIssueStatusFromAgent(db: Db, taskId: string, status: string, note?: string): { ok: boolean; error?: string } {
  if (!["in_review", "done", "blocked"].includes(status)) return { ok: false, error: "status must be in_review | done | blocked" };
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "task not found" };
  const issue = getIssue(db, task.issue_id);
  if (!issue) return { ok: false, error: "issue not found" };
  const now = new Date().toISOString();
  db.$client.prepare(`UPDATE issues SET status=?, updated_at=? WHERE id=?`).run(status, now, issue.id);
  addComment(db, issue.id, {
    author_type: "agent", author_id: task.agent_id, type: "status_change",
    body: note ? `${issue.status} → ${status}：${note}` : `${issue.status} → ${status}`,
  });
  return { ok: true };
}
