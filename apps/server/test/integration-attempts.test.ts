import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJsonHash } from "@anvil/core";
import { createDb, runMigrations, seed, type Db } from "../src/db/client.js";
import {
  completeIntegrationAttempt,
  findIntegrationAttempt,
  MAX_INTEGRATION_ERROR_BYTES,
  requireIntegrationRecovery,
  reserveIntegrationAttempt,
  setIntegrationLocalMerged,
  type IntegrationIntent,
} from "../src/services/integration-attempts.js";

const TASK_HEAD = "a".repeat(40);
const TARGET_HEAD = "b".repeat(40);
const MERGE_HEAD = "c".repeat(40);
const connections: Db[] = [];
const directories: string[] = [];

function open(dbPath = ":memory:"): Db {
  const db = createDb(dbPath);
  connections.push(db);
  runMigrations(db);
  return db;
}

function fixture(db: Db): void {
  const { workspace } = seed(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agents (id,workspace_id,name,provider,status,max_concurrent_tasks,created_at)
    VALUES ('agent',?,'测试执行器','kimi','idle',1,?)`).run(workspace.id, now);
  db.prepare(`INSERT INTO issues (id,workspace_id,title,status,priority,creator_type,creator_id,position,created_at,updated_at)
    VALUES ('issue',?,'合入测试','in_review','medium','member','owner',0,?,?)`).run(workspace.id, now, now);
  const insert = db.prepare(`INSERT INTO tasks
    (id,workspace_id,issue_id,agent_id,status,created_at,complete_payload_hash,complete_response_json,result_json)
    VALUES (?,?,'issue','agent','completed',?,'原始请求摘要','{"ok":true}','{"branch":"task/saved"}')`);
  for (const id of ["task-1", "task-2", "task-3"]) insert.run(id, workspace.id, now);
}

function intent(overrides: Partial<IntegrationIntent> = {}): IntegrationIntent {
  return {
    task_id: "task-1",
    repo_key: "repository-1",
    repo_path: "D:\\测试仓库",
    repo_common_dir: "D:\\测试仓库\\.git",
    repo_dev: "18446744073709551615",
    repo_ino: "9007199254740993123",
    task_branch: "task/saved",
    target_branch: "main",
    task_head: TASK_HEAD,
    target_head: TARGET_HEAD,
    ...overrides,
  };
}

afterEach(() => {
  for (const db of connections.splice(0)) if (db.$client.open) db.$client.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("T01 合入操作持久化", () => {
  it("跨数据库连接守卫同 Task 与同仓库，并无损保存文件身份", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "anvil-integration-"));
    directories.push(directory);
    const dbPath = path.join(directory, "fixture.db");
    const first = open(dbPath);
    fixture(first);
    const second = open(dbPath);
    const acquired = reserveIntegrationAttempt(first, { ...intent(), intent_hash: "不可信摘要" } as IntegrationIntent);
    expect(acquired.acquired).toBe(true);
    expect(acquired.conflict).toBeNull();
    expect(acquired.attempt).toMatchObject({ ...intent(), intent_hash: canonicalJsonHash(intent()), status: "prepared", merge_commit: null, error: null });
    expect(findIntegrationAttempt(second, "task-1")).toEqual(acquired.attempt);

    const repeat = reserveIntegrationAttempt(second, intent({ repo_key: "different-key", task_head: "d".repeat(40) }));
    expect(repeat).toEqual({ acquired: false, conflict: "task", attempt: acquired.attempt });
    const conflict = reserveIntegrationAttempt(second, intent({ task_id: "task-2" }));
    expect(conflict).toEqual({ acquired: false, conflict: "repository", attempt: acquired.attempt });
    expect(findIntegrationAttempt(first, "task-2")).toBeUndefined();
    expect(reserveIntegrationAttempt(second, intent({ task_id: "task-3", repo_key: "repository-2" })).acquired).toBe(true);
  });

  it("数据库唯一约束拒绝绕过服务插入的同 Task 和活动仓库冲突", () => {
    const db = open();
    fixture(db);
    reserveIntegrationAttempt(db, intent());
    const duplicate = db.prepare(`INSERT INTO integration_attempts
      (id,task_id,repo_key,repo_path,repo_common_dir,repo_dev,repo_ino,task_branch,target_branch,task_head,target_head,intent_hash,status,created_at,updated_at)
      SELECT ?,?,?,repo_path,repo_common_dir,repo_dev,repo_ino,task_branch,target_branch,task_head,target_head,intent_hash,status,created_at,updated_at
      FROM integration_attempts WHERE task_id='task-1'`);
    expect(() => duplicate.run("another-id", "task-1", "repository-2")).toThrow(/UNIQUE constraint failed: integration_attempts.task_id/);
    expect(() => duplicate.run("another-id", "task-2", "repository-1")).toThrow(/UNIQUE constraint failed: integration_attempts.repo_key/);
    expect(() => duplicate.run("another-id", "missing-task", "repository-2")).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => db.prepare("UPDATE integration_attempts SET status='unknown' WHERE task_id='task-1'").run()).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare("UPDATE integration_attempts SET status='completed' WHERE task_id='task-1'").run()).toThrow(/CHECK constraint failed/);
  });

  it.each(["prepared", "local_merged", "recovery_required"] as const)("%s 在数据库重开后仍阻止重新合入", (status) => {
    const directory = mkdtempSync(path.join(tmpdir(), "anvil-integration-restart-"));
    directories.push(directory);
    const dbPath = path.join(directory, "fixture.db");
    const original = open(dbPath);
    fixture(original);
    const { attempt } = reserveIntegrationAttempt(original, intent());
    if (status === "local_merged") setIntegrationLocalMerged(original, attempt.id, MERGE_HEAD);
    if (status === "recovery_required") requireIntegrationRecovery(original, attempt.id, "远端结果未知");
    const before = findIntegrationAttempt(original, "task-1");
    original.$client.close();
    const reopened = open(dbPath);
    expect(findIntegrationAttempt(reopened, "task-1")).toEqual(before);
    expect(reserveIntegrationAttempt(reopened, intent({ repo_key: "new-key" })))
      .toEqual({ acquired: false, conflict: "task", attempt: before });
    expect(reserveIntegrationAttempt(reopened, intent({ task_id: "task-2" })).conflict).toBe("repository");
  });

  it("完成释放仓库占用但永久保留 Task 守卫，重放不再执行回调", () => {
    const db = open();
    fixture(db);
    const { attempt } = reserveIntegrationAttempt(db, intent());
    const merged = setIntegrationLocalMerged(db, attempt.id, MERGE_HEAD);
    expect(merged).toMatchObject({ status: "local_merged", merge_commit: MERGE_HEAD });
    const onComplete = vi.fn(() => { db.prepare("UPDATE issues SET status='done' WHERE id='issue'").run(); });
    const completed = completeIntegrationAttempt(db, attempt.id, onComplete);
    expect(completed.status).toBe("completed");
    expect(db.prepare("SELECT status FROM issues WHERE id='issue'").get()).toEqual({ status: "done" });
    expect(completeIntegrationAttempt(db, attempt.id, onComplete)).toEqual(completed);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(reserveIntegrationAttempt(db, intent({ repo_key: "repository-2" })).conflict).toBe("task");
    expect(reserveIntegrationAttempt(db, intent({ task_id: "task-2" })).acquired).toBe(true);
    expect(db.prepare("SELECT complete_payload_hash,complete_response_json,result_json FROM tasks WHERE id='task-1'").get())
      .toEqual({ complete_payload_hash: "原始请求摘要", complete_response_json: '{"ok":true}', result_json: '{"branch":"task/saved"}' });
  });

  it("回调后段写入失败时，完成状态和业务写入一并回滚且保留仓库占用", () => {
    const db = open();
    fixture(db);
    const { attempt } = reserveIntegrationAttempt(db, intent());
    setIntegrationLocalMerged(db, attempt.id, MERGE_HEAD);
    const before = findIntegrationAttempt(db, "task-1");
    db.$client.exec(`CREATE TRIGGER reject_completion_comment BEFORE INSERT ON comments
      BEGIN SELECT RAISE(ABORT, '故障注入：评论保存失败'); END;`);
    expect(() => completeIntegrationAttempt(db, attempt.id, () => {
      db.prepare("UPDATE issues SET status='done' WHERE id='issue'").run();
      db.prepare(`INSERT INTO comments (id,issue_id,author_type,author_id,body,created_at)
        VALUES ('comment','issue','member','owner','已合入',?)`).run(new Date().toISOString());
    })).toThrow("故障注入：评论保存失败");
    expect(findIntegrationAttempt(db, "task-1")).toEqual(before);
    expect(db.prepare("SELECT status FROM issues WHERE id='issue'").get()).toEqual({ status: "in_review" });
    expect(reserveIntegrationAttempt(db, intent({ task_id: "task-2" })).conflict).toBe("repository");
    db.$client.exec("DROP TRIGGER reject_completion_comment");
    expect(completeIntegrationAttempt(db, attempt.id, () => {}).status).toBe("completed");
  });

  it.each(["prepared", "recovery_required"] as const)("%s 不能完成或执行完成回调", (status) => {
    const db = open();
    fixture(db);
    const { attempt } = reserveIntegrationAttempt(db, intent());
    if (status === "recovery_required") requireIntegrationRecovery(db, attempt.id, "合入结果未知");
    const onComplete = vi.fn();
    expect(() => completeIntegrationAttempt(db, attempt.id, onComplete)).toThrow("只有已确认本地合入的操作可以完成");
    expect(onComplete).not.toHaveBeenCalled();
    expect(findIntegrationAttempt(db, "task-1")?.status).toBe(status);
  });

  it("本地结果只能从 prepared 写入，恢复状态及完成结果不可覆盖", () => {
    const db = open();
    fixture(db);
    const first = reserveIntegrationAttempt(db, intent()).attempt;
    expect(() => setIntegrationLocalMerged(db, first.id, "short-sha")).toThrow("合入提交必须是完整 SHA");
    setIntegrationLocalMerged(db, first.id, MERGE_HEAD);
    expect(() => setIntegrationLocalMerged(db, first.id, "d".repeat(40))).toThrow("只有准备中的操作可以记录本地合入");
    const recovery = requireIntegrationRecovery(db, first.id, "推送失败");
    expect(recovery.merge_commit).toBe(MERGE_HEAD);
    expect(() => setIntegrationLocalMerged(db, first.id, "d".repeat(40))).toThrow("只有准备中的操作可以记录本地合入");
    const other = reserveIntegrationAttempt(db, intent({ task_id: "task-2", repo_key: "repository-2" })).attempt;
    setIntegrationLocalMerged(db, other.id, MERGE_HEAD);
    completeIntegrationAttempt(db, other.id, () => {});
    expect(() => requireIntegrationRecovery(db, other.id, "迟到错误")).toThrow("已完成的合入操作不能改为待恢复");
    expect(() => completeIntegrationAttempt(db, "missing", () => {})).toThrow("合入操作不存在");
  });

  it("错误先脱敏再按 UTF-8 字节截断，保留原始合入 SHA", () => {
    const db = open();
    fixture(db);
    const { attempt } = reserveIntegrationAttempt(db, intent());
    setIntegrationLocalMerged(db, attempt.id, MERGE_HEAD);
    const error = "anv_fake_secret atk_fake_secret Authorization: Bearer fake/credential+=\n"
      + "https://user:fake-password@example.test/repo.git ghp_fakeGithubToken github_pat_fakeGithubPat\n"
      + "Authorization: Basic ZmFrZTpmYWtl\n" + "诊断🙂".repeat(2000);
    const recovered = requireIntegrationRecovery(db, attempt.id, error);
    expect(recovered.status).toBe("recovery_required");
    expect(recovered.merge_commit).toBe(MERGE_HEAD);
    expect(recovered.error).toContain("https://[REDACTED]@example.test/repo.git");
    expect(recovered.error).toContain("Bearer [REDACTED]");
    expect(recovered.error).toContain("Basic [REDACTED]");
    expect(recovered.error).toMatch(/…（已截断）$/);
    expect(recovered.error).not.toContain("�");
    for (const secret of ["fake_secret", "fake/credential", "fake-password", "fakeGithub", "ZmFrZTpmYWtl"]) {
      expect(recovered.error).not.toContain(secret);
    }
    expect(Buffer.byteLength(recovered.error!, "utf8")).toBeLessThanOrEqual(MAX_INTEGRATION_ERROR_BYTES);
    expect(findIntegrationAttempt(db, "task-1")).toEqual(recovered);
  });
});
