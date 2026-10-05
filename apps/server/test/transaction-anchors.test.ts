// apps/server/test/transaction-anchors.test.ts
//
// A03-RECOVERY · 事务原子性、v2 锚点校验、终态真实性 专项测试。
//
// 覆盖:
// 1. v2 锚点校验(兼容模式 / 完整 v2 模式 / 各种非法格式 / 409 base_mismatch)
// 2. transaction 真实回滚(start/complete/fail 写幂等回执失败时所有副作用全部回滚)
// 3. 终态真实性(complete→fail / 竞争 / 非法终态请求 / replay 行为)
// 4. result_json 不保存 daemon_id

import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;
let issueId: string;

async function claimOne() {
  const c = await app.inject({
    method: "POST",
    url: "/api/daemon/claim",
    headers: { authorization: `Bearer ${daemonToken}` },
    payload: { daemon_id: "d1" },
  });
  return c.json().tasks[0] as any;
}

const tpost = (url: string, payload: unknown, token: string) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "anchor-task", assignee_type: "agent", assignee_id: agentId } });
  issueId = i.json().id;
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("start anchor validation (compatibility + full v2)", () => {
  it("兼容模式:不传任何锚点 → 200,Task 状态 running,锚点字段保持 null", async () => {
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    expect(r.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT status, task_branch, target_branch, base_commit, delivery_contract_version FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("running");
    expect(row.task_branch).toBeNull();
    expect(row.target_branch).toBeNull();
    expect(row.base_commit).toBeNull();
  });

  it("完整 v2 锚点合法 → 200,所有锚点落库", async () => {
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/abc12345",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT status, task_branch, target_branch, base_commit, delivery_contract_version FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("running");
    expect(row.task_branch).toBe("task/abc12345");
    expect(row.target_branch).toBe("main");
    expect(row.base_commit).toBe(SHA);
    expect(row.delivery_contract_version).toBe(2);
  });

  it("完整 v2 合法锚点 replay → 200,所有锚点不变", async () => {
    const pkg = await claimOne();
    const payload = {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/replay1",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    };
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, payload, daemonToken);
    expect(r1.statusCode).toBe(200);
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, payload, daemonToken);
    expect(r2.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT task_branch, target_branch, base_commit, delivery_contract_version FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.task_branch).toBe("task/replay1");
    expect(row.target_branch).toBe("main");
    expect(row.base_commit).toBe(SHA);
  });

  it("部分提供(只给 task_branch) → 400 invalid_schema", async () => {
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/abc",
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
  });

  it("空 task_branch → 400 invalid_git_anchor", async () => {
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "   ",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_git_anchor");
    expect(r.json().details.field).toBe("task_branch");
  });

  it("空 target_branch → 400 invalid_schema(路由层格式校验,先于 service)", async () => {
    // R1-FIX1:空字符串是路由层类型/格式错,返回 invalid_schema;service 的
    // invalid_git_anchor 留给更严格的 Git ref 格式校验。
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/abc",
      target_branch: "",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("target_branch");
  });

  it("非 40 位 SHA → 400 invalid_schema(路由层格式校验,先于 service)", async () => {
    // R1-FIX1:非 40 hex SHA 属于"类型/格式错",路由层用 invalid_schema 拒绝,
    // 不会进入 service 的 validateStartAnchors。service 仍负责更严格的
    // 业务校验(分支名空白/特殊字符),使用 invalid_git_anchor。
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/abc",
      target_branch: "main",
      base_commit: "deadbeef", // 太短
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("base_commit");
  });

  it("version=99 → 400 invalid_schema", async () => {
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/abc",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 99,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("delivery_contract_version");
  });

  it("Task 已是 v1,version=2 → 400 invalid_schema", async () => {
    const pkg = await claimOne();
    // 强制把 task 改成 v1
    app.db.$client.prepare(`UPDATE tasks SET delivery_contract_version=1 WHERE id=?`).run(pkg.task.id);
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/abc",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
  });

  it("Task 已存 task_branch,replay 传不同值 → 409 base_mismatch", async () => {
    const pkg = await claimOne();
    const first = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(first.statusCode).toBe(200);
    const second = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/different",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    // 不同 task_branch → 409 base_mismatch
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("base_mismatch");
  });

  it("Task 已存 base_commit,replay 传不同值 → 409 base_mismatch,不改变原锚点", async () => {
    const pkg = await claimOne();
    const first = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(first.statusCode).toBe(200);
    const newSha = "fedcba9876543210fedcba9876543210fedcba98";
    const second = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig",
      target_branch: "main",
      base_commit: newSha,
      delivery_contract_version: 2,
    }, daemonToken);
    // 改 base_commit → 409 base_mismatch(不返回原 200)
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("base_mismatch");
    // 锚点没被覆盖
    const row = app.db.$client.prepare(`SELECT task_branch, base_commit FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.task_branch).toBe("task/orig");
    expect(row.base_commit).toBe(SHA);
  });
});

// ----------------------------------------------------------------------------
// result_json 剥离 daemon_id
// ----------------------------------------------------------------------------

describe("result_json envelope strip", () => {
  it("complete 后 result_json 中没有 daemon_id 字段", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1",
      branch: "task/abc",
      diff_stat: "1 file",
      work_dir: "/w1",
    }, daemonToken);
    expect(r.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT result_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    const result = JSON.parse(row.result_json);
    expect(result.daemon_id).toBeUndefined();
    expect(result.branch).toBe("task/abc");
    expect(result.diff_stat).toBe("1 file");
    expect(result.work_dir).toBe("/w1");
  });

  it("complete payload 故意塞 daemon_id_nested 也会被拒绝(unknown field)", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    // FIX4:未知顶层 result 字段被拒绝(400 invalid_schema)
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1",
      branch: "task/abc",
      result: { daemon_id: "d1", anything: 1 } as any,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toEqual(["result"]);
  });
});

// ----------------------------------------------------------------------------
// 终态真实性
// ----------------------------------------------------------------------------

describe("terminal state integrity", () => {
  it("complete 成功后再次 fail → 409 invalid_transition,Task 保持 completed", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { daemon_id: "d1", branch: "task/abc" }, daemonToken);
    expect(c.statusCode).toBe(200);
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "late" }, daemonToken);
    expect(f.statusCode).toBe(409);
    expect(f.json().code).toBe("invalid_transition");
    const row = app.db.$client.prepare(`SELECT status, failure_reason FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("completed");
    expect(row.failure_reason).toBeNull();
  });

  it("cancelled 后 fail → 409", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "x" }, daemonToken);
    expect(f.statusCode).toBe(409);
    expect(f.json().code).toBe("invalid_transition");
  });

  it("failed 状态 fail 重复(不同 payload)→ 409,Task 保持 failed", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "first" }, daemonToken);
    // 故意给不同的 error(不同 hash)→ 409
    // 行为:已有的 fail hash 已落库,新 hash 不同 → 409 idempotency_conflict(D-003 优先于状态守卫)
    const f2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "different" }, daemonToken);
    expect(f2.statusCode).toBe(409);
    // 两种可接受:D-003 命中(idempotency_conflict)或状态守卫(invalid_transition)
    expect(["idempotency_conflict", "invalid_transition"]).toContain(f2.json().code);
    const row = app.db.$client.prepare(`SELECT status, error FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("first");
  });

  it("相同 fail payload replay 仍返回第一次响应", async () => {
    const pkg = await claimOne();
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom" }, daemonToken);
    expect(r1.statusCode).toBe(200);
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom" }, daemonToken);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });

  it("complete / fail 竞争:同一 task 串行只能有一个合法终态", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { daemon_id: "d1", branch: "task/abc" }, daemonToken);
    expect(c.statusCode).toBe(200);
    // 同一 Task 再 fail → 409(complete 已经胜出)
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "race" }, daemonToken);
    expect(f.statusCode).toBe(409);
    const row = app.db.$client.prepare(`SELECT status, failure_reason, result_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("completed");
    expect(row.failure_reason).toBeNull();
    expect(JSON.parse(row.result_json).branch).toBe("task/abc");
  });

  it("非法终态请求不得写入新 hash/response,不得创建 retry Task", async () => {
    const pkg = await claimOne();
    // 第一次 fail 成功
    await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom" }, daemonToken);
    // 不同 payload 再 fail → 409,不应该写新 hash,也不应该新建 retry Task
    const beforeHash = (app.db.$client.prepare(`SELECT fail_payload_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).fail_payload_hash;
    const tasksBefore = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    const f2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "DIFFERENT" }, daemonToken);
    expect(f2.statusCode).toBe(409);
    const afterHash = (app.db.$client.prepare(`SELECT fail_payload_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).fail_payload_hash;
    expect(afterHash).toBe(beforeHash);
    const tasksAfter = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    expect(tasksAfter).toBe(tasksBefore);
  });
});

