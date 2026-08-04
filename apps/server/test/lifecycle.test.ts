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
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    expect(s.statusCode).toBe(200);
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { branch: "task/abc", diff_stat: "2 files changed", work_dir: "/tmp/w1" }, pkg.task_token);
    expect(c.statusCode).toBe(200);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.work_dir).toBe("/tmp/w1");
    const again = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, {}, pkg.task_token);
    expect(again.statusCode).toBe(401);
  });

  it("fail creates retry child until max_attempts", async () => {
    const pkg = await claimOne();
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { failure_reason: "non_zero_exit", error: "exit 1" }, pkg.task_token);
    expect(f.statusCode).toBe(200);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks.json()).toHaveLength(2);
    const child = tasks.json().find((t: any) => t.parent_task_id === pkg.task.id);
    expect(child.status).toBe("queued");
    expect(child.attempt).toBe(2);

    app.db.$client.prepare(`UPDATE tasks SET attempt = 3, max_attempts = 3 WHERE id = ?`).run(child.id);
    const pkg2 = await claimOne();
    expect(pkg2.task.id).toBe(child.id);
    await tpost(`/api/daemon/tasks/${pkg2.task.id}/fail`, { failure_reason: "non_zero_exit", error: "exit 1" }, pkg2.task_token);
    const tasks2 = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks2.json()).toHaveLength(2);
  });

  it("expired lease requeues task and clears token", async () => {
    const pkg = await claimOne();
    expect(pkg.task.attempt).toBe(1);
    const past = new Date(Date.now() - 1000).toISOString();
    app.db.$client.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(past, pkg.task.id);
    const { sweepExpiredLeases } = await import("../src/services/tasks.js");
    expect(sweepExpiredLeases(app.db, new Date().toISOString())).toBe(1);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("queued");
    expect(got.json().task.attempt).toBe(2); // 重派计入 attempt，防无限重派
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/x" }, pkg.task_token);
    expect(s.statusCode).toBe(401);
    const pkg2 = await claimOne();
    expect(pkg2.task.id).toBe(pkg.task.id);
  });

  it("expired lease at max_attempts fails as lease_expired instead of requeue", async () => {
    const pkg = await claimOne();
    app.db.$client.prepare(`UPDATE tasks SET attempt = 3, max_attempts = 3 WHERE id = ?`).run(pkg.task.id);
    const past = new Date(Date.now() - 1000).toISOString();
    app.db.$client.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ?`).run(past, pkg.task.id);
    const { sweepExpiredLeases } = await import("../src/services/tasks.js");
    expect(sweepExpiredLeases(app.db, new Date().toISOString())).toBe(1);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("failed");
    expect(got.json().task.failure_reason).toBe("lease_expired");
    // 不再重派：claim 不到任何任务
    const again = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
    expect(again.json().tasks).toHaveLength(0);
  });

  it("cancel from web sets cancelled; runner status endpoint reflects it", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    const res = await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    expect(res.statusCode).toBe(200);
    const st = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: `Bearer ${pkg.task_token}` } });
    expect([200, 401]).toContain(st.statusCode);
    if (st.statusCode === 200) expect(st.json().status).toBe("cancelled");
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("cancelled");
  });

  it("agent callback moves issue to in_review and writes timeline", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    const res = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "in_review", note: "做完了，请 review" }, pkg.task_token);
    expect(res.statusCode).toBe(200);
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issueId}` });
    expect(detail.json().issue.status).toBe("in_review");
    expect(detail.json().comments.some((c: any) => c.type === "status_change")).toBe(true);
    const bad = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "todo" }, pkg.task_token);
    expect(bad.statusCode).toBe(400);
  });

  it("skips retry child when a pending task already exists for the issue", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    // running 期间手动 rerun：由于父任务已离开 queued/dispatched，索引放行，产生第二条 pending
    const rerun = await app.inject({ method: "POST", url: `/api/issues/${issueId}/rerun` });
    expect([201, 409]).toContain(rerun.statusCode);
    // 父任务失败：不应 500，且不应产生第三条任务
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { failure_reason: "non_zero_exit", error: "exit 1" }, pkg.task_token);
    expect(f.statusCode).toBe(200);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    expect(tasks.json().length).toBeLessThanOrEqual(2);
    expect(tasks.json().filter((t: any) => ["queued", "dispatched"].includes(t.status)).length).toBeLessThanOrEqual(1);
  });

  it("cancelled task token cannot advance issue status", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    const res = await tpost(`/api/daemon/tasks/${pkg.task.id}/issue-status`, { status: "done" }, pkg.task_token);
    expect(res.statusCode).toBe(400);
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issueId}` });
    expect(detail.json().issue.status).not.toBe("done");
  });
});
