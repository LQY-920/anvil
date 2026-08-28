// apps/server/test/task-version.test.ts
//
// A02 + A02-FIX · v2 Task 创建语义 + 自动重试 + 证据表关系 + Task 协议字段 + 真实升级测试。
//
// 覆盖:
// - 公共入口 insertQueuedTask 显式写 delivery_contract_version=2
// - 评论接力 / rerun 走 insertQueuedTask,版本同样 =2
// - failTaskInternal 自动重试子 Task 显式 v2
// - 自动重试可继承父 Task 的 target_branch / base_commit;为 null 时继续为 null
// - 自动重试不复制父 Task 的 head_commit / verification_status / verification_run_id /
//   任何 payload hash 或 response JSON
// - 失败 partial unique index 冲突时 insertQueuedTask 返回 null(已有 pending)
// - task_delivery_reports 1 per task(PRIMARY KEY task_id)
// - verification_runs 1-to-many from task
// - verification_checks (run_id, seq) 唯一
// - verification_checks (run_id, check_id) 唯一
// - review_measurements 1 per task(支持 upsert 幂等更新)
// - 外键指向不存在的 Task / Run 失败
// - Task 协议真实包含 A02 字段(无需 as any)
// - getTask 归一化 worktree_clean:0/1 → boolean,null 保持 null
// - 真实升级:从 0000、0001、0002 状态分别升级到 0003,历史 Task data 不丢,
//   version=1,新表/索引存在,FK check 通过

import { describe, it, expect, beforeEach } from "vitest";
import { createDb, runMigrations, seed } from "../src/db/client.js";
import { enqueueForComment, enqueueForIssue, getIssue, listTasksForIssue } from "../src/services/issues.js";
import { claimTasks, failTaskInternal, getTask } from "../src/services/tasks.js";
import { DELIVERY_CONTRACT_CURRENT_VERSION } from "@anvil/core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function setup(): { db: ReturnType<typeof createDb>; workspaceId: string; userId: string; agentId: string; now: string } {
  const db = createDb(":memory:");
  runMigrations(db);
  const { workspace, user } = seed(db);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agents (id, workspace_id, name, provider, status, max_concurrent_tasks, created_at)
              VALUES (?, ?, 'bot', 'kimi', 'idle', 3, ?)`).run("a1", workspace.id, now);
  return { db, workspaceId: workspace.id, userId: user.id, agentId: "a1", now };
}

function makeActiveIssue(db: ReturnType<typeof createDb>, workspaceId: string, id: string, agentId: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO issues (id, workspace_id, title, status, priority, creator_type, creator_id, position, created_at, updated_at)
              VALUES (?, ?, 't', 'todo', 'medium', 'member', 'u', 1, ?, ?)`).run(id, workspaceId, now, now);
  db.prepare(`UPDATE issues SET assignee_type='agent', assignee_id=? WHERE id=?`).run(agentId, id);
  return getIssue(db, id)!;
}

