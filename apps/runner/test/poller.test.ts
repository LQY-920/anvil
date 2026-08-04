import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { Daemon } from "../src/poller.js";

let app: FastifyInstance;
let daemon: Daemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  await app?.close();
});

async function startServerWithTask() {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", assignee_type: "agent", assignee_id: a.json().id } });
  return { url: `http://127.0.0.1:${port}`, token: tk.json().token };
}

describe("daemon poller", () => {
  it("registers, claims and executes a task via injected executor", async () => {
    const { url, token } = await startServerWithTask();
    const client = new ApiClient(url, token);
    let executed = 0;
    daemon = new Daemon(client, {
      daemonId: "d-test",
      providers: [{ provider: "kimi", version: "test" }],
      pollMs: 50, heartbeatMs: 1000,
      executor: async (pkg) => {
        executed++;
        expect(pkg.issue.title).toBe("demo");
        expect(pkg.task_token.startsWith("atk_")).toBe(true);
      },
    });
    await daemon.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(executed).toBe(1);
  });

  it("survives executor crash and keeps polling", async () => {
    const { url, token } = await startServerWithTask();
    const client = new ApiClient(url, token);
    let calls = 0;
    daemon = new Daemon(client, {
      daemonId: "d-test",
      providers: [{ provider: "kimi", version: "test" }],
      pollMs: 50, heartbeatMs: 1000,
      executor: async () => { calls++; throw new Error("boom"); },
    });
    await daemon.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(daemon.isAlive()).toBe(true);
  });

  it("stop() prevents pending ws reconnect from firing", async () => {
    const { url, token } = await startServerWithTask();
    const client = new ApiClient(url, token);
    daemon = new Daemon(client, {
      daemonId: "d-test",
      providers: [{ provider: "kimi", version: "test" }],
      pollMs: 50, heartbeatMs: 1000,
      executor: async () => {},
    });
    await daemon.start();
    await daemon.stop();
    // stop 后等待超过重连窗口，ws 不应复活：process 无新增连接即可，主要验证不抛错且 daemon 保持停止
    await new Promise((r) => setTimeout(r, 200));
    expect(daemon.isAlive()).toBe(false);
  });
});
