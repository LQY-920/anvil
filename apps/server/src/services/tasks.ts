import crypto from "node:crypto";
import { newId, type Db } from "../db/client.js";
import { sha256Hex } from "../lib/hash.js";
import { getIssue, addComment } from "./issues.js";
import type { Task, TaskComment, TaskPackage } from "@anvil/core";

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
    // issue 最近 10 条评论随任务包下发（组 prompt 用）；rowid 作 created_at 同毫秒的决胜序，返回反转为时间正序
    const comments = (db.$client
      .prepare(`SELECT author_type, body, created_at FROM comments WHERE issue_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 10`)
      .all(cand.issue_id) as TaskComment[]).reverse();
    out.push({ task, issue, prior_work_dir: prior?.work_dir ?? null, task_token: taskToken, comments });
  }
  return out;
}

/** 失败落库 + 有限重试：attempt 未满则派生子任务重新入队。 */
export function failTaskInternal(db: Db, taskId: string, reason: string, error: string, workDir: string | null) {
  const task = getTask(db, taskId);
  if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;
  const now = new Date().toISOString();
  db.$client.transaction(() => {
    db.$client
      .prepare(`UPDATE tasks SET status='failed', failure_reason=?, error=?, completed_at=?, work_dir=COALESCE(?, work_dir),
                task_token_hash=NULL, lease_expires_at=NULL WHERE id=?`)
      .run(reason, error, now, workDir, taskId);
    if (task.attempt >= task.max_attempts) return;
    // 同 issue 已有 queued/dispatched 任务（如 running 期间用户手动 rerun）则跳过重试，
    // 否则 INSERT 会撞 tasks_one_pending_per_issue 部分唯一索引
    const pending = db.$client
      .prepare(`SELECT id FROM tasks WHERE issue_id = ? AND status IN ('queued','dispatched') LIMIT 1`)
      .get(task.issue_id);
    if (pending) return;
    db.$client
      .prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts, parent_task_id, created_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(newId(), task.workspace_id, task.issue_id, task.agent_id, task.priority, task.attempt + 1, task.max_attempts, task.id, now);
    addComment(db, task.issue_id, {
      author_type: "system", author_id: "system", type: "system",
      body: `任务失败（${reason}），自动重试 ${task.attempt + 1}/${task.max_attempts}`,
    });
  })();
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

/** 租约清扫：dispatched 且租约过期 → attempt+1 回 queued，token 作废；attempt 已满 → failed/lease_expired，不再重派（防无限重派）。 */
export function sweepExpiredLeases(db: Db, nowIso: string): number {
  const expired = db.$client
    .prepare(`SELECT id, attempt, max_attempts FROM tasks WHERE status='dispatched' AND lease_expires_at < ?`)
    .all(nowIso) as any[];
  let handled = 0;
  for (const t of expired) {
    if (t.attempt >= t.max_attempts) {
      handled += db.$client
        .prepare(`UPDATE tasks SET status='failed', failure_reason='lease_expired', error='lease expired, max attempts reached',
                  completed_at=?, runtime_id=NULL, task_token_hash=NULL, lease_expires_at=NULL, dispatched_at=NULL
                  WHERE id=? AND status='dispatched'`)
        .run(nowIso, t.id).changes;
    } else {
      handled += db.$client
        .prepare(`UPDATE tasks SET status='queued', attempt=attempt+1, runtime_id=NULL, task_token_hash=NULL,
                  lease_expires_at=NULL, dispatched_at=NULL
                  WHERE id=? AND status='dispatched'`)
        .run(t.id).changes;
    }
  }
  return handled;
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
  // 终态任务（如 cancelled）保留的 token 不能再推进 issue
  if (task.status !== "dispatched" && task.status !== "running") return { ok: false, error: "task not active" };
  const issue = getIssue(db, task.issue_id);
  if (!issue) return { ok: false, error: "issue not found" };
  const now = new Date().toISOString();
  db.$client.prepare(`UPDATE issues SET status=?, updated_at=? WHERE id=?`).run(status, now, issue.id);
  // 交付信号：Agent 回调成功才算交付（进程结束 ≠ 交付），runner 据此决定是否追问
  db.$client.prepare(`UPDATE tasks SET delivered_at=? WHERE id=?`).run(now, taskId);
  addComment(db, issue.id, {
    author_type: "agent", author_id: task.agent_id, type: "status_change",
    body: note ? `${issue.status} → ${status}：${note}` : `${issue.status} → ${status}`,
  });
  return { ok: true };
}
