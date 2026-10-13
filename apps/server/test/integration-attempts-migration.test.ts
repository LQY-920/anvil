import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, runMigrations, seed } from "../src/db/client.js";

const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

describe("T01 0004 旧库升级", () => {
  it("从真实 0003 迁移保留 v1/v2 任务、报告与测量，不回填操作且重复迁移幂等", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "anvil-integration-migration-"));
    const db = createDb(":memory:");
    try {
      const journal = JSON.parse(readFileSync(path.join(migrations, "meta", "_journal.json"), "utf8")) as {
        entries: { idx: number; tag: string }[];
      };
      const entries = journal.entries.filter(entry => entry.idx <= 3);
      mkdirSync(path.join(directory, "meta"));
      for (const entry of entries) copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(directory, `${entry.tag}.sql`));
      writeFileSync(path.join(directory, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
      migrate(db, { migrationsFolder: directory });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='integration_attempts'").get()).toBeUndefined();

      const { workspace } = seed(db);
      const now = "2026-10-13T00:00:00.000Z";
      db.prepare(`INSERT INTO agents (id,workspace_id,name,provider,status,max_concurrent_tasks,created_at)
        VALUES ('agent',?,'历史执行器','kimi','idle',1,?)`).run(workspace.id, now);
      db.prepare(`INSERT INTO issues (id,workspace_id,title,status,priority,creator_type,creator_id,position,created_at,updated_at)
        VALUES ('issue',?,'历史任务','in_review','medium','member','owner',0,?,?)`).run(workspace.id, now, now);
      db.prepare(`INSERT INTO tasks (id,workspace_id,issue_id,agent_id,status,result_json,created_at)
        VALUES ('v1',?,'issue','agent','completed','{"branch":"task/legacy"}',?)`).run(workspace.id, now);
      db.prepare(`INSERT INTO tasks
        (id,workspace_id,issue_id,agent_id,status,delivery_contract_version,task_branch,target_branch,base_commit,head_commit,complete_payload_hash,complete_response_json,created_at)
        VALUES ('v2',?,'issue','agent','completed',2,'task/fixed','main',?,?,'历史摘要','{"ok":true}',?)`)
        .run(workspace.id, "a".repeat(40), "b".repeat(40), now);
      db.prepare(`INSERT INTO task_delivery_reports
        (task_id,schema_version,report_head_commit,problem_understanding,solution_summary,changed_areas_json,risks_json,unresolved_json,submitted_at,updated_at)
        VALUES ('v2',1,?,'问题','方案','[]','[]','[]',?,?)`).run("b".repeat(40), now, now);
      db.prepare(`INSERT INTO review_measurements
        (task_id,ui_version,review_started_at,active_review_ms,opened_transcript,opened_full_diff,recorded_at)
        VALUES ('v2','legacy',NULL,NULL,1,0,?)`).run(now);
      const beforeTasks = db.prepare("SELECT * FROM tasks ORDER BY id").all();
      const beforeReports = db.prepare("SELECT * FROM task_delivery_reports").all();
      const beforeMeasurements = db.prepare("SELECT * FROM review_measurements").all();

      runMigrations(db);
      runMigrations(db);
      const migratedTasks = db.prepare("SELECT * FROM tasks ORDER BY id").all() as Record<string, unknown>[];
      expect(migratedTasks.map(({ repository_id, repository_snapshot_json, source_snapshot_id, ...legacy }) => {
        expect([repository_id, repository_snapshot_json, source_snapshot_id]).toEqual([null, null, null]);
        return legacy;
      })).toEqual(beforeTasks);
      expect(db.prepare("SELECT * FROM task_delivery_reports").all()).toEqual(beforeReports);
      expect(db.prepare("SELECT * FROM review_measurements").all()).toEqual(beforeMeasurements);
      expect(db.prepare("SELECT * FROM integration_attempts").all()).toEqual([]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const indexes = db.prepare("PRAGMA index_list(integration_attempts)").all() as { name: string; unique: number; partial: number }[];
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "integration_attempts_task_id_unique", unique: 1, partial: 0 }),
        expect.objectContaining({ name: "integration_attempts_active_repo_unique", unique: 1, partial: 1 }),
      ]));
      const foreignKeys = db.prepare("PRAGMA foreign_key_list(integration_attempts)").all();
      expect(foreignKeys).toEqual(expect.arrayContaining([expect.objectContaining({ table: "tasks", from: "task_id", to: "id" })]));
    } finally {
      db.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
