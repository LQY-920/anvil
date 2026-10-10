import Database from "better-sqlite3";
import { createHash } from "node:crypto";

const evidenceTables = ["task_delivery_reports", "verification_runs", "verification_checks", "review_measurements"];

export function isUtcTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** 只读盘点技术事实，不读取正文、日志、token 或执行验证命令，也不自动放行 R2。 */
export function readR2Inventory(dbPath: string, since: string, taskIds: string[] = []) {
  if (!isUtcTimestamp(since) || Date.parse(since) > Date.now()) throw new Error("采集起点必须是非未来的 UTC ISO 时间");
  if (taskIds.length > 20) throw new Error("每次最多核对 20 个 Task");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return db.transaction(() => {
      const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      if (!hasTable("tasks")) throw new Error("数据库没有 tasks 表");
      const columns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
      const v2 = columns.some(c => c.name === "delivery_contract_version") && evidenceTables.every(hasTable);
      const now = new Date().toISOString();
      const measurements = v2 ? db.prepare(`
        SELECT m.task_id, m.ui_version, m.review_started_at, m.active_review_ms,
          m.opened_transcript, m.opened_full_diff, m.recorded_at, t.created_at, t.completed_at, t.status,
          json_valid(COALESCE(t.result_json, '{}')) AS result_valid,
          json_extract(CASE WHEN json_valid(t.result_json) THEN t.result_json ELSE '{}' END,
            '$.review_measurement_excluded') AS excluded
        FROM review_measurements m JOIN tasks t ON t.id=m.task_id
        WHERE m.ui_version='legacy' AND t.created_at>=? AND m.recorded_at>=?
        ORDER BY m.recorded_at, m.task_id
      `).all(since, since) as MeasurementRow[] : [];
      const eligible = measurements.filter(m => eligibleMeasurement(m, since, now));
      return {
        schema_version: 1,
        r2_gate: "pending_human_review",
        collected_at: now,
        collection_started_at: since,
        database_schema: v2 ? "v2" : "legacy_or_incomplete",
        task_counts: db.prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY status").all(),
        v2_completed_since: v2 ? (db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE delivery_contract_version=2 AND status='completed' AND created_at>=?").get(since) as { count: number }).count : null,
        legacy_measurements_since: v2 ? {
          candidate_count: eligible.length,
          excluded_or_invalid_count: measurements.length - eligible.length,
        } : null,
        // 仅显式选择的 Task 返回明细；候选计数不证明真实 Agent 或人工判断来源。
        selected_tasks: taskIds.map(id => {
          if (!v2) return { task_id: id, availability: "schema_unavailable" };
          const task = db.prepare(`SELECT id, delivery_contract_version, status, created_at, completed_at,
            delivered_at, base_commit, head_commit, worktree_clean, verification_status, verification_run_id
            FROM tasks WHERE id=?`).get(id) as { verification_run_id: string | null } | undefined;
          if (!task) return { task_id: id, availability: "not_found" };
          const report = db.prepare("SELECT schema_version, report_head_commit, submitted_at, updated_at FROM task_delivery_reports WHERE task_id=?").get(id) ?? null;
          const run = task.verification_run_id ? db.prepare(`SELECT id, task_id, schema_version, policy_source,
            policy_hash, base_commit, verification_sha, status, started_at, completed_at
            FROM verification_runs WHERE id=?`).get(task.verification_run_id) ?? null : null;
          const checks = task.verification_run_id ? db.prepare(`SELECT seq, check_id, command, required,
            status, exit_code, duration_ms FROM verification_checks WHERE verification_run_id=? ORDER BY seq`
          ).all(task.verification_run_id) as CheckRow[] : [];
          return {
            task_id: id, availability: "available", task, report, verification: run,
            // 命令可能包含用户凭据，输出摘要供与基线策略逐项比对，不导出原文。
            checks: checks.map(({ command, ...check }) => ({ ...check, command_sha256: createHash("sha256").update(command).digest("hex") })),
            measurement_candidate: eligible.some(m => m.task_id === id),
            measurement: db.prepare(`SELECT ui_version, review_started_at, active_review_ms,
              opened_transcript, opened_full_diff, recorded_at FROM review_measurements WHERE task_id=?`).get(id) ?? null,
          };
        }),
      };
    })();
  } finally {
    db.close();
  }
}

interface CheckRow {
  seq: number; check_id: string; command: string; required: number;
  status: string; exit_code: number | null; duration_ms: number;
}
interface MeasurementRow {
  task_id: string; ui_version: string; review_started_at: string | null; active_review_ms: number | null;
  opened_transcript: number; opened_full_diff: number; recorded_at: string;
  created_at: string; completed_at: string | null; status: string;
  result_valid: number; excluded: unknown;
}
function eligibleMeasurement(m: MeasurementRow, since: string, now: string) {
  if (m.status !== "completed" || !m.result_valid || (m.excluded !== null && m.excluded !== false && m.excluded !== 0)) return false;
  if (!m.review_started_at || !m.completed_at || m.active_review_ms === null || !Number.isSafeInteger(m.active_review_ms) || m.active_review_ms < 0) return false;
  if (![m.created_at, m.completed_at, m.review_started_at, m.recorded_at].every(isUtcTimestamp)) return false;
  return m.opened_transcript === 1 && [0, 1].includes(m.opened_full_diff)
    && m.created_at >= since && m.review_started_at >= since && m.completed_at >= m.created_at
    && m.review_started_at >= m.completed_at && m.recorded_at >= m.review_started_at && m.recorded_at <= now
    && m.active_review_ms <= Date.parse(m.recorded_at) - Date.parse(m.review_started_at);
}