describe("insertQueuedTask writes delivery_contract_version explicitly", () => {
  // Task 来自 @anvil/core 是 A01 锁定的 v1 形状,不含 A02 字段;用 raw SQL 读真实落库值
  function taskVersion(db: ReturnType<typeof createDb>, id: string): number {
    const row = db.prepare(`SELECT delivery_contract_version FROM tasks WHERE id=?`).get(id) as any;
    return row.delivery_contract_version;
  }

  it("Issue 指派 agent 触发的 enqueueForIssue 写 v2", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i1", agentId);
    const task = enqueueForIssue(db, issue, "issue-create")!;
    expect(task).not.toBeNull();
    expect(taskVersion(db, task.id)).toBe(DELIVERY_CONTRACT_CURRENT_VERSION);
    expect(taskVersion(db, task.id)).toBe(2);
  });

  it("Issue 更新触发 enqueueForIssue 写 v2", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i2", agentId);
    const task = enqueueForIssue(db, issue, "issue-update")!;
    expect(taskVersion(db, task.id)).toBe(2);
  });

  it("评论接力的 enqueueForComment 写 v2", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i3", agentId);
    const r = enqueueForComment(db, issue);
    expect(r.enqueued).toBe(true);
    if (r.enqueued) {
      expect(taskVersion(db, r.task.id)).toBe(2);
    }
  });

  it("rerun 走 enqueueForIssue 写 v2", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i4", agentId);
    // 先创建一个 task,然后完成,再 rerun(走 enqueueForIssue)
    const t1 = enqueueForIssue(db, issue, "first")!;
    db.prepare(`UPDATE tasks SET status='completed' WHERE id=?`).run(t1.id);
    const t2 = enqueueForIssue(db, issue, "rerun")!;
    expect(taskVersion(db, t2.id)).toBe(2);
  });

  it("not 不依赖 DB 默认值:即使 delivery_contract_version default 是 1,新 Task 也必须是 2", () => {
    const { db, workspaceId, agentId } = setup();
    // 直接观察 DB 默认值
    const defStmt = db.$client.prepare(`SELECT 1 FROM pragma_table_info('tasks') WHERE name='delivery_contract_version' AND dflt_value='1'`);
    const hasDefault1 = defStmt.get() !== undefined;
    expect(hasDefault1).toBe(true);  // default 1 是历史兼容,允许存在
    // 但新 task 必须显式写 2
    const issue = makeActiveIssue(db, workspaceId, "i5", agentId);
    const t = enqueueForIssue(db, issue, "default-test")!;
    expect(taskVersion(db, t.id)).toBe(2);
  });
});

describe("insertQueuedTask partial unique index semantics", () => {
  it("同 issue 已有 pending 时,insertQueuedTask 返回 null(第二个 task 不入队)", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i6", agentId);
    const t1 = enqueueForIssue(db, issue, "first")!;
    expect(t1).not.toBeNull();
    // 同 issue 还在 queued,rerun 触发 insertQueuedTask 应该返回 null
    const t2 = enqueueForIssue(db, issue, "second");
    expect(t2).toBeNull();
    // listTasksForIssue 仍只有一条
    expect(listTasksForIssue(db, issue.id)).toHaveLength(1);
  });

  it("评论接力在已有 pending 时返回 merged_into_pending", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i7", agentId);
    enqueueForIssue(db, issue, "first");
    const r = enqueueForComment(db, issue);
    expect(r.enqueued).toBe(false);
    if (!r.enqueued) expect(r.reason).toBe("merged_into_pending");
  });
});

