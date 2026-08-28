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

describe("db · 0003 P0-A 证据迁移", () => {
  it("0003 新表均已创建", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[];
    const names = tables.map((t) => t.name);
    for (const t of ["task_delivery_reports", "verification_runs", "verification_checks", "review_measurements"]) {
      expect(names).toContain(t);
    }
  });

  it("tasks 新增字段全部存在", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string; dflt_value: string | null; notnull: number }[];
    const map = Object.fromEntries(cols.map((c) => [c.name, c]));
    for (const col of [
      "delivery_contract_version", "task_branch", "target_branch", "base_commit",
      "head_commit", "worktree_clean", "verification_status", "verification_run_id",
      "start_payload_hash", "start_response_json",
      "complete_payload_hash", "complete_response_json",
      "fail_payload_hash", "fail_response_json",
    ]) {
      expect(map[col]).toBeDefined();
    }
    // delivery_contract_version 是 NOT NULL,且有默认值 1(允许历史 v1 兼容)
    expect(map.delivery_contract_version.notnull).toBe(1);
    expect(map.delivery_contract_version.dflt_value).toBe("1");
    // 其他字段允许为空
    for (const col of ["task_branch", "target_branch", "base_commit", "head_commit", "worktree_clean", "verification_status", "verification_run_id"]) {
      expect(map[col].notnull).toBe(0);
    }
  });

  it("tasks_one_pending_per_issue 部分唯一索引仍存在", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const idx = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name='tasks_one_pending_per_issue'`).get() as any;
    expect(idx).toBeDefined();
    expect(String(idx.sql)).toMatch(/WHERE status IN \('queued','dispatched'\)/);
  });

  it("verification_runs 包含 (task_id, created_at) 索引", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='verification_runs'`).all() as any[];
    expect(idx.map((i: any) => i.name)).toContain("verification_runs_task_id_created_at");
  });

  it("verification_checks 包含 (run_id, seq) 与 (run_id, check_id) 两个唯一约束", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='verification_checks'`).all() as any[];
    const names: string[] = idx.map((i: any) => i.name);
    expect(names).toContain("verification_checks_run_id_seq_unique");
    expect(names).toContain("verification_checks_run_id_check_id_unique");
  });

  it("task_delivery_reports.task_id 是 PRIMARY KEY(主键自带唯一性,不另建冗余唯一索引)", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(task_delivery_reports)`).all() as { name: string; pk: number; notnull: number }[];
    const taskIdCol = cols.find((c) => c.name === "task_id");
    expect(taskIdCol).toBeDefined();
    expect(taskIdCol!.pk).toBe(1);
    expect(taskIdCol!.notnull).toBe(1);
    // 不存在 task_delivery_reports_task_id_unique 这类冗余唯一索引
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_delivery_reports'`).all() as { name: string }[];
    expect(idx.map((i) => i.name).some((n) => /task_id/.test(n))).toBe(false);
  });

  it("review_measurements.task_id 是主键(也是 FK)", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(review_measurements)`).all() as any[];
    const pk = cols.find((c: any) => c.name === "task_id");
    expect(pk).toBeDefined();
    expect(pk.pk).toBe(1);
  });

  it("tasks(issue_id, delivery_contract_version, created_at) 索引存在且列顺序正确", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const idx = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name='tasks_issue_contract_created'`).get() as { name: string; sql: string } | undefined;
    expect(idx).toBeDefined();
    // 索引列顺序必须是 issue_id, delivery_contract_version, created_at
    expect(idx!.sql).toMatch(/CREATE INDEX `?tasks_issue_contract_created`? ON `?tasks`? \(`?issue_id`?,`?delivery_contract_version`?,`?created_at`?\)/);
    // 普通索引(不是 UNIQUE)
    expect(idx!.sql).not.toMatch(/UNIQUE INDEX/);
  });

  it("FK 真实存在:tasks.verification_run_id → verification_runs.id", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    // 试插一条 task,verification_run_id 指向不存在的 run,应当失败
    const { workspace } = seed(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agents (id, workspace_id, name, provider, status, max_concurrent_tasks, created_at)
                VALUES ('a1', ?, 'bot', 'kimi', 'idle', 1, ?)`).run(workspace.id, now);
    db.prepare(`INSERT INTO issues (id, workspace_id, title, status, priority, creator_type, creator_id, position, created_at, updated_at)
                VALUES ('i1', ?, 't', 'todo', 'medium', 'member', 'u', 1, ?, ?)`).run(workspace.id, now, now);
    expect(() => db.prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts, verification_run_id, created_at)
                             VALUES ('t1', ?, 'i1', 'a1', 'queued', 20, 1, 3, 'no-such-run', ?)`)
      .run(workspace.id, now)).toThrow();
  });

  it("0003 不引入 continuation_mode / review_decision / integration_attempt / improvement_candidate", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as any[];
    const names: string[] = tables.map((t: any) => t.name);
    for (const banned of ["continuation_modes", "review_decisions", "integration_attempts", "improvement_candidates"]) {
      expect(names).not.toContain(banned);
    }
    // tasks 表也不应有 continuation_mode 列
    const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as any[];
    const taskColNames: string[] = taskCols.map((c: any) => c.name);
    expect(taskColNames).not.toContain("continuation_mode");
  });
});