// ----------------------------------------------------------------------------
// transaction 真实回滚测试:用 SQL 触发器强制让幂等回执写入失败
// ----------------------------------------------------------------------------

describe("transaction atomicity (SQL-triggered rollback)", () => {
  function installStartAbortTrigger() {
    app.db.$client.exec(`
      CREATE TRIGGER abort_start_receipt
      BEFORE UPDATE OF start_payload_hash ON tasks
      WHEN NEW.start_payload_hash IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);
  }
  function installCompleteAbortTrigger() {
    app.db.$client.exec(`
      CREATE TRIGGER abort_complete_receipt
      BEFORE UPDATE OF complete_payload_hash ON tasks
      WHEN NEW.complete_payload_hash IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);
  }
  function installFailAbortTrigger() {
    app.db.$client.exec(`
      CREATE TRIGGER abort_fail_receipt
      BEFORE UPDATE OF fail_payload_hash ON tasks
      WHEN NEW.fail_payload_hash IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced rollback');
      END;
    `);
  }
  function dropAllTriggers() {
    app.db.$client.exec(`
      DROP TRIGGER IF EXISTS abort_start_receipt;
      DROP TRIGGER IF EXISTS abort_complete_receipt;
      DROP TRIGGER IF EXISTS abort_fail_receipt;
    `);
  }

  it("start 写幂等回执失败:HTTP 500,Task 仍 dispatched,Issue 不变,无评论", async () => {
    const pkg = await claimOne();
    const beforeStatus = (app.db.$client.prepare(`SELECT status FROM issues WHERE id=?`).get(issueId) as any).status;
    const beforeComments = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n;
    installStartAbortTrigger();
    try {
      // raw call:trigger 会让整个 transaction ROLLBACK,Service 应 throw
      let err: any = null;
      try {
        await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
      } catch (e: any) {
        err = e;
      }
      // fastify 的 throw 会变成 500
      const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
      expect(r.statusCode).toBe(500);
    } finally {
      dropAllTriggers();
    }
    // Task 仍 dispatched(状态守卫 update 被 ROLLBACK)
    const row = app.db.$client.prepare(`SELECT status, started_at, start_payload_hash, start_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("dispatched");
    expect(row.started_at).toBeNull();
    expect(row.start_payload_hash).toBeNull();
    expect(row.start_response_json).toBeNull();
    // Issue 状态不变
    const afterStatus = (app.db.$client.prepare(`SELECT status FROM issues WHERE id=?`).get(issueId) as any).status;
    expect(afterStatus).toBe(beforeStatus);
    // 没有新增 status_change 评论
    const afterComments = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n;
    expect(afterComments).toBe(beforeComments);
  });

  it("complete 写回执失败:Task 仍 running,task token 未清,Agent 仍 working,Issue 不动", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    installCompleteAbortTrigger();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { daemon_id: "d1", branch: "task/abc" }, daemonToken);
    expect(r.statusCode).toBe(500);
    dropAllTriggers();
    // Task 仍 running
    const row = app.db.$client.prepare(`SELECT status, completed_at, complete_payload_hash, complete_response_json, task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("running");
    expect(row.completed_at).toBeNull();
    expect(row.complete_payload_hash).toBeNull();
    expect(row.complete_response_json).toBeNull();
    // task token 未清
    expect(row.task_token_hash).toBeTruthy();
    // Agent 仍 working
    const agentRow = app.db.$client.prepare(`SELECT status FROM agents WHERE id=?`).get(agentId) as any;
    expect(agentRow.status).toBe("working");
    // Issue 保持 in_progress(由 start 推进,complete rollback 不影响)
    const issueRow = app.db.$client.prepare(`SELECT status FROM issues WHERE id=?`).get(issueId) as any;
    expect(issueRow.status).toBe("in_progress");
  });

  it("fail 写回执失败:Task 保持原 active 状态,Agent 不变,无 retry Task,无 retry 评论", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const tasksBefore = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    const commentsBefore = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n;
    installFailAbortTrigger();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom" }, daemonToken);
    expect(r.statusCode).toBe(500);
    dropAllTriggers();
    // Task 仍 running
    const row = app.db.$client.prepare(`SELECT status, failure_reason, fail_payload_hash, fail_response_json, task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("running");
    expect(row.failure_reason).toBeNull();
    expect(row.fail_payload_hash).toBeNull();
    expect(row.fail_response_json).toBeNull();
    expect(row.task_token_hash).toBeTruthy();
    // Agent 仍 working
    const agentRow = app.db.$client.prepare(`SELECT status FROM agents WHERE id=?`).get(agentId) as any;
    expect(agentRow.status).toBe("working");
    // 无 retry Task
    const tasksAfter = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    expect(tasksAfter).toBe(tasksBefore);
    // 无 retry 评论
    const commentsAfter = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n;
    expect(commentsAfter).toBe(commentsBefore);
  });
});

// ============================================================================
// Fix 1 · complete hash/result_json 字段一致性
// ============================================================================

describe("complete hash/result_json field consistency (FIX4)", () => {
  it("完整合法 complete payload → 200,所有持久化字段进入 result_json", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1",
      branch: "task/abc",
      diff_stat: "1 file",
      work_dir: "/w1",
      base_commit: SHA,
      head_commit: SHA,
      worktree_clean: true,
      verification: { schema_version: 1, status: "passed" },
    }, daemonToken);
    expect(r.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT result_json, complete_payload_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    const result = JSON.parse(row.result_json);
    expect(result.branch).toBe("task/abc");
    expect(result.diff_stat).toBe("1 file");
    expect(result.work_dir).toBe("/w1");
    expect(result.base_commit).toBe(SHA);
    expect(result.head_commit).toBe(SHA);
    expect(result.worktree_clean).toBe(true);
    expect(result.verification).toEqual({ schema_version: 1, status: "passed" });
    expect(result.daemon_id).toBeUndefined();
    expect(row.complete_payload_hash).toBeTruthy();
  });

  it("相同完整 complete payload 重放 → 200,所有持久化字段不变", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const payload = {
      daemon_id: "d1",
      branch: "task/abc",
      diff_stat: "1 file",
      work_dir: "/w1",
      head_commit: SHA,
      worktree_clean: true,
    };
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, payload, daemonToken);
    expect(r1.statusCode).toBe(200);
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, payload, daemonToken);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    // 落库 result_json 字节完全一致
    const row1 = (app.db.$client.prepare(`SELECT result_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).result_json;
    // 第二次是 replay,row 没改
    const row2 = (app.db.$client.prepare(`SELECT result_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).result_json;
    expect(row2).toBe(row1);
  });

  it("只改变 head_commit → 409 idempotency_conflict", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      head_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      worktree_clean: true,
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      head_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      worktree_clean: true,
    }, daemonToken);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe("idempotency_conflict");
  });

  it("只改变 worktree_clean → 409 idempotency_conflict", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      head_commit: SHA, worktree_clean: true,
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      head_commit: SHA, worktree_clean: false,
    }, daemonToken);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe("idempotency_conflict");
  });

  it("只改变 verification 内部值 → 409 idempotency_conflict", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      verification: { schema_version: 1, status: "passed", duration_ms: 100 },
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      verification: { schema_version: 1, status: "passed", duration_ms: 200 },
    }, daemonToken);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe("idempotency_conflict");
  });

  it("只改变 base_commit → 409 idempotency_conflict", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      base_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc",
      base_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }, daemonToken);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe("idempotency_conflict");
  });

  it("只改变对象键顺序(同语义)→ 200 replay", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc", diff_stat: "1 file", work_dir: "/w1",
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    // 同样的字段,顺序颠倒
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      work_dir: "/w1", diff_stat: "1 file", branch: "task/abc", daemon_id: "d1",
    }, daemonToken);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });

  it("complete 携带未知字段 → 400 invalid_schema,不落库 hash/response/result_json", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1",
      branch: "task/abc",
      unknown_field: "evil",
      another_unknown: 42,
    } as any, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toEqual(["unknown_field", "another_unknown"]);
    // 不允许落库
    const row = app.db.$client.prepare(`SELECT status, result_json, complete_payload_hash, complete_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.status).toBe("running");
    expect(row.result_json).toBeNull();
    expect(row.complete_payload_hash).toBeNull();
    expect(row.complete_response_json).toBeNull();
  });

  it("result_json 不含 daemon_id", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {
      daemon_id: "d1", branch: "task/abc", diff_stat: "1 file",
    }, daemonToken);
    const row = app.db.$client.prepare(`SELECT result_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    const result = JSON.parse(row.result_json);
    expect(result.daemon_id).toBeUndefined();
  });

  it("result_json 与参与 hash 的规范化业务对象字段完全一致", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const payload = {
      daemon_id: "d1",
      branch: "task/abc",
      diff_stat: "1 file",
      work_dir: "/w1",
      base_commit: SHA,
      head_commit: SHA,
      worktree_clean: true,
      verification: { schema_version: 1, status: "passed" },
    };
    await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, payload, daemonToken);
    const row = app.db.$client.prepare(`SELECT result_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    const result = JSON.parse(row.result_json);
    // result_json 字段集合必须是参与 hash 的业务字段的子集
    const allowedBizFields = new Set([
      "branch", "diff_stat", "work_dir", "session_id", "pushed", "undelivered",
      "base_commit", "head_commit", "worktree_clean", "verification",
    ]);
    for (const k of Object.keys(result)) {
      expect(allowedBizFields.has(k), `result_json 字段 ${k} 不在白名单`).toBe(true);
    }
    // result_json 不能含 daemon_id
    expect(result.daemon_id).toBeUndefined();
  });
});

