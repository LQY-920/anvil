import { canonicalJsonHash } from "@anvil/core";
import { newId, type Db } from "../db/client.js";
import type { integrationAttempts } from "../db/schema.js";
import { redactTokens } from "./tasks.js";

export interface IntegrationIntent {
  task_id: string;
  repo_key: string;
  repo_path: string;
  repo_common_dir: string;
  repo_dev: string;
  repo_ino: string;
  task_branch: string;
  target_branch: string;
  task_head: string;
  target_head: string;
}

export type IntegrationAttempt = typeof integrationAttempts.$inferSelect;
export interface IntegrationReservation {
  acquired: boolean;
  attempt: IntegrationAttempt;
  conflict: null | "task" | "repository";
}

export const MAX_INTEGRATION_ERROR_BYTES = 4096;

function invalidState(message: string, missing = false): never {
  throw Object.assign(new Error(message), {
    http: missing ? 404 : 409,
    code: missing ? "integration_attempt_not_found" : "integration_state_conflict",
  });
}

function readById(db: Db, id: string): IntegrationAttempt {
  const attempt = db.$client.prepare("SELECT * FROM integration_attempts WHERE id=?").get(id) as IntegrationAttempt | undefined;
  if (!attempt) invalidState("合入操作不存在", true);
  return attempt;
}

/** 只保存有限且脱敏的诊断，不改写 daemon 的完成回执或原始交付证据。 */
export function integrationDiagnostic(error: string): string {
  const redacted = redactTokens(error)
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED]")
    .replace(/(Authorization\s*:\s*Basic\s+)\S+/gi, "$1[REDACTED]");
  if (Buffer.byteLength(redacted, "utf8") <= MAX_INTEGRATION_ERROR_BYTES) return redacted;
  const suffix = "…（已截断）";
  const limit = MAX_INTEGRATION_ERROR_BYTES - Buffer.byteLength(suffix, "utf8");
  let truncated = "";
  let size = 0;
  for (const character of redacted) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (size + bytes > limit) break;
    truncated += character;
    size += bytes;
  }
  return truncated + suffix;
}

export function findIntegrationAttempt(db: Db, taskId: string): IntegrationAttempt | undefined {
  return db.$client.prepare("SELECT * FROM integration_attempts WHERE task_id=?").get(taskId) as IntegrationAttempt | undefined;
}

/** BEGIN IMMEDIATE 在读取守卫前占用 SQLite 写锁，避免跨连接的先读后写竞争。
 *  两个唯一索引同时作为数据库最终约束；已完成 Task 也不能换键重新合入。 */
export function reserveIntegrationAttempt(db: Db, intent: IntegrationIntent): IntegrationReservation {
  return db.$client.transaction((): IntegrationReservation => {
    const existing = findIntegrationAttempt(db, intent.task_id);
    if (existing) return { acquired: false, attempt: existing, conflict: "task" };
    const occupied = db.$client.prepare("SELECT * FROM integration_attempts WHERE repo_key=? AND status <> 'completed'")
      .get(intent.repo_key) as IntegrationAttempt | undefined;
    if (occupied) return { acquired: false, attempt: occupied, conflict: "repository" };
    const id = newId();
    const now = new Date().toISOString();
    // 只摘要服务契约中的不可变字段，不接收请求方的 hash 或未知属性。
    const intentHash = canonicalJsonHash({
      task_id: intent.task_id, repo_key: intent.repo_key, repo_path: intent.repo_path,
      repo_common_dir: intent.repo_common_dir, repo_dev: intent.repo_dev, repo_ino: intent.repo_ino,
      task_branch: intent.task_branch, target_branch: intent.target_branch,
      task_head: intent.task_head, target_head: intent.target_head,
    });
    db.$client.prepare(`INSERT INTO integration_attempts
      (id,task_id,repo_key,repo_path,repo_common_dir,repo_dev,repo_ino,task_branch,target_branch,task_head,target_head,intent_hash,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`)
      .run(id, intent.task_id, intent.repo_key, intent.repo_path, intent.repo_common_dir, intent.repo_dev, intent.repo_ino,
        intent.task_branch, intent.target_branch, intent.task_head, intent.target_head, intentHash, now, now);
    return { acquired: true, attempt: readById(db, id), conflict: null };
  }).immediate();
}

export function setIntegrationLocalMerged(db: Db, id: string, sha: string): IntegrationAttempt {
  if (!/^[0-9a-f]{40}$/i.test(sha)) invalidState("合入提交必须是完整 SHA");
  return db.$client.transaction(() => {
    const attempt = readById(db, id);
    if (attempt.status !== "prepared") invalidState("只有准备中的操作可以记录本地合入");
    db.$client.prepare("UPDATE integration_attempts SET status='local_merged',merge_commit=?,updated_at=? WHERE id=? AND status='prepared'")
      .run(sha, new Date().toISOString(), id);
    return readById(db, id);
  }).immediate();
}

export function requireIntegrationRecovery(db: Db, id: string, error: string): IntegrationAttempt {
  const message = integrationDiagnostic(error);
  return db.$client.transaction(() => {
    const attempt = readById(db, id);
    if (attempt.status === "completed") invalidState("已完成的合入操作不能改为待恢复");
    db.$client.prepare("UPDATE integration_attempts SET status='recovery_required',error=?,updated_at=? WHERE id=? AND status<>'completed'")
      .run(message, new Date().toISOString(), id);
    return readById(db, id);
  }).immediate();
}

/** callback 仅执行同库的同步写入；与 completed 同事务提交，重放不重复调用。
 *  Git/网络副作用必须在外部完成，不会因 SQLite 回滚而自动撤销。 */
export function completeIntegrationAttempt(db: Db, id: string, onComplete: () => void): IntegrationAttempt {
  return db.$client.transaction(() => {
    const attempt = readById(db, id);
    if (attempt.status === "completed") return attempt;
    if (attempt.status !== "local_merged") invalidState("只有已确认本地合入的操作可以完成");
    db.$client.prepare("UPDATE integration_attempts SET status='completed',error=NULL,updated_at=? WHERE id=? AND status='local_merged'")
      .run(new Date().toISOString(), id);
    onComplete();
    return readById(db, id);
  }).immediate();
}
