import { describe, it, expect } from "vitest";
import { createDb, runMigrations, seed } from "../src/db/client.js";

describe("db", () => {
  it("migrates and seeds idempotently", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const s1 = seed(db);
    const s2 = seed(db);
    expect(s1.workspace.id).toBe(s2.workspace.id);
    expect(s1.user.id).toBe(s2.user.id);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const t of ["workspaces","users","workspace_members","issues","tasks","task_messages","comments","agents","runtimes","daemon_tokens","skills","skill_files","agent_skills"]) {
      expect(names).toContain(t);
    }
    const wm = db.prepare("SELECT COUNT(*) AS n FROM workspace_members").get() as any;
    expect(wm.n).toBe(1);
  });

  it("enforces one pending task per issue via partial unique index", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const { workspace } = seed(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agents (id, workspace_id, name, provider, status, max_concurrent_tasks, created_at)
                VALUES ('a1', ?, 'bot', 'kimi', 'idle', 1, ?)`).run(workspace.id, now);
    db.prepare(`INSERT INTO issues (id, workspace_id, title, status, priority, creator_type, creator_id, position, created_at, updated_at)
                VALUES ('i1', ?, 't', 'todo', 'medium', 'member', 'u', 1, ?, ?)`).run(workspace.id, now, now);
    const ins = db.prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts, created_at)
                            VALUES (?, ?, 'i1', 'a1', 'queued', 20, 1, 3, ?)`);
    ins.run("t1", workspace.id, now);
    expect(() => ins.run("t2", workspace.id, now)).toThrow();
    db.prepare(`UPDATE tasks SET status='completed' WHERE id='t1'`).run();
    ins.run("t3", workspace.id, now);
  });
});
