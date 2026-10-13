import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, runMigrations, seed, type Db } from "../src/db/client.js";

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const now = "2026-10-13T12:00:00.000Z";

function seedHistorical(db: Db): string {
  const { workspace } = seed(db);
  db.prepare(`INSERT INTO agents (id,workspace_id,name,provider,status,max_concurrent_tasks,created_at)
    VALUES ('agent',?,'旧执行器','kimi','idle',1,?)`).run(workspace.id, now);
  db.prepare(`INSERT INTO issues (id,workspace_id,title,status,priority,creator_type,creator_id,position,created_at,updated_at)
    VALUES ('issue',?,'旧任务','in_review','medium','member','owner',0,?,?)`).run(workspace.id, now, now);
  for (const [id, version] of [["v1", 1], ["v2", 2], ["other", 2]] as const) {
    db.prepare(`INSERT INTO tasks
      (id,workspace_id,issue_id,agent_id,status,delivery_contract_version,result_json,complete_payload_hash,complete_response_json,created_at)
      VALUES (?,?,'issue','agent','completed',?,'{"branch":"task/saved"}','原始摘要','{"ok":true}',?)`).run(id, workspace.id, version, now);
  }
  return workspace.id;
}

function insertRepository(db: Db, workspaceId: string, id: string, externalId: string): void {
  db.prepare(`INSERT INTO repositories
    (id,workspace_id,mode,host,external_id,full_name,clone_url,target_branch,checkout_path,identity_json,connection_status,created_at,updated_at)
    VALUES (?,?,'github_pr','github.com',?,'owner/repo','https://github.com/owner/repo.git','main','D:/repo',?,'connected',?,?)`)
    .run(id, workspaceId, externalId, JSON.stringify({ real_path: "D:/repo/.git", dev: "9007199254740993", ino: "18446744073709551615" }), now, now);
}