describe("failTaskInternal auto-retry writes v2 with allowed inheritance", () => {
  it("自动重试子 Task 是 v2 且 attempt 递增", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i8", agentId);
    const parent = enqueueForIssue(db, issue, "first")!;
    // 让父 Task 走完 dispatched → running
    db.prepare(`UPDATE tasks SET status='dispatched' WHERE id=?`).run(parent.id);
    db.prepare(`UPDATE tasks SET status='running' WHERE id=?`).run(parent.id);
    failTaskInternal(db, parent.id, "non_zero_exit", "tests failed", null);
    const childs = db.prepare(`SELECT * FROM tasks WHERE parent_task_id=?`).all(parent.id) as any[];
    expect(childs).toHaveLength(1);
    expect(childs[0].delivery_contract_version).toBe(2);
    expect(childs[0].attempt).toBe(2);
  });

  it("自动重试继承父 Task 的 target_branch / base_commit(若已存在)", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i9", agentId);
    const parent = enqueueForIssue(db, issue, "first")!;
    // 模拟父 Task 已经 start,target/base 已写入
    db.prepare(`UPDATE tasks SET status='running', target_branch=?, base_commit=?, head_commit=?, worktree_clean=1 WHERE id=?`)
      .run("main", "a".repeat(40), "b".repeat(40), parent.id);
    failTaskInternal(db, parent.id, "non_zero_exit", "x", null);
    const child = db.prepare(`SELECT * FROM tasks WHERE parent_task_id=?`).get(parent.id) as any;
    expect(child.target_branch).toBe("main");
    expect(child.base_commit).toBe("a".repeat(40));
  });

  it("父 Task 无 target/base 时,子 Task 继续为 null", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i10", agentId);
    const parent = enqueueForIssue(db, issue, "first")!;
    failTaskInternal(db, parent.id, "non_zero_exit", "x", null);
    const child = db.prepare(`SELECT * FROM tasks WHERE parent_task_id=?`).get(parent.id) as any;
    expect(child.target_branch).toBeNull();
    expect(child.base_commit).toBeNull();
  });

  it("自动重试不复制父 Task 的 head_commit / verification_status / verification_run_id / payload hash / response json", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i11", agentId);
    const parent = enqueueForIssue(db, issue, "first")!;
    // 先插一个真实的 verification_run,让 verification_run_id 引用合法
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO verification_runs
      (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
      VALUES ('run-x', ?, 1, 'ANVIL.verify.json', ?, 'passed', ?, ?)`)
      .run(parent.id, "0".repeat(40), now, now);
    // 给父 Task "涂满" 各种"已完成证据"
    db.prepare(`UPDATE tasks SET status='running', head_commit=?, worktree_clean=1,
                                    verification_status='passed', verification_run_id='run-x',
                                    start_payload_hash='h1', start_response_json='{"a":1}',
                                    complete_payload_hash='h2', complete_response_json='{"b":2}',
                                    fail_payload_hash='h3', fail_response_json='{"c":3}' WHERE id=?`)
      .run("c".repeat(40), parent.id);
    failTaskInternal(db, parent.id, "non_zero_exit", "x", null);
    const child = db.prepare(`SELECT * FROM tasks WHERE parent_task_id=?`).get(parent.id) as any;
    // 全部必须为 null —— 不能把"已完成证据"当新 Task 已完成状态
    expect(child.head_commit).toBeNull();
    expect(child.verification_status).toBeNull();
    expect(child.verification_run_id).toBeNull();
    expect(child.start_payload_hash).toBeNull();
    expect(child.start_response_json).toBeNull();
    expect(child.complete_payload_hash).toBeNull();
    expect(child.complete_response_json).toBeNull();
    expect(child.fail_payload_hash).toBeNull();
    expect(child.fail_response_json).toBeNull();
    expect(child.task_branch).toBeNull();
    expect(child.worktree_clean).toBeNull();
  });
});

// ============================================================================
// 证据表数据关系
// ============================================================================

describe("task_delivery_reports — one per task", () => {
  it("同一 task 重复 INSERT 触发 UNIQUE 失败", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i12", agentId);
    const t = enqueueForIssue(db, issue, "first")!;
    const ins = db.prepare(`INSERT INTO task_delivery_reports
      (task_id, schema_version, report_head_commit, problem_understanding, solution_summary,
       changed_areas_json, risks_json, unresolved_json, submitted_at, updated_at)
      VALUES (?, 1, ?, 'p', 's', '[]', '[]', '[]', ?, ?)`);
    const headSha = "0".repeat(40);
    const now = new Date().toISOString();
    ins.run(t.id, headSha, now, now);
    expect(() => ins.run(t.id, headSha, now, now)).toThrow();
  });

  it("FK 指向不存在的 task 失败", () => {
    const { db } = setup();
    const now = new Date().toISOString();
    expect(() => db.prepare(`INSERT INTO task_delivery_reports
      (task_id, schema_version, report_head_commit, problem_understanding, solution_summary,
       changed_areas_json, risks_json, unresolved_json, submitted_at, updated_at)
      VALUES ('no-such-task', 1, ?, 'p', 's', '[]', '[]', '[]', ?, ?)`)
      .run("0".repeat(40), now, now)).toThrow();
  });
});

describe("verification_runs + verification_checks", () => {
  it("一个 task 可以有多条 verification_runs", () => {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "i13", agentId);
    const t = enqueueForIssue(db, issue, "first")!;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO verification_runs
      (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
      VALUES (?, ?, 1, 'ANVIL.verify.json', ?, 'passed', ?, ?)`)
      .run("r1", t.id, "0".repeat(40), now, now);
    db.prepare(`INSERT INTO verification_runs
      (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
      VALUES (?, ?, 1, 'none', ?, 'not_configured', ?, ?)`)
      .run("r2", t.id, "0".repeat(40), now, now);
    const runs = db.prepare(`SELECT id FROM verification_runs WHERE task_id=? ORDER BY created_at`).all(t.id) as any[];
    expect(runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("(run_id, seq) 唯一:重复 seq 失败", () => {
    const { db, workspaceId, agentId } = setup();
    const t = enqueueForIssue(db, makeActiveIssue(db, workspaceId, "i14", agentId), "first")!;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO verification_runs
      (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
      VALUES ('r1', ?, 1, 'ANVIL.verify.json', ?, 'passed', ?, ?)`)
      .run(t.id, "0".repeat(40), now, now);
    const ins = db.prepare(`INSERT INTO verification_checks
      (id, verification_run_id, seq, check_id, label, command, required, status, duration_ms)
      VALUES (?, ?, ?, 'c', 'L', 'cmd', 1, 'passed', 1000)`);
    ins.run("chk1", "r1", 1);
    expect(() => ins.run("chk2", "r1", 1)).toThrow();
  });

  it("(run_id, check_id) 唯一:重复 check_id 失败", () => {
    const { db, workspaceId, agentId } = setup();
    const t = enqueueForIssue(db, makeActiveIssue(db, workspaceId, "i15", agentId), "first")!;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO verification_runs
      (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
      VALUES ('r1', ?, 1, 'ANVIL.verify.json', ?, 'passed', ?, ?)`)
      .run(t.id, "0".repeat(40), now, now);
    const ins = db.prepare(`INSERT INTO verification_checks
      (id, verification_run_id, seq, check_id, label, command, required, status, duration_ms)
      VALUES (?, ?, ?, 'same', 'L', 'cmd', 1, 'passed', 1000)`);
    ins.run("chk1", "r1", 1);
    expect(() => ins.run("chk2", "r1", 2)).toThrow();
  });

  it("同一 (run_id) 允许不同 seq + check_id", () => {
    const { db, workspaceId, agentId } = setup();
    const t = enqueueForIssue(db, makeActiveIssue(db, workspaceId, "i16", agentId), "first")!;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO verification_runs
      (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
      VALUES ('r1', ?, 1, 'ANVIL.verify.json', ?, 'passed', ?, ?)`)
      .run(t.id, "0".repeat(40), now, now);
    const ins = db.prepare(`INSERT INTO verification_checks
      (id, verification_run_id, seq, check_id, label, command, required, status, duration_ms)
      VALUES (?, ?, ?, ?, 'L', 'cmd', 1, 'passed', 1000)`);
    ins.run("chk1", "r1", 1, "tests");
    ins.run("chk2", "r1", 2, "build");
    const n = db.prepare(`SELECT COUNT(*) AS n FROM verification_checks WHERE verification_run_id='r1'`).get() as any;
    expect(n.n).toBe(2);
  });

  it("FK 指向不存在的 verification_run 失败", () => {
    const { db } = setup();
    expect(() => db.prepare(`INSERT INTO verification_checks
      (id, verification_run_id, seq, check_id, label, command, required, status, duration_ms)
      VALUES ('chk1', 'no-such-run', 1, 'c', 'L', 'cmd', 1, 'passed', 1000)`).run()).toThrow();
  });

  it("FK verification_runs 指向不存在的 task 失败", () => {
    const { db } = setup();
    const now = new Date().toISOString();
    expect(() => db.prepare(`INSERT INTO verification_runs
      (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
      VALUES ('r1', 'no-such-task', 1, 'ANVIL.verify.json', ?, 'passed', ?, ?)`)
      .run("0".repeat(40), now, now)).toThrow();
  });
});

describe("review_measurements — one per task, upsert idempotent", () => {
  it("同一 task 重复 INSERT OR REPLACE 覆盖,保留最新记录", () => {
    const { db, workspaceId, agentId } = setup();
    const t = enqueueForIssue(db, makeActiveIssue(db, workspaceId, "i17", agentId), "first")!;
    const now = new Date().toISOString();
    const upsert = db.prepare(`INSERT OR REPLACE INTO review_measurements
      (task_id, ui_version, review_started_at, active_review_ms, opened_transcript, opened_full_diff, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    upsert.run(t.id, "legacy", null, 1000, 0, 0, now);
    upsert.run(t.id, "legacy", now, 2500, 1, 0, now);
    const m = db.prepare(`SELECT * FROM review_measurements WHERE task_id=?`).get(t.id) as any;
    expect(m.active_review_ms).toBe(2500);
    expect(m.opened_transcript).toBe(1);
  });

  it("不同 task 各自独立", () => {
    const { db, workspaceId, agentId } = setup();
    const t1 = enqueueForIssue(db, makeActiveIssue(db, workspaceId, "i18a", agentId), "x")!;
    const t2 = enqueueForIssue(db, makeActiveIssue(db, workspaceId, "i18b", agentId), "x")!;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO review_measurements
      (task_id, ui_version, opened_transcript, opened_full_diff, recorded_at)
      VALUES (?, 'v2', 0, 0, ?)`).run(t1.id, now);
    db.prepare(`INSERT INTO review_measurements
      (task_id, ui_version, opened_transcript, opened_full_diff, recorded_at)
      VALUES (?, 'legacy', 0, 0, ?)`).run(t2.id, now);
    // task_id 是 UUID,排序无意义;用 ui_version DESC 让 v2 排在前面
    const rows = db.prepare(`SELECT task_id, ui_version FROM review_measurements ORDER BY ui_version DESC`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].ui_version).toBe("v2");
    expect(rows[1].ui_version).toBe("legacy");
    // 两个 task_id 不同
    expect(rows[0].task_id).not.toBe(rows[1].task_id);
  });

  it("FK 指向不存在的 task 失败", () => {
    const { db } = setup();
    const now = new Date().toISOString();
    expect(() => db.prepare(`INSERT INTO review_measurements
      (task_id, ui_version, opened_transcript, opened_full_diff, recorded_at)
      VALUES ('no-such-task', 'v2', 0, 0, ?)`).run(now)).toThrow();
  });
});

// ============================================================================
// 历史 DB 真实升级测试
//
// 流程:用 OS 临时目录 + 截断的 _journal.json 构造停在 0000 / 0001 / 0002 的"历史库",
// 在 :memory: 上用 Drizzle migrate 跑这一部分,然后插入历史 Task,再调用项目完整
// runMigrations 跑完 0003,断言历史数据保留、version=1、schema 完整、FK check 通过。
// ============================================================================

const REAL_MIGRATIONS_DIR = "D:/anvil/apps/server/drizzle";

/** 构造一个临时目录,只包含 0000-000X 的真实 SQL + 截断的 _journal.json。 */
function makePartialMigrationDir(upToIdx: number): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "anvil-a02fix-"));
  const realJournal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_DIR, "meta/_journal.json"), "utf8"));
  const realEntries: { idx: number; tag: string; when: number; version: string; breakpoints: boolean }[] = realJournal.entries;
  for (const e of realEntries) {
    if (e.idx <= upToIdx) {
      const sqlFile = `${e.tag}.sql`;
      copyFileSync(join(REAL_MIGRATIONS_DIR, sqlFile), join(dir, sqlFile));
    }
  }
  const truncated = {
    ...realJournal,
    entries: realEntries.filter((e) => e.idx <= upToIdx),
  };
  mkdirSync(join(dir, "meta"), { recursive: true });
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(truncated, null, 2));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function insertHistoricalTask(db: ReturnType<typeof createDb>, taskId: string, issueId: string, workspaceId: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agents (id, workspace_id, name, provider, status, max_concurrent_tasks, created_at)
              VALUES ('a1', ?, 'bot', 'kimi', 'idle', 1, ?)`).run(workspaceId, now);
  db.prepare(`INSERT INTO issues (id, workspace_id, title, status, priority, creator_type, creator_id, position, created_at, updated_at)
              VALUES (?, ?, '历史 issue', 'done', 'medium', 'member', 'u', 1, ?, ?)`)
    .run(issueId, workspaceId, now, now);
  // 历史 v1 Task 不包含 delivery_contract_version / task_branch / 等 A02 字段
  // 也不包含 delivered_at(那是 0002 加的),但 0002 已经在了;id 用稳定可识别字符串。
  db.prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts, result_json, created_at)
              VALUES (?, ?, ?, 'a1', 'completed', 20, 1, 3, ?, ?)`)
    .run(taskId, workspaceId, issueId, JSON.stringify({ branch: "task/hist", diff_stat: "1 file changed" }), now);
}

describe("migration upgrades from historical DB (real partial migrations)", () => {
  it.each([0, 1, 2])("从 0000/0001/0002 状态升级到 0003:历史 Task data 不丢,version=1 (from upToIdx=%i)", (upToIdx) => {
    const { dir, cleanup } = makePartialMigrationDir(upToIdx);
    try {
      const db = createDb(":memory:");
      // 用 Drizzle migrate 在临时目录上跑 0000..000upToIdx
      migrate(db, { migrationsFolder: dir });
      // 拿到 workspace(用 seed 也行,seed 不会写 delivery_contract_version,旧 schema 上不报错)
      const { workspace } = seed(db);
      // 插入历史 v1 Task(老 schema,没有 A02 字段)
      const histId = `t-hist-from-${upToIdx}`;
      const issueId = `i-hist-from-${upToIdx}`;
      insertHistoricalTask(db, histId, issueId, workspace.id);
      // 升级:用项目完整 runMigrations 跑 0003(0000/0001/0002 已应用,drizzle 跳过)
      runMigrations(db);
      // 1. 历史 Task 还在,id / status / result_json / attempt / max_attempts 原数据保留
      const hist = db.prepare(`SELECT * FROM tasks WHERE id=?`).get(histId) as any;
      expect(hist).toBeDefined();
      expect(hist.id).toBe(histId);
      expect(hist.status).toBe("completed");
      expect(hist.attempt).toBe(1);
      expect(hist.max_attempts).toBe(3);
      expect(JSON.parse(hist.result_json)).toEqual({ branch: "task/hist", diff_stat: "1 file changed" });
      // 2. delivery_contract_version 精确 = 1(由 0003 ALTER ADD with DEFAULT 1)
      expect(hist.delivery_contract_version).toBe(1);
      // 3. 其他 v2 字段为 null(start 前允许为空)
      expect(hist.task_branch).toBeNull();
      expect(hist.target_branch).toBeNull();
      expect(hist.base_commit).toBeNull();
      expect(hist.head_commit).toBeNull();
      expect(hist.worktree_clean).toBeNull();
      expect(hist.verification_status).toBeNull();
      expect(hist.verification_run_id).toBeNull();
      // 4. 0003 四张新表均存在
      for (const t of ["task_delivery_reports", "verification_runs", "verification_checks", "review_measurements"]) {
        const found = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
        expect(found).toBeDefined();
      }
      // 5. tasks_one_pending_per_issue 仍存在
      const partial = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_one_pending_per_issue'`).get();
      expect(partial).toBeDefined();
      // 6. tasks_issue_contract_created 索引存在且列顺序正确
      const contractIdx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='tasks_issue_contract_created'`).get() as { sql: string } | undefined;
      expect(contractIdx).toBeDefined();
      expect(contractIdx!.sql).toMatch(/issue_id.*delivery_contract_version.*created_at/);
      // 7. PRAGMA foreign_key_check 返回空数组(无 FK 违规)
      const fkViolations = db.prepare(`PRAGMA foreign_key_check`).all();
      expect(fkViolations).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("应用启动后 runMigrations 重复执行幂等(没有错误 / 重复数据)", () => {
    const db = createDb(":memory:");
    runMigrations(db);
    runMigrations(db);
    runMigrations(db);
    // migrate 不会插入数据;seed 没跑,所以 workspaces 是 0 行(不是 1)
    const n = db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).get() as any;
    expect(n.n).toBe(0);
    // schema 完整,关键表/索引都存在
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`).all() as any[];
    expect(tables.map((t) => t.name)).toContain("tasks");
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_one_pending_per_issue'`).all() as any[];
    expect(idx).toHaveLength(1);
  });
});

