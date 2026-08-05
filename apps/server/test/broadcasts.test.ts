import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;

const auth = () => ({ authorization: `Bearer ${daemonToken}` });

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "demo", assignee_type: "agent", assignee_id: agentId },
  });
  await app.inject({
    method: "POST", url: "/api/daemon/register", headers: auth(),
    payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] },
  });
});

describe("claim/start broadcasts", () => {
  it("claim broadcasts task.updated for each dispatched task", async () => {
    const spy = vi.spyOn(app.hub, "broadcast");
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    const pkg = res.json().tasks[0];
    expect(pkg).toBeTruthy();
    expect(spy).toHaveBeenCalledWith({
      type: "task.updated",
      data: expect.objectContaining({ id: pkg.task.id, status: "dispatched" }),
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("start broadcasts task.updated with running task", async () => {
    const c = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    const pkg = c.json().tasks[0];
    const spy = vi.spyOn(app.hub, "broadcast");
    const s = await app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${pkg.task_token}` },
      payload: { work_dir: "/tmp/w1" },
    });
    expect(s.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith({
      type: "task.updated",
      data: expect.objectContaining({ id: pkg.task.id, status: "running" }),
    });
  });

  it("failed claim (nothing queued) broadcasts nothing", async () => {
    await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    const spy = vi.spyOn(app.hub, "broadcast");
    await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(spy).not.toHaveBeenCalled();
  });
});