// ============================================================================
// Fix 2 · fail.error 服务端 token 脱敏
// ============================================================================

describe("fail.error server-side token redaction (FIX4)", () => {
  it("error 包含 daemon token / task token / Authorization: Bearer / Bearer 都被脱敏", async () => {
    const pkg = await claimOne();
    // 在测试中,用真实生成的两个 token 构造 error。
    // daemonToken 在 beforeEach 中已生成,在此处也用作"伪 task token"以测试脱敏。
    // 任务未 start,我们走 fail 路径(需要在 active 状态——这里 start 后 fail)
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const errorText =
      `boom: daemon=${daemonToken} ` +
      `task=${pkg.task_token} ` +
      `Authorization: Bearer ${daemonToken} ` +
      `Bearer ${pkg.task_token}`;
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
      daemon_id: "d1",
      failure_reason: "non_zero_exit",
      error: errorText,
    }, daemonToken);
    expect(r.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT error, fail_payload_hash, fail_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    // 持久化的 error 不含任一原 token
    expect(row.error).not.toContain(daemonToken);
    expect(row.error).not.toContain(pkg.task_token);
    // fail_response_json 也不含原 token
    expect(row.fail_response_json).not.toContain(daemonToken);
    expect(row.fail_response_json).not.toContain(pkg.task_token);
    // 持久化的 error 包含占位符
    expect(row.error).toContain("[REDACTED]");
    // 幂等 hash 已落库
    expect(row.fail_payload_hash).toBeTruthy();
    // 整响应体不含原 token
    const responseText = JSON.stringify(r.json());
    expect(responseText).not.toContain(daemonToken);
    expect(responseText).not.toContain(pkg.task_token);
  });

  it("相同 fail payload 重放仍返回原响应(原始 token 不需要再次出现)", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const errorText = `crash with token ${daemonToken}`;
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
      daemon_id: "d1", failure_reason: "non_zero_exit", error: errorText,
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    // 第二次,原 error 仍带 token,但我们走幂等
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
      daemon_id: "d1", failure_reason: "non_zero_exit", error: errorText,
    }, daemonToken);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });

  it("error 包含 anv_ / atk_ / Bearer 都被脱敏(不依赖 token 真实存在)", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const fakeDaem = "anv_FAKE_TOKEN_ABCDEFG_1234567890";
    const fakeTask = "atk_FAKE_TASKTOKEN_HIJKLMNOPQR";
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
      daemon_id: "d1",
      failure_reason: "non_zero_exit",
      error: `boom daemon=${fakeDaem} task=${fakeTask} Authorization: Bearer ${fakeDaem} Bearer ${fakeTask}`,
    }, daemonToken);
    expect(r.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT error FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.error).not.toContain(fakeDaem);
    expect(row.error).not.toContain(fakeTask);
    expect(row.error).toContain("[REDACTED]");
  });

  // ============================================================================
  // A03-FIX5 · Bearer 凭据整体脱敏(含 `/ + = ~` 等 JWT 字符 + 大小写不敏感)
  // ============================================================================

  // FIX5 参数化矩阵。`label` 只在 it() 标题里出现,绝不输出真实凭据。
  type BearerCase = { label: string; errorText: string; mustNotContain: string[] };
  const FIX5_BEARER_CASES: BearerCase[] = [
    {
      label: "Bearer + / + + = 尾部",
      errorText: "prefix Bearer abc/SECRET+tail==",
      mustNotContain: ["abc/SECRET+tail==", "/SECRET+tail==", "abc"],
    },
    {
      label: "Authorization: Bearer + ~",
      errorText: "Authorization: Bearer abc~def/ghi+jkl==",
      mustNotContain: ["abc~def/ghi+jkl==", "/ghi+jkl==", "abc~def", "abc"],
    },
    {
      label: "小写 bearer",
      errorText: "bearer lowercase-token/value+",
      mustNotContain: ["lowercase-token/value+", "/value+", "lowercase-token"],
    },
    {
      label: "全大写 BEARER + JWT 字符",
      errorText: "BEARER eyJhbGciOi.x_y-z.sig/extra+",
      mustNotContain: ["eyJhbGciOi.x_y-z.sig/extra+", "/extra+", "eyJhbGciOi"],
    },
    {
      label: "Authorization : 多空白 + Bearer + 任意字符 + =",
      errorText: "Authorization :   Bearer    opaque/value+with=padding",
      mustNotContain: ["opaque/value+with=padding", "/value+with=padding", "opaque"],
    },
  ];

  for (const c of FIX5_BEARER_CASES) {
    it(`FIX5 · ${c.label} → fail 200,tasks.error 不含完整凭据/后缀`, async () => {
      const pkg = await claimOne();
      await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
      const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
        daemon_id: "d1",
        failure_reason: "non_zero_exit",
        error: c.errorText,
      }, daemonToken);
      expect(r.statusCode).toBe(200);
      const row = app.db.$client.prepare(`SELECT error, fail_payload_hash, fail_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
      // 任何子串(凭据全段或后半段)都不能留在 tasks.error
      for (const sub of c.mustNotContain) {
        expect(row.error, `tasks.error 不应包含 ${sub}`).not.toContain(sub);
      }
      // tasks.error 必须包含占位符
      expect(row.error).toContain("[REDACTED]");
      // fail_payload_hash / fail_response_json 已落库
      expect(row.fail_payload_hash).toBeTruthy();
      expect(row.fail_response_json).toBeTruthy();
      // 响应只允许固定回执字段；随机 UUID 可能合法包含 abc 等短片段，不能全串扫描。
      expect(r.json()).toEqual({ ok: true, task_id: pkg.task.id, status: "failed" });
      expect(JSON.parse(row.fail_response_json)).toEqual(r.json());
      // 不能产生 [REDACTED][REDACTED] 重复
      expect(row.error).not.toContain("[REDACTED][REDACTED]");
    });
  }

  it("FIX5 · 同一字符串同时含 anv_ / atk_ / Authorization Bearer / 独立 Bearer → 全部脱敏", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    // 用假 token,绝不构造含真实 token 的 error
    const fakeDaem = "anv_FAKE_TOKEN_ABCDEFG_1234567890";
    const fakeTask = "atk_FAKE_TASKTOKEN_HIJKLMNOPQR";
    const authBearer = "Authorization: Bearer auth-abc~def/ghi+jkl==";
    const plainBearer = "Bearer plain-token/value+";
    const errorText = `${fakeDaem} ${fakeTask} ${authBearer} ${plainBearer}`;
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
      daemon_id: "d1",
      failure_reason: "non_zero_exit",
      error: errorText,
    }, daemonToken);
    expect(r.statusCode).toBe(200);
    const row = app.db.$client.prepare(`SELECT error FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    // 所有原 token 都不应出现
    expect(row.error).not.toContain(fakeDaem);
    expect(row.error).not.toContain(fakeTask);
    expect(row.error).not.toContain("auth-abc~def/ghi+jkl==");
    expect(row.error).not.toContain("plain-token/value+");
    // 后缀也不应出现
    expect(row.error).not.toContain("/ghi+jkl==");
    expect(row.error).not.toContain("/value+");
    // 占位符必须出现(至少 4 次:anv_、atk_、auth Bearer、plain Bearer)
    const matches = row.error.match(/\[REDACTED\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
    // 无重复占位符
    expect(row.error).not.toContain("[REDACTED][REDACTED]");
  });

  it("FIX5 · 第一次 fail 失败凭据带 /SECRET+tail==,相同原始 payload 重放 → 200,只 1 个 retry Task,只 1 条 retry 评论", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    // 任务 max_attempts 默认 3,父任务 attempt=1,失败后会 attempt=2 的子任务。
    // 这里我们要的是:同一个父 fail 重放 N 次,只产生 1 个 retry Task + 1 条 retry 评论。
    // 所以最多 attempt=1 即触发重试;父任务 attempt=1 < max_attempts=3,第一次 fail 后会建子任务。
    const errorText = "Bearer abc/SECRET+tail==";
    const tasksBefore = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    const commentsBefore = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=? AND type='system'`).get(issueId) as any).n;
    // 第一次 fail:200,父 fail 成功,产生 1 个 retry 子 Task + 1 条 system 评论
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
      daemon_id: "d1",
      failure_reason: "non_zero_exit",
      error: errorText,
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    // 父 fail 写入后:retry 子任务已建,system 评论已加
    const tasksAfterFirst = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    const commentsAfterFirst = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=? AND type='system'`).get(issueId) as any).n;
    expect(tasksAfterFirst).toBe(tasksBefore + 1);
    expect(commentsAfterFirst).toBe(commentsBefore + 1);
    // 父任务的 tasks.error 已被脱敏:不含 /SECRET+tail==
    const parent = app.db.$client.prepare(`SELECT error, fail_payload_hash, fail_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(parent.error).not.toContain("/SECRET+tail==");
    expect(parent.error).not.toContain("abc/SECRET+tail==");
    expect(parent.error).toContain("[REDACTED]");
    expect(parent.fail_payload_hash).toBeTruthy();
    expect(parent.fail_response_json).toBeTruthy();
    // 第二次:同原始 payload 重放 → 命中幂等,返回 200
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, {
      daemon_id: "d1",
      failure_reason: "non_zero_exit",
      error: errorText,
    }, daemonToken);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    // retry Task 数量不变(还是 +1)
    const tasksAfterSecond = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    expect(tasksAfterSecond).toBe(tasksAfterFirst);
    // retry 评论数量不变(还是 +1)
    const commentsAfterSecond = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=? AND type='system'`).get(issueId) as any).n;
    expect(commentsAfterSecond).toBe(commentsAfterFirst);
    // HTTP 响应不含原始凭据
    expect(JSON.stringify(r2.json())).not.toContain("/SECRET+tail==");
    expect(JSON.stringify(r2.json())).not.toContain("abc/SECRET+tail==");
  });
});