// ============================================================================
// Task 协议字段 + getTask 归一化
// ============================================================================

describe("getTask normalizes worktree_clean and exposes A02 fields", () => {
  function setupTaskWithWorktree(value: number | null): { db: ReturnType<typeof createDb>; taskId: string } {
    const { db, workspaceId, agentId } = setup();
    const issue = makeActiveIssue(db, workspaceId, "iwt", agentId);
    const task = enqueueForIssue(db, issue, "x")!;
    db.prepare(`UPDATE tasks SET worktree_clean=? WHERE id=?`).run(value, task.id);
    return { db, taskId: task.id };
  }

  it("worktree_clean=1 归一化为 true", () => {
    const { db, taskId } = setupTaskWithWorktree(1);
    const t = getTask(db, taskId);
    expect(t).not.toBeNull();
    expect(t!.worktree_clean).toBe(true);
  });

  it("worktree_clean=0 归一化为 false", () => {
    const { db, taskId } = setupTaskWithWorktree(0);
    const t = getTask(db, taskId);
    expect(t!.worktree_clean).toBe(false);
  });

  it("worktree_clean=null 保持 null", () => {
    const { db, taskId } = setupTaskWithWorktree(null);
    const t = getTask(db, taskId);
    expect(t!.worktree_clean).toBeNull();
  });

  it("getTask 返回的 Task 协议直接包含 A02 字段,无需 as any", () => {
    const { db, taskId } = setupTaskWithWorktree(1);
    const t = getTask(db, taskId)!;
    // 直接访问 A02 字段,TypeScript 不需要任何 cast
    expect(t.delivery_contract_version).toBe(DELIVERY_CONTRACT_CURRENT_VERSION);
    expect(t.task_branch).toBeNull();
    expect(t.target_branch).toBeNull();
    expect(t.base_commit).toBeNull();
    expect(t.head_commit).toBeNull();
    expect(t.worktree_clean).toBe(true);
    expect(t.verification_status).toBeNull();
    expect(t.verification_run_id).toBeNull();
    expect(t.start_payload_hash).toBeNull();
    expect(t.start_response_json).toBeNull();
    expect(t.complete_payload_hash).toBeNull();
    expect(t.complete_response_json).toBeNull();
    expect(t.fail_payload_hash).toBeNull();
    expect(t.fail_response_json).toBeNull();
  });
});

