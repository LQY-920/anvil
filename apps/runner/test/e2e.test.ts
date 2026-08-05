import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { Daemon } from "../src/poller.js";
import { executeTask } from "../src/executor.js";
import type { AgentBackend } from "../src/agents/backend.js";
import type { AgentMessage } from "@anvil/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: FastifyInstance;
let daemon: Daemon | null = null;

afterEach(async () => { await daemon?.stop(); await app?.close(); });

/** E2E happy path：创建 issue 并指派 → daemon 自动认领执行 → completed。 */
it("create issue → daemon claims → completes end to end", async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;

  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  const issue = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "E2E 任务", assignee_type: "agent", assignee_id: a.json().id },
  });

  const fakeBackend: AgentBackend = {
    provider: "kimi",
    execute(opts) {
      const messages = (async function* (): AsyncGenerator<AgentMessage> {
        yield { type: "text", content: "e2e working" };
        yield { type: "tool_use", tool: "Bash", input: { command: "echo hi" } };
      })();
      // 好 Agent：进程退出前按目标契约回调推进 issue（否则 executor 会发起未交付追问）
      const result = (async () => {
        await fetch(`${opts.env.ANVIL_SERVER_URL}/api/daemon/tasks/${opts.env.ANVIL_TASK_ID}/issue-status`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.env.ANVIL_TOKEN}` },
          body: JSON.stringify({ status: "in_review" }),
        });
        return { status: "completed" as const, exitCode: 0 };
      })();
      return {
        messages,
        result,
        kill: () => {},
      };
    },
  };

  const client = new ApiClient(url, daemonToken);
  const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-e2e-"));
  daemon = new Daemon(client, {
    daemonId: "e2e-daemon",
    providers: [{ provider: "kimi", version: "e2e" }],
    pollMs: 50,
    heartbeatMs: 1000,
    executor: (pkg) => executeTask({ client, backend: fakeBackend, runnerRoot, cancelPollMs: 100 }, pkg),
  });
  await daemon.start();

  // 等待任务完成（最多 5s）
  let task: any = null;
  for (let i = 0; i < 50; i++) {
    const tasks = (await app.inject({ method: "GET", url: `/api/issues/${issue.json().id}/tasks` })).json();
    if (tasks[0]?.status === "completed") { task = tasks[0]; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(task?.status).toBe("completed");

  const msgs = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/messages` })).json();
  expect(msgs.map((m: any) => m.type)).toEqual(["text", "tool_use"]);

  const runtimes = (await app.inject({ method: "GET", url: "/api/runtimes" })).json();
  expect(runtimes[0].status).toBe("online");
}, 10000);