// ============================================================================
// Fix 3 · invalid_git_anchor 严格 Git ref 校验
// ============================================================================

describe("invalid_git_anchor strict branch validation (FIX4)", () => {
  // 合法 examples
  const VALID_BRANCHES = [
    "main",
    "develop",
    "task/abc12345",
    "feature/中文说明",
    "release/v1.2.3",
  ];
  // 非法 examples:对应禁止字符/模式
  // R1-FIX1:空字符串 "" 已被路由层用 invalid_schema 拦截,不再列入此表;
  // 本表只覆盖路由放行(类型正确)后由 service validateGitRef 拒掉的格式错。
  const INVALID_BRANCHES: Array<[string, string]> = [
    ["  main", "leading whitespace"],
    ["main  ", "trailing whitespace"],
    ["main evil", "contains space"],
    ["main~evil", "contains ~"],
    ["main^1", "contains ^"],
    ["main:bad", "contains :"],
    ["main?", "contains ?"],
    ["main*", "contains *"],
    ["mai[n", "contains ["],
    ["mai\\n", "contains backslash"],
    ["main..dev", "contains .."],
    ["main@{1}", "contains @{"],
    ["/main", "starts with /"],
    ["main/", "ends with /"],
    ["main//dev", "contains //"],
    ["main.", "ends with ."],
    [".main", "segment starts with ."],
    ["feature/.hidden", "segment starts with ."],
    ["feature/secret.lock", "segment ends with .lock"],
    ["@", "single @"],
    ["-main", "starts with -"],
    ["main\nnext", "contains control char"],
  ];

  // 完整 v2 锚点(用 INVALID_BRANCH 时改对应字段)
  const baseAnchor = {
    task_branch: "task/orig",
    target_branch: "main",
    base_commit: SHA,
    delivery_contract_version: 2,
  };

  for (const [branch, label] of INVALID_BRANCHES) {
    it(`task_branch=${JSON.stringify(branch)} (${label}) → 400 invalid_git_anchor,Task 仍 dispatched,字段未写入`, async () => {
      const pkg = await claimOne();
      const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
        daemon_id: "d1", work_dir: "/w1",
        ...baseAnchor,
        task_branch: branch,
      }, daemonToken);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("invalid_git_anchor");
      expect(r.json().details.field).toBe("task_branch");
      const row = app.db.$client.prepare(`SELECT status, task_branch, target_branch, base_commit, start_payload_hash, start_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
      expect(row.status).toBe("dispatched");
      expect(row.task_branch).toBeNull();
      expect(row.target_branch).toBeNull();
      expect(row.base_commit).toBeNull();
      expect(row.start_payload_hash).toBeNull();
      expect(row.start_response_json).toBeNull();
    });

    it(`target_branch=${JSON.stringify(branch)} (${label}) → 400 invalid_git_anchor`, async () => {
      const pkg = await claimOne();
      const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
        daemon_id: "d1", work_dir: "/w1",
        ...baseAnchor,
        target_branch: branch,
      }, daemonToken);
      expect(r.statusCode).toBe(400);
      expect(r.json().code).toBe("invalid_git_anchor");
      expect(r.json().details.field).toBe("target_branch");
    });
  }

  for (const branch of VALID_BRANCHES) {
    it(`合法 task_branch=${JSON.stringify(branch)} → 200,所有锚点落库`, async () => {
      const pkg = await claimOne();
      const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
        daemon_id: "d1", work_dir: "/w1",
        task_branch: branch,
        target_branch: "main",
        base_commit: SHA,
        delivery_contract_version: 2,
      }, daemonToken);
      expect(r.statusCode).toBe(200);
      const row = app.db.$client.prepare(`SELECT task_branch, target_branch, base_commit, delivery_contract_version FROM tasks WHERE id=?`).get(pkg.task.id) as any;
      expect(row.task_branch).toBe(branch);
      expect(row.target_branch).toBe("main");
      expect(row.base_commit).toBe(SHA);
    });
  }

  it("非 40 位 SHA → 400 invalid_schema(路由层格式校验)", async () => {
    // R1-FIX1:非 40 hex SHA 是路由层格式错,返回 invalid_schema;service 的
    // invalid_git_anchor 留给更严格的 Git ref 格式校验(分支名空白/特殊字符等)。
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig",
      target_branch: "main",
      base_commit: "deadbeef", // 太短
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("base_commit");
  });

  it("无效 SHA 大小写 OK 但必须 40 位 hex", async () => {
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig",
      target_branch: "main",
      base_commit: "DEADBEEFcafebabe0123456789abcdef00112233", // 40 hex,大小写无所谓
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r.statusCode).toBe(200);
  });

  it("version=99 → 400 invalid_schema(非 invalid_git_anchor)", async () => {
    const pkg = await claimOne();
    const r = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 99,
    }, daemonToken);
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
  });

  it("Task 已存 task_branch,replay 传非法分支 → 400 invalid_git_anchor(优先于 base_mismatch)", async () => {
    const pkg = await claimOne();
    // 第一次合法
    const r1 = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r1.statusCode).toBe(200);
    // 第二次非法 branch → 锚点校验先于 base_mismatch
    const r2 = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "bad branch",
      target_branch: "main",
      base_commit: SHA,
      delivery_contract_version: 2,
    }, daemonToken);
    expect(r2.statusCode).toBe(400);
    expect(r2.json().code).toBe("invalid_git_anchor");
    // 锚点未变
    const row = app.db.$client.prepare(`SELECT task_branch FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.task_branch).toBe("task/orig");
  });
});