describe("T01 Repository / 来源 / 裁决迁移", () => {
  it("真实 0004 旧库升级保留任务和 S1 恢复事实，不伪造身份、Decision 或 PR", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "anvil-repository-migration-"));
    const db = createDb(":memory:");
    try {
      const journal = JSON.parse(readFileSync(path.join(migrations, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
      const entries = journal.entries.filter(entry => entry.idx <= 4);
      mkdirSync(path.join(directory, "meta"));
      for (const entry of entries) copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
      writeFileSync(path.join(directory, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
      migrate(db, { migrationsFolder: directory });
      seedHistorical(db);
      db.prepare(`INSERT INTO integration_attempts
        (id,task_id,repo_key,repo_path,repo_common_dir,repo_dev,repo_ino,task_branch,target_branch,task_head,target_head,intent_hash,status,merge_commit,error,created_at,updated_at)
        VALUES ('attempt','v2','key','D:/repo','D:/repo/.git','1','2','task/saved','main',?,?,'意图摘要','recovery_required',?,'推送结果未知',?,?)`)
        .run("a".repeat(40), "b".repeat(40), "c".repeat(40), now, now);
      db.prepare(`INSERT INTO task_delivery_reports
        (task_id,schema_version,report_head_commit,problem_understanding,solution_summary,changed_areas_json,risks_json,unresolved_json,submitted_at,updated_at)
        VALUES ('v2',1,?,'原始问题','原始报告','[]','[]','[]',?,?)`).run("a".repeat(40), now, now);
      db.prepare(`INSERT INTO review_measurements
        (task_id,ui_version,review_started_at,active_review_ms,opened_transcript,opened_full_diff,recorded_at)
        VALUES ('v2','legacy',NULL,NULL,1,1,?)`).run(now);
      const beforeTasks = db.prepare("SELECT * FROM tasks ORDER BY id").all();
      const beforeIssues = db.prepare("SELECT * FROM issues ORDER BY id").all();
      const beforeAttempts = db.prepare("SELECT * FROM integration_attempts").all();
      const beforeReports = db.prepare("SELECT * FROM task_delivery_reports").all();
      const beforeMeasurements = db.prepare("SELECT * FROM review_measurements").all();

      runMigrations(db);
      runMigrations(db);
      const afterTasks = db.prepare("SELECT * FROM tasks ORDER BY id").all() as Record<string, unknown>[];
      expect(afterTasks.map(({ repository_id, repository_snapshot_json, source_snapshot_id, ...legacy }) => {
        expect([repository_id, repository_snapshot_json, source_snapshot_id]).toEqual([null, null, null]);
        return legacy;
      })).toEqual(beforeTasks);
      const afterIssues = db.prepare("SELECT * FROM issues ORDER BY id").all() as Record<string, unknown>[];
      expect(afterIssues.map(({ repository_id, source_snapshot_id, ...legacy }) => {
        expect([repository_id, source_snapshot_id]).toEqual([null, null]);
        return legacy;
      })).toEqual(beforeIssues);
      expect(db.prepare("SELECT * FROM integration_attempts").all()).toEqual(beforeAttempts);
      expect(db.prepare("SELECT * FROM task_delivery_reports").all()).toEqual(beforeReports);
      expect(db.prepare("SELECT * FROM review_measurements").all()).toEqual(beforeMeasurements);
      for (const table of ["repositories", "source_snapshots", "external_issues", "review_decisions", "delivery_operations", "pull_request_links"]) {
        expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("数据库守卫稳定仓库身份、来源去重、单 Task Decision 与活动操作", () => {
    const db = createDb(":memory:");
    try {
      runMigrations(db);
      const workspaceId = seedHistorical(db);
      insertRepository(db, workspaceId, "repo", "external-repo");
      expect(() => insertRepository(db, workspaceId, "duplicate", "external-repo")).toThrow(/UNIQUE constraint failed/);
      const repository = db.prepare("SELECT version,sync_failures,can_push FROM repositories WHERE id='repo'").get();
      expect(repository).toEqual({ version: 1, sync_failures: 0, can_push: 0 });
      const source = db.prepare(`INSERT INTO source_snapshots
        (id,repository_id,external_id,issue_number,url,title,body,state,source_updated_at,hash,created_at)
        VALUES (?,'repo','external-issue',1,'url','标题','正文','open',?,'内容摘要',?)`);
      source.run("source", now, now);
      expect(() => source.run("duplicate-source", now, now)).toThrow(/UNIQUE constraint failed/);
      const external = db.prepare(`INSERT INTO external_issues
        (repository_id,external_id,local_issue_id,issue_number,url,accepted_snapshot_id,latest_snapshot_id)
        VALUES ('repo',?,'issue',1,'url','source','source')`);
      external.run("external-issue");
      expect(() => external.run("another-external")).toThrow(/UNIQUE constraint failed/);
      const decision = db.prepare(`INSERT INTO review_decisions
        (id,task_id,repository_id,actor_id,result,reason,head_commit,evidence_version,request_key,payload_hash,snapshot_json,created_at)
        VALUES (?,'v2','repo','owner','approved','已审查',?,'版本','请求键','摘要','{}',?)`);
      decision.run("decision", "a".repeat(40), now);
      expect(() => decision.run("duplicate-decision", "a".repeat(40), now)).toThrow(/UNIQUE constraint failed/);
      const operation = db.prepare(`INSERT INTO delivery_operations
        (id,task_id,repository_id,decision_id,action,state,expected_head,request_key,payload_hash,intent_json,created_at,updated_at)
        VALUES (?,'v2','repo','decision','pull_request',?,?,?,'摘要','{}',?,?)`);
      operation.run("operation", "prepared", "a".repeat(40), "key-1", now, now);
      expect(() => operation.run("duplicate-active", "unknown", "a".repeat(40), "key-2", now, now)).toThrow(/UNIQUE constraint failed/);
      db.prepare("UPDATE delivery_operations SET state='failed' WHERE id='operation'").run();
      expect(() => operation.run("duplicate-key", "prepared", "a".repeat(40), "key-1", now, now)).toThrow(/UNIQUE constraint failed/);
      operation.run("retry", "unknown", "a".repeat(40), "key-2", now, now);
      expect(() => db.prepare("UPDATE tasks SET source_snapshot_id='missing-source' WHERE id='v1'").run()).toThrow(/FOREIGN KEY constraint failed/);
      expect(() => db.prepare("UPDATE issues SET repository_id='missing-repo' WHERE id='issue'").run()).toThrow(/FOREIGN KEY constraint failed/);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.$client.close(); }
  });

  it("一个 Task 只有一个 PR 关联，但多个 Task 可关联同一远端 PR", () => {
    const db = createDb(":memory:");
    try {
      runMigrations(db);
      insertRepository(db, seedHistorical(db), "repo", "external-repo");
      const insert = db.prepare(`INSERT INTO pull_request_links
        (id,repository_id,task_id,external_id,number,url,head_ref,head_sha,base_ref,state,last_synced_at)
        VALUES (?,'repo',?,'external-pr',9,'url','task/shared',?,'main','open',?)`);
      insert.run("pr-1", "v1", "a".repeat(40), now);
      insert.run("pr-2", "v2", "a".repeat(40), now);
      expect(() => insert.run("pr-3", "v1", "a".repeat(40), now)).toThrow(/UNIQUE constraint failed/);
      expect(db.prepare("SELECT checks_json FROM pull_request_links").all()).toEqual([{ checks_json: "[]" }, { checks_json: "[]" }]);
    } finally { db.$client.close(); }
  });
});
