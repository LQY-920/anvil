import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let agentId: string;
let issueId: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: { label: "t" } });
  token = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "demo", assignee_type: "agent", assignee_id: agentId },
  });
  issueId = i.json().id;
  await app.inject({
    method: "POST", url: "/api/daemon/register",
    headers: { authorization: `Bearer ${token}` },
    payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1.0.0" }] },
  });
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe("daemon auth + claim", () => {
  it("rejects claim without token", async () => {
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", payload: { daemon_id: "d1" } });
    expect(res.statusCode).toBe(401);
  });

  it("claims queued task atomically: second claim gets nothing", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(r1.statusCode).toBe(200);
    const body = r1.json();
    expect(body.tasks).toHaveLength(1);
    const pkg = body.tasks[0];
    expect(pkg.task.status).toBe("dispatched");
    expect(pkg.task.lease_expires_at).toBeTruthy();
    expect(pkg.task_token).toMatch(/^atk_/);
    expect(pkg.issue.id).toBe(issueId);
    expect(pkg.prior_work_dir).toBeNull();

    const r2 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(r2.json().tasks).toHaveLength(0);
  });

  it("concurrent claims: only one winner", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } }),
      app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } }),
    ]);
    const total = r1.json().tasks.length + r2.json().tasks.length;
    expect(total).toBe(1);
  });

  it("respects agent max_concurrent_tasks", async () => {
    await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "second", assignee_type: "agent", assignee_id: agentId } });
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(res.json().tasks).toHaveLength(0);
  });

  it("priority order: urgent claimed before medium", async () => {
    const db = app.db;
    db.prepare(`DELETE FROM tasks`).run();
    const mk = async (priority: string) => {
      await app.inject({ method: "POST", url: "/api/issues", payload: { title: priority, priority, assignee_type: "agent", assignee_id: agentId } });
    };
    await mk("medium");
    await mk("urgent");
    db.prepare(`UPDATE agents SET max_concurrent_tasks=2 WHERE id=?`).run(agentId);
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1", max_tasks: 2 } });
    expect(res.json().tasks).toHaveLength(2);
    expect(res.json().tasks[0].issue.title).toBe("urgent");
  });

  it("task token authorizes task-scoped endpoints", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    const pkg = r1.json().tasks[0];
    const bad = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: "Bearer wrong" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: `Bearer ${pkg.task_token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("dispatched");
  });
});