describe("claimTasks TaskPackage.task exposes A02 fields without as any", () => {
  /** 建立一个 workspace + agent + online runtime 准备 claim 的 db。 */
  function setupClaimable(): { db: ReturnType<typeof createDb>; workspaceId: string; agentId: string; issueId: string; taskId: string } {
    const ctx = setup();
    const now = new Date().toISOString();
    ctx.db.prepare(`INSERT INTO runtimes (id, workspace_id, daemon_id, provider, version, status, last_seen_at)
                    VALUES ('rt1', ?, 'daemon-1', 'kimi', '1.0', 'online', ?)`)
      .run(ctx.workspaceId, now);
    const issue = makeActiveIssue(ctx.db, ctx.workspaceId, "iclaim", ctx.agentId);
    const task = enqueueForIssue(ctx.db, issue, "first")!;
    return { db: ctx.db, workspaceId: ctx.workspaceId, agentId: ctx.agentId, issueId: issue.id, taskId: task.id };
  }

  it("claimTasks 返回的 Task 可以直接访问 delivery_contract_version / target_branch / base_commit / worktree_clean", () => {
    const { db, workspaceId, taskId } = setupClaimable();
    const packages = claimTasks(db, workspaceId, "daemon-1", 1);
    expect(packages).toHaveLength(1);
    const pkg = packages[0];
    // 直接访问 A02 字段,TypeScript 不需要任何 cast
    expect(pkg.task.id).toBe(taskId);
    expect(pkg.task.delivery_contract_version).toBe(DELIVERY_CONTRACT_CURRENT_VERSION);
    expect(pkg.task.task_branch).toBeNull();
    expect(pkg.task.target_branch).toBeNull();
    expect(pkg.task.base_commit).toBeNull();
    expect(pkg.task.head_commit).toBeNull();
    expect(pkg.task.worktree_clean).toBeNull();
    expect(pkg.task.verification_status).toBeNull();
    expect(pkg.task.verification_run_id).toBeNull();
  });

  it("claimTasks 返回的 task 携带 worktree_clean 归一化结果(0/1 各自正确)", () => {
    const { db, workspaceId, taskId } = setupClaimable();
    db.prepare(`UPDATE tasks SET worktree_clean=1 WHERE id=?`).run(taskId);
    const packages = claimTasks(db, workspaceId, "daemon-1", 1);
    expect(packages).toHaveLength(1);
    expect(packages[0].task.worktree_clean).toBe(true);
  });
});
