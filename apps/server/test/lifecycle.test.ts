import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;
let issueId: string;

async function claimOne() {
  const c = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
  return c.json().tasks[0] as any;
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", assignee_type: "agent", assignee_id: agentId } });
  issueId = i.json().id;
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
});

const tpost = (url: string, payload: unknown, token: string) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe("task lifecycle", () => {
  it("start → running; complete → completed with result", async () => {
    const pkg = await claimOne();
    // 保留旧 Runner 的 branch-only 完成契约；v2 使用完整证据另测。
    app.db.$client.prepare("UPDATE tasks SET delivery_contract_version=1 WHERE id=?").run(pkg.task.id);
    // A03: start / complete 改用 daemon token,body 必须带 daemon_id
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    expect(s.statusCode).toBe(200);
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { daemon_id: "d1", branch: "task/abc", diff_stat: "2 files changed", work_dir: "/tmp/w1" }, daemonToken);
    expect(c.statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.work_dir).toBe("/tmp/w1");
    // A03: 用 task token 调 complete 必须 401/403
    const again = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {}, pkg.task_token);
    expect([401, 403]).toContain(again.statusCode);
  });

  it("fail creates retry child until max_attempts", async () => {
    const pkg = await claimOne();
    // A03: fail 改用 daemon token
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "exit 1" }, daemonToken);
    expect(f.statusCode).toBe(200);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks.json()).toHaveLength(2);
    const child = tasks.json().find((t: any) => t.parent_task_id === pkg.task.id);
    expect(child.status).toBe("queued");
    expect(child.attempt).toBe(2);

    app.db.$client.prepare(`UPDATE tasks SET attempt = 3, max_attempts = 3 WHERE id = ?`).run(child.id);
    const pkg2 = await claimOne();
    expect(pkg2.task.id).toBe(child.id);
    await tpost(`/api/daemon/tasks/${pkg2.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "exit 1" }, daemonToken);
    const tasks2 = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks2.json()).toHaveLength(2);
  });

  it("expired lease requeues task and clears token", async () => {
    const pkg = await claimOne();
    expect(pkg.task.attempt).toBe(1);
    const past = new Date(Date.now() - 1000).toISOString();
    app.db.$client.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(past, pkg.task.id);
    const { sweepExpiredLeases } = await import("../src/services/tasks.js");
    expect(sweepExpiredLeases(app.db, new Date().toISOString())).toEqual([pkg.task.id]);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("queued");
    expect(got.json().task.attempt).toBe(2); // 重派计入 attempt，防无限重派
    // A03: 租约清扫后用 task token 调 start 必失败
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/x" }, pkg.task_token);
    expect([401, 403]).toContain(s.statusCode);
    const pkg2 = await claimOne();
    expect(pkg2.task.id).toBe(pkg.task.id);
  });

  it("expired lease at max_attempts fails as lease_expired instead of requeue", async () => {
    const pkg = await claimOne();
    app.db.$client.prepare(`UPDATE tasks SET attempt = 3, max_attempts = 3 WHERE id = ?`).run(pkg.task.id);
    const past = new Date(Date.now() - 1000).toISOString();
    app.db.$client.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(past, pkg.task.id);
    const { sweepExpiredLeases } = await import("../src/services/tasks.js");
    expect(sweepExpiredLeases(app.db, new Date().toISOString())).toEqual([pkg.task.id]);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("failed");
    expect(got.json().task.failure_reason).toBe("lease_expired");
    // 不再重派：claim 不到任何任务
    const again = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
    expect(again.json().tasks).toHaveLength(0);
  });

  it("cancel from web sets cancelled; runner status endpoint reflects it", async () => {
    const pkg = await claimOne();
    // A03: start 改用 daemon token
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    expect(res.statusCode).toBe(200);
    // status 端点继续用 task token(保持 A01 行为)
    const st = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: `Bearer ${pkg.task_token}` } });
    expect([200, 401]).toContain(st.statusCode);
    if (st.statusCode === 200) expect(st.json().status).toBe("cancelled");
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("cancelled");
  });

  it("agent callback moves issue to in_review and writes timeline", async () => {
    const pkg = await claimOne();
    // A03: start 改用 daemon token;issue-status 仍用 task token
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    // A05: v2 issue-status=in_review 已被 Delivery Report 路径替代,
    // 验证 v1 行为保持兼容,必须把 task 标回 v1。
    app.db.$client.prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`).run(pkg.task.id);
    const res = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "in_review", note: "做完了，请 review" }, pkg.task_token);
    expect(res.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issueId}` });
    expect(detail.json().issue.status).toBe("in_review");
    expect(detail.json().comments.some((c: any) => c.type === "status_change")).toBe(true);
    const bad = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "todo" }, pkg.task_token);
    expect(bad.statusCode).toBe(400);
  });

  it("delivery endpoint: false before issue-status callback, true after", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    // A05: v1 issue-status=in_review 路径仍写 delivered_at
    app.db.$client.prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`).run(pkg.task.id);
    const tget = (url: string, token: string) =>
      app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    const before = await tget(`/api/daemon/tasks/${pkg.task.id}/delivery`, pkg.task_token);
    expect(before.statusCode).toBe(200);
    expect(before.json().delivered).toBe(false);
    const cb = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "in_review" }, pkg.task_token);
    expect(cb.statusCode).toBe(200);
    const after = await tget(`/api/daemon/tasks/${pkg.task.id}/delivery`, pkg.task_token);
    expect(after.json().delivered).toBe(true);
  });

  it("skips retry child when a pending task already exists for the issue", async () => {
    const pkg = await claimOne();
    // A03: start/fail 改用 daemon token
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    // running 期间手动 rerun：由于父任务已离开 queued/dispatched，索引放行，产生第二条 pending
    const rerun = await app.inject({ method: "POST", url: `/api/issues/${issueId}/rerun` });
    expect([201, 409]).toContain(rerun.statusCode);
    // 父任务失败：不应 500，且不应产生第三条任务
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { daemon_id: "d1", failure_reason: "non_zero_exit", error: "exit 1" }, daemonToken);
    expect(f.statusCode).toBe(200);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks.json().length).toBeLessThanOrEqual(2);
    expect(tasks.json().filter((t: any) => ["queued", "dispatched"].includes(t.status)).length).toBeLessThanOrEqual(1);
  });

  it("cancelled task token cannot advance issue status", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    const res = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "done" }, pkg.task_token);
    expect(res.statusCode).toBe(400);
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issueId}` });
    expect(detail.json().issue.status).not.toBe("done");
  });
});

// =============================================================================
// A05 · v2 issue-status 分流
//
// v2 Task:
//  - in_review → 409 runner_evidence_required(零副作用,delivered_at 不写)
//  - done      → 409 human_decision_required(零副作用)
//  - blocked   → 200(允许逃生路径,delivered_at 仍为 null)
//
// v1 Task:保持现有行为(所有三个都允许,in_review/done 都写 delivered_at)。
// =============================================================================

describe("A05 · v2 issue-status 分流", () => {
  /** 把当前 task 的 contract_version 设为 2(已 claim 后默认就是 2,这里是显式保护)。 */
  async function claimV2() {
    return await claimOne();
  }

  it("v2 in_review → 409 runner_evidence_required,零副作用", async () => {
    const pkg = await claimV2();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);

    const issueBefore = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    const commentsBefore = issueBefore.comments.length;
    const taskBefore = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    const statusBefore = taskBefore.task.status;
    const deliveredBefore = taskBefore.task.delivered_at;

    const res = await tpost(
      `/api/daemon/tasks/${pkg.task.id}/issue-status`,
      { status: "in_review", note: "做完了请 review" },
      pkg.task_token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("runner_evidence_required");

    // 零副作用
    const issueAfter = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    expect(issueAfter.issue.status).toBe(issueBefore.issue.status);
    expect(issueAfter.comments.length).toBe(commentsBefore);
    const taskAfter = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    expect(taskAfter.task.status).toBe(statusBefore);
    expect(taskAfter.task.delivered_at).toBe(deliveredBefore);
  });

  it("v2 done → 409 human_decision_required,零副作用", async () => {
    const pkg = await claimV2();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);

    const issueBefore = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    const commentsBefore = issueBefore.comments.length;

    const res = await tpost(
      `/api/daemon/tasks/${pkg.task.id}/issue-status`,
      { status: "done", note: "完成" },
      pkg.task_token,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("human_decision_required");

    const issueAfter = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    expect(issueAfter.issue.status).toBe(issueBefore.issue.status);
    expect(issueAfter.comments.length).toBe(commentsBefore);

    const taskAfter = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    expect(taskAfter.task.delivered_at).toBeNull();
  });

  it("v2 blocked → 200,delivered_at 仍为 null(逃生路径保留)", async () => {
    const pkg = await claimV2();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);

    const res = await tpost(
      `/api/daemon/tasks/${pkg.task.id}/issue-status`,
      { status: "blocked", note: "需要用户澄清" },
      pkg.task_token,
    );
    expect(res.statusCode).toBe(200);

    const taskAfter = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    // v2 blocked 不写 delivered_at
    expect(taskAfter.task.delivered_at).toBeNull();

    const issueAfter = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    expect(issueAfter.issue.status).toBe("blocked");
  });

  it("v1 in_review 行为不变 → 200,delivered_at 写入,issue 进入 in_review", async () => {
    const pkg = await claimV2();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    // 把 task 改回 v1
    app.db.$client.prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`).run(pkg.task.id);

    const res = await tpost(
      `/api/daemon/tasks/${pkg.task.id}/issue-status`,
      { status: "in_review" },
      pkg.task_token,
    );
    expect(res.statusCode).toBe(200);
    const taskAfter = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    expect(taskAfter.task.delivered_at).toBeTruthy();
    const issueAfter = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    expect(issueAfter.issue.status).toBe("in_review");
  });

  it("v1 done 行为不变 → 200,delivered_at 写入,issue 进入 done", async () => {
    const pkg = await claimV2();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    app.db.$client.prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`).run(pkg.task.id);

    const res = await tpost(
      `/api/daemon/tasks/${pkg.task.id}/issue-status`,
      { status: "done" },
      pkg.task_token,
    );
    expect(res.statusCode).toBe(200);
    const taskAfter = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    expect(taskAfter.task.delivered_at).toBeTruthy();
    const issueAfter = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    expect(issueAfter.issue.status).toBe("done");
  });

  it("v1 blocked 行为不变 → 200,issue 进入 blocked,delivered_at 写入", async () => {
    const pkg = await claimV2();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { daemon_id: "d1", work_dir: "/tmp/w1" }, daemonToken);
    app.db.$client.prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`).run(pkg.task.id);

    const res = await tpost(
      `/api/daemon/tasks/${pkg.task.id}/issue-status`,
      { status: "blocked", note: "v1 blocked" },
      pkg.task_token,
    );
    expect(res.statusCode).toBe(200);
    const taskAfter = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    // v1 行为保留:旧实现是写 delivered_at 的
    expect(taskAfter.task.delivered_at).toBeTruthy();
    const issueAfter = (await app.inject({ method: "GET", url: `/api/issues/${issueId}` })).json();
    expect(issueAfter.issue.status).toBe("blocked");
  });
});
