import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let pkg: any;
let taskToken: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", assignee_type: "agent", assignee_id: a.json().id } });
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
  const c = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
  pkg = c.json().tasks[0];
  taskToken = pkg.task_token;
});

const post = (url: string, payload: unknown, token = taskToken) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

describe("task messages", () => {
  it("appends batch with continuous seq and reads back", async () => {
    const res = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, {
      messages: [
        { seq: 0, type: "text", content: "hello" },
        { seq: 1, type: "tool_use", tool: "Bash", input: { cmd: "ls" } },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().last_seq).toBe(1);

    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}/messages?after_seq=-1` });
    expect(got.json()).toHaveLength(2);
    expect(got.json()[1].tool).toBe("Bash");
    expect(got.json()[1].input_json).toBe('{"cmd":"ls"}');

    const incremental = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}/messages?after_seq=0` });
    expect(incremental.json()).toHaveLength(1);
  });

  it("rejects seq gap with 409 + last_seq for resync", async () => {
    await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 0, type: "text", content: "a" }] });
    const res = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 5, type: "text", content: "b" }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().last_seq).toBe(0);
    const ok = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 1, type: "text", content: "b" }] });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects messages with wrong token", async () => {
    const res = await post(`/api/daemon/tasks/${pkg.task.id}/messages`, { messages: [{ seq: 0, type: "text", content: "x" }] }, "bad");
    expect(res.statusCode).toBe(401);
  });
});
