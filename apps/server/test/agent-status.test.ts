import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;

async function mkIssue(title: string) {
  const i = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title, assignee_type: "agent", assignee_id: agentId },
  });
  return i.json().id;
}

async function claim(maxTasks = 1) {
  const c = await app.inject({
    method: "POST", url: "/api/daemon/claim",
    headers: { authorization: `Bearer ${daemonToken}` },
    payload: { daemon_id: "d1", max_tasks: maxTasks },
  });
  return c.json().tasks as any[];
}

async function agentStatus() {
  const res = await app.inject({ method: "GET", url: "/api/agents" });
  return res.json().find((a: any) => a.id === agentId).status;
}

const tpost = (url: string, payload: unknown, token: string) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  await mkIssue("demo");
  await app.inject({
    method: "POST", url: "/api/daemon/register",
    headers: { authorization: `Bearer ${daemonToken}` },
    payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] },
  });
});

describe("agent status reflects real work", () => {
  it("idle → working on claim → idle on complete", async () => {
    expect(await agentStatus()).toBe("idle");
    const [pkg] = await claim();
    expect(pkg).toBeTruthy();
    expect(await agentStatus()).toBe("working");
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { branch: "b" }, pkg.task_token);
    expect(c.statusCode).toBe(200);
    expect(await agentStatus()).toBe("idle");
  });

  it("two concurrent tasks: completing one keeps agent working", async () => {
    app.db.$client.prepare(`UPDATE agents SET max_concurrent_tasks=2 WHERE id=?`).run(agentId);
    await mkIssue("second");
    const pkgs = await claim(2);
    expect(pkgs).toHaveLength(2);
    expect(await agentStatus()).toBe("working");
    await tpost(`/api/daemon/tasks/${pkgs[0].task.id}/complete`, {}, pkgs[0].task_token);
    expect(await agentStatus()).toBe("working");
    await tpost(`/api/daemon/tasks/${pkgs[1].task.id}/complete`, {}, pkgs[1].task_token);
    expect(await agentStatus()).toBe("idle");
  });

  it("fail with retry child (queued) sets agent back to idle", async () => {
    const [pkg] = await claim();
    expect(await agentStatus()).toBe("working");
    const f = await tpost(`/api/daemon/tasks/${pkg.task.id}/fail`, { failure_reason: "non_zero_exit", error: "exit 1" }, pkg.task_token);
    expect(f.statusCode).toBe(200);
    // 重试子任务是 queued，不算 running
    expect(await agentStatus()).toBe("idle");
  });

  it("cancel sets agent back to idle", async () => {
    const [pkg] = await claim();
    expect(await agentStatus()).toBe("working");
    const res = await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(await agentStatus()).toBe("idle");
  });
});
