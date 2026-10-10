import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, runMigrations, seed } from "../src/db/client.js";
import { readR2Inventory } from "../src/ops/r2-inventory.js";

const since = "2026-01-01T00:00:00.000Z";
const completed = "2026-01-01T00:01:00.000Z";
const started = "2026-01-01T00:02:00.000Z";
const recorded = "2026-01-01T00:03:00.000Z";
const base = "a".repeat(40), head = "b".repeat(40);
let dir: string, file: string, sqlite: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "anvil-r2-inventory-"));
  file = path.join(dir, "anvil.db");
  const db = createDb(file);
  runMigrations(db);
  const { workspace, user } = seed(db);
  sqlite = db.$client;
  sqlite.prepare("INSERT INTO agents (id,workspace_id,name,provider,created_at) VALUES ('agent',?,'盘点','kimi',?)").run(workspace.id, since);
  sqlite.prepare(`INSERT INTO issues (id,workspace_id,title,creator_type,creator_id,created_at,updated_at)
    VALUES ('issue',?,'不能导出的任务正文','member',?,?,?)`).run(workspace.id, user.id, since, since);
  sqlite.prepare(`INSERT INTO tasks (id,workspace_id,issue_id,agent_id,status,delivery_contract_version,
    created_at,completed_at,delivered_at,base_commit,head_commit,worktree_clean,verification_status,result_json)
    VALUES ('task',?,'issue','agent','completed',2,?,?,?,?,?,1,'passed','{}')`).run(workspace.id, since, completed, completed, base, head);
  sqlite.prepare(`INSERT INTO task_delivery_reports (task_id,schema_version,report_head_commit,
    problem_understanding,solution_summary,changed_areas_json,risks_json,unresolved_json,submitted_at,updated_at)
    VALUES ('task',1,?,'不能导出的报告正文','方案','[]','[]','[]',?,?)`).run(head, completed, completed);
  sqlite.prepare(`INSERT INTO verification_runs (id,task_id,schema_version,policy_source,policy_hash,base_commit,
    verification_sha,status,started_at,completed_at,created_at)
    VALUES ('run','task',1,'ANVIL.verify.json',?,?,?,'passed',?,?,?)`).run("c".repeat(64), base, head, since, completed, completed);
  sqlite.exec("UPDATE tasks SET verification_run_id='run'");
  sqlite.prepare(`INSERT INTO verification_checks (id,verification_run_id,seq,check_id,label,command,
    required,status,exit_code,duration_ms,output_excerpt) VALUES ('check','run',0,'tests','测试',?,1,'passed',0,100,'不能导出的日志')`
  ).run("echo sensitive-command");
  sqlite.prepare(`INSERT INTO review_measurements (task_id,ui_version,review_started_at,active_review_ms,
    opened_transcript,opened_full_diff,recorded_at) VALUES ('task','legacy',?,10000,1,0,?)`).run(started, recorded);
});
afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("R2 只读盘点", () => {
  it("汇总当前周期样本但始终保留人工门，不输出明细或业务正文", () => {
    const result = readR2Inventory(file, since);
    expect(result).toMatchObject({ r2_gate: "pending_human_review", database_schema: "v2", v2_completed_since: 1,
      legacy_measurements_since: { candidate_count: 1, excluded_or_invalid_count: 0 }, selected_tasks: [] });
    expect(JSON.stringify(result)).not.toContain("不能导出");
  });
  it("按明确 Task ID 输出 SHA/退出码，命令只输出摘要，未知 ID 不扩大读取范围", () => {
    const result = readR2Inventory(file, since, ["task", "' OR 1=1 --"]);
    expect(result.selected_tasks[0]).toMatchObject({ task_id: "task", availability: "available",
      task: { base_commit: base, head_commit: head }, report: { report_head_commit: head },
      verification: { task_id: "task", verification_sha: head }, measurement_candidate: true,
      checks: [{ exit_code: 0, command_sha256: createHash("sha256").update("echo sensitive-command").digest("hex") }] });
    expect(result.selected_tasks[1]).toEqual({ task_id: "' OR 1=1 --", availability: "not_found" });
    expect(JSON.stringify(result)).not.toMatch(/不能导出|sensitive-command|task_token|password|output_excerpt/);
  });
  it("v1 Task 仍可提供本期 legacy UI 基线", () => {
    sqlite.exec("UPDATE tasks SET delivery_contract_version=1");
    expect(readR2Inventory(file, since)).toMatchObject({ v2_completed_since: 0, legacy_measurements_since: { candidate_count: 1 } });
  });
  it("较早创建的任务不能靠新测量回填为本期样本", () => {
    sqlite.exec("UPDATE tasks SET created_at='2025-12-31T00:00:00.000Z'");
    expect(readR2Inventory(file, since)).toMatchObject({ v2_completed_since: 0, legacy_measurements_since: { candidate_count: 0 } });
  });
  it.each([
    ["null 时间", "UPDATE review_measurements SET review_started_at=NULL,active_review_ms=NULL"],
    ["负时长", "UPDATE review_measurements SET active_review_ms=-1"],
    ["小数时长", "UPDATE review_measurements SET active_review_ms=1.5"],
    ["过大时长", "UPDATE review_measurements SET active_review_ms=60001"],
    ["无日志", "UPDATE review_measurements SET opened_transcript=0"],
    ["非法布尔", "UPDATE review_measurements SET opened_full_diff=2"],
    ["任务未完成", "UPDATE tasks SET status='running'"],
    ["晚于录入", "UPDATE review_measurements SET review_started_at='2026-01-01T00:04:00.000Z'"],
    ["未来录入", "UPDATE review_measurements SET recorded_at='2999-01-01T00:00:00.000Z'"],
    ["完成前开始", "UPDATE review_measurements SET review_started_at='2026-01-01T00:00:30.000Z'"],
    ["非法日期", "UPDATE review_measurements SET review_started_at='not-a-date'"],
    ["独立失效标记", `UPDATE tasks SET result_json='{"review_measurement_excluded":true}'`],
    ["坏结果 JSON", "UPDATE tasks SET result_json='broken'"],
  ])("排除 %s，保留原始证据供复查", (_label, sql) => {
    sqlite.exec(sql);
    expect(readR2Inventory(file, since).legacy_measurements_since).toEqual({ candidate_count: 0, excluded_or_invalid_count: 1 });
  });
  it("新 UI 记录不会混入 legacy 基线", () => {
    sqlite.exec("UPDATE review_measurements SET ui_version='v2'");
    expect(readR2Inventory(file, since).legacy_measurements_since).toEqual({ candidate_count: 0, excluded_or_invalid_count: 0 });
  });
  it("旧库不迁移、不补写字段，未知统计为 null", () => {
    const oldFile = path.join(dir, "old.db");
    const old = new Database(oldFile);
    old.exec("CREATE TABLE tasks(id TEXT,status TEXT); INSERT INTO tasks VALUES ('old','completed')");
    old.close();
    const before = readFileSync(oldFile);
    expect(readR2Inventory(oldFile, since, ["old"])).toMatchObject({ database_schema: "legacy_or_incomplete",
      v2_completed_since: null, legacy_measurements_since: null, selected_tasks: [{ availability: "schema_unavailable" }] });
    expect(readFileSync(oldFile)).toEqual(before);
  });
  it("缺失数据库不能被创建，非法采集时间和过量选择直接拒绝", () => {
    const missing = path.join(dir, "missing.db");
    expect(() => readR2Inventory(missing, since)).toThrow();
    expect(existsSync(missing)).toBe(false);
    for (const value of ["yesterday", "2999-01-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z"]) {
      expect(() => readR2Inventory(file, value)).toThrow();
    }
    expect(() => readR2Inventory(file, since, Array(21).fill("task"))).toThrow();
  });
  it("盘点不改变已迁移数据库的业务行或 schema", () => {
    const before = sqlite.serialize();
    readR2Inventory(file, since, ["task"]);
    expect(sqlite.serialize()).toEqual(before);
  });
});