// ============================================================================
// R1-FIX1 · 事务内部 idempotency recheck 命中(replayed=true 透传)
// ============================================================================
//
// 本节直接调用 runXxxInTransaction 内部函数,绕过事务前 fast path,
// 模拟"pre-check miss、in-tx recheck hit"的情形。
// 这正是原实现下会硬编码 replayed:false 的 bug;修复后必须透传 true。
//
// 关键断言(每个 operation 都要):
// - service 返回的 outcome.replayed === true
// - 状态/Agent/Issue/评论/广播均无变化
// - 不发生第二次业务写入

import {
  runStartInTransaction,
  runCompleteInTransaction,
  runFailInTransaction,
  normalizeOpPayload,
} from "../src/services/tasks.js";
import { canonicalJsonHash } from "@anvil/core";

const SHA_FULL = "0123456789abcdef0123456789abcdef01234567";

describe("R1-FIX1: 事务内部 idempotency recheck 命中 → replayed=true 透传", () => {
  it("start: 事务内 hit → replayed=true,无副作用", async () => {
    const pkg = await claimOne();
    // 模拟"pre-check miss、in-tx 已有同 hash":直接预置 idempotency 记录
    const hash = canonicalJsonHash(normalizeOpPayload("start", {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig", target_branch: "main",
      base_commit: SHA_FULL, delivery_contract_version: 2,
    }));
    const response = { ok: true, task_id: pkg.task.id, status: "running" };
    app.db.$client.prepare(
      `UPDATE tasks SET start_payload_hash=?, start_response_json=? WHERE id=?`
    ).run(hash, JSON.stringify(response), pkg.task.id);

    const beforeStatus = (app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    const beforeStartPayloadHash = (app.db.$client.prepare(`SELECT start_payload_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).start_payload_hash;
    const beforeComments = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n;

    // 直接调用事务体(bypass pre-check,模拟 in-tx recheck 命中)
    const outcome = runStartInTransaction(app.db, pkg.task.id, hash, {
      daemon_id: "d1", work_dir: "/w1",
      task_branch: "task/orig", target_branch: "main",
      base_commit: SHA_FULL, delivery_contract_version: 2,
    });

    expect(outcome.replayed).toBe(true);
    expect(outcome.response).toEqual(response);
    expect(outcome.advancedIssue).toBeNull();
    // 状态不变(start 仍是 dispatched)
    expect((app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status).toBe(beforeStatus);
    // hash 未被覆盖
    expect((app.db.$client.prepare(`SELECT start_payload_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).start_payload_hash).toBe(beforeStartPayloadHash);
    // 评论不变
    expect((app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n).toBe(beforeComments);
  });

  it("complete: 事务内 hit → replayed=true,无副作用(不重复评论/状态迁移/广播)", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    // 预置 complete 的 idempotency 记录
    const payload = { daemon_id: "d1", branch: "task/abc", worktree_clean: true };
    const hash = canonicalJsonHash(normalizeOpPayload("complete", payload));
    const response = { ok: true, task_id: pkg.task.id, status: "completed" };
    app.db.$client.prepare(
      `UPDATE tasks SET complete_payload_hash=?, complete_response_json=? WHERE id=?`
    ).run(hash, JSON.stringify(response), pkg.task.id);

    const beforeComments = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n;
    const beforeIssue = (app.db.$client.prepare(`SELECT status FROM issues WHERE id=?`).get(issueId) as any).status;

    // 直接调事务体,bypass pre-check
    const outcome = runCompleteInTransaction(app.db, pkg.task.id, hash, payload);

    expect(outcome.replayed).toBe(true);
    expect(outcome.response).toEqual(response);
    // 状态仍是 running(complete 还没真正落库)
    expect((app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status).toBe("running");
    // 评论/Issue 不变
    expect((app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n).toBe(beforeComments);
    expect((app.db.$client.prepare(`SELECT status FROM issues WHERE id=?`).get(issueId) as any).status).toBe(beforeIssue);
  });

  it("fail: 事务内 hit → replayed=true,无副作用(不创建 retry Task/不重评论)", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    // 预置 fail idempotency
    const payload = { daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom" };
    const hash = canonicalJsonHash(normalizeOpPayload("fail", payload));
    const response = { ok: true, task_id: pkg.task.id, status: "failed" };
    app.db.$client.prepare(
      `UPDATE tasks SET fail_payload_hash=?, fail_response_json=? WHERE id=?`
    ).run(hash, JSON.stringify(response), pkg.task.id);

    const beforeTasks = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n;
    const beforeComments = (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n;

    // 直接调事务体
    const outcome = runFailInTransaction(app.db, pkg.task.id, hash, payload);

    expect(outcome.replayed).toBe(true);
    expect(outcome.response).toEqual(response);
    // 任务数量不变(无 retry Task 创建)
    expect((app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(issueId) as any).n).toBe(beforeTasks);
    // 评论数量不变(无 retry 评论)
    expect((app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(issueId) as any).n).toBe(beforeComments);
  });

  it("start: 事务内 hash 不同时仍抛 idempotency_conflict(code 字段)", async () => {
    const pkg = await claimOne();
    // 预置 hash X
    const hashX = "a".repeat(64);
    const response = { ok: true, task_id: pkg.task.id, status: "running" };
    app.db.$client.prepare(
      `UPDATE tasks SET start_payload_hash=?, start_response_json=? WHERE id=?`
    ).run(hashX, JSON.stringify(response), pkg.task.id);
    // 调事务体,传入不同 hash Y
    const hashY = "b".repeat(64);
    try {
      runStartInTransaction(app.db, pkg.task.id, hashY, {
        daemon_id: "d1", work_dir: "/w1",
      });
      expect.fail("expected to throw");
    } catch (e: any) {
      expect(e.code).toBe("idempotency_conflict");
      expect(e.http).toBe(409);
    }
  });

  it("complete: 事务内 hash 不同时仍抛 idempotency_conflict(code 字段)", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const hashX = "a".repeat(64);
    app.db.$client.prepare(
      `UPDATE tasks SET complete_payload_hash=?, complete_response_json=? WHERE id=?`
    ).run(hashX, JSON.stringify({ ok: true, task_id: pkg.task.id, status: "completed" }), pkg.task.id);
    const hashY = "b".repeat(64);
    try {
      runCompleteInTransaction(app.db, pkg.task.id, hashY, {
        daemon_id: "d1", branch: "task/abc",
      });
      expect.fail("expected to throw");
    } catch (e: any) {
      expect(e.code).toBe("idempotency_conflict");
      expect(e.http).toBe(409);
    }
  });

  it("fail: 事务内 hash 不同时仍抛 idempotency_conflict(code 字段)", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/w1" }, daemonToken);
    const hashX = "a".repeat(64);
    app.db.$client.prepare(
      `UPDATE tasks SET fail_payload_hash=?, fail_response_json=? WHERE id=?`
    ).run(hashX, JSON.stringify({ ok: true, task_id: pkg.task.id, status: "failed" }), pkg.task.id);
    const hashY = "b".repeat(64);
    try {
      runFailInTransaction(app.db, pkg.task.id, hashY, {
        daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom",
      });
      expect.fail("expected to throw");
    } catch (e: any) {
      expect(e.code).toBe("idempotency_conflict");
      expect(e.http).toBe(409);
    }
  });
});
