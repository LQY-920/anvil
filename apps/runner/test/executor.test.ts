import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { executeTask, buildPrompt } from "../src/executor.js";
import type { AgentBackend } from "../src/agents/backend.js";
import type { AgentMessage } from "@anvil/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: FastifyInstance;

afterEach(async () => { await app?.close(); });

function fakeBackend(behavior: "success" | "crash" | "hang"): AgentBackend & { readonly killed: boolean } {
  const state = { killed: false };
  const backend: AgentBackend = {
    provider: "kimi",
    execute() {
      const messages = (async function* (): AsyncGenerator<AgentMessage> {
        if (behavior === "hang") {
          while (!state.killed) await new Promise((r) => setTimeout(r, 20));
          return;
        }
        yield { type: "text", content: "working..." };
      })();
      const result = new Promise<any>((resolve) => {
        if (behavior === "success") setTimeout(() => resolve({ status: "completed", exitCode: 0 }), 50);
        if (behavior === "crash") setTimeout(() => resolve({ status: "failed", exitCode: 1, error: "exit 1" }), 50);
        if (behavior === "hang") {
          const t = setInterval(() => { if (state.killed) { clearInterval(t); resolve({ status: "cancelled" }); } }, 20);
        }
      });
      return { messages, result, kill: () => { state.killed = true; } };
    },
  };
  // 注意：Object.assign 会把 getter 快照成静态值，必须用 defineProperty 才能实时反映 state.killed
  Object.defineProperty(backend, "killed", { get() { return state.killed; } });
  return backend as AgentBackend & { readonly killed: boolean };
}

async function setup() {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  const i = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "修复登录 bug", assignee_type: "agent", assignee_id: a.json().id } });
  const client = new ApiClient(url, tk.json().token);
  await client.register("d1", [{ provider: "kimi", version: "test" }]);
  const { tasks } = await client.claim("d1");
  const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-runner-"));
  return { client, pkg: tasks[0], runnerRoot, issueId: i.json().id };
}

describe("executor", () => {
  it("happy path: start → stream messages → complete", async () => {
    const { client, pkg, runnerRoot } = await setup();
    await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50 }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.work_dir).toContain(runnerRoot);
    const msgs = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}/messages` });
    expect(msgs.json().some((m: any) => m.content === "working...")).toBe(true);
  });

  it("crash path: reports fail with failure_reason", async () => {
    const { client, pkg, runnerRoot } = await setup();
    await executeTask({ client, backend: fakeBackend("crash"), runnerRoot, cancelPollMs: 50 }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("failed");
    expect(got.json().task.failure_reason).toBe("non_zero_exit");
  });

  it("cancel path: kills backend when task cancelled on server", async () => {
    const { client, pkg, runnerRoot } = await setup();
    const backend = fakeBackend("hang");
    const run = executeTask({ client, backend, runnerRoot, cancelPollMs: 50 }, pkg);
    await new Promise((r) => setTimeout(r, 150));
    await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    await run;
    expect(backend.killed).toBe(true);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("cancelled");
  });

  it("buildPrompt carries issue content and callback instruction", () => {
    const p = buildPrompt(
      { title: "标题", description: "描述" } as any,
      { id: "t1" } as any,
    );
    expect(p).toContain("标题");
    expect(p).toContain("描述");
    expect(p).toContain("issue-status");
    expect(p).toContain("ANVIL_TOKEN");
  });

  it("buildPrompt includes comments section between task and requirements", () => {
    const p = buildPrompt(
      { title: "标题", description: "描述" } as any,
      { id: "t1" } as any,
      [
        { author_type: "member", body: "第一条评论内容", created_at: "2026-08-04T00:00:00Z" },
        { author_type: "agent", body: "第二条评论内容", created_at: "2026-08-04T00:01:00Z" },
        { author_type: "system", body: "任务失败（idle_timeout），自动重试 2/3", created_at: "2026-08-04T00:02:00Z" },
      ],
    );
    expect(p).toContain("# 讨论与补充意见（按时间）");
    expect(p).toContain("- [member] 第一条评论内容");
    expect(p).toContain("- [agent] 第二条评论内容");
    expect(p).toContain("- [system] 任务失败（idle_timeout），自动重试 2/3");
    expect(p.indexOf("# 任务")).toBeLessThan(p.indexOf("# 讨论与补充意见（按时间）"));
    expect(p.indexOf("# 讨论与补充意见（按时间）")).toBeLessThan(p.indexOf("# 要求"));
  });

  it("buildPrompt keeps each comment on one line and truncates body to 500 chars", () => {
    const longBody = "x".repeat(600);
    const p = buildPrompt(
      { title: "标题", description: null } as any,
      { id: "t1" } as any,
      [
        { author_type: "member", body: "第一行\n第二行", created_at: "2026-08-04T00:00:00Z" },
        { author_type: "member", body: longBody, created_at: "2026-08-04T00:01:00Z" },
      ],
    );
    const section = p.split("# 讨论与补充意见（按时间）")[1];
    const commentLines = section.split("\n").filter((l) => l.startsWith("- ["));
    expect(commentLines).toHaveLength(2);
    expect(commentLines[0]).toBe("- [member] 第一行 第二行");
    expect(commentLines[1]).toBe(`- [member] ${"x".repeat(500)}`);
  });

  it("buildPrompt omits comments section when comments is empty", () => {
    const p = buildPrompt(
      { title: "标题", description: "描述" } as any,
      { id: "t1" } as any,
      [],
    );
    expect(p).not.toContain("讨论与补充意见");
  });

  it("does not leak daemon token into agent env", async () => {
    const { client, pkg, runnerRoot } = await setup();
    process.env.ANVIL_DAEMON_TOKEN = "anv_supersecret";
    let capturedEnv: Record<string, string> | null = null;
    const capturing: AgentBackend = {
      provider: "kimi",
      execute(opts) {
        capturedEnv = opts.env;
        return {
          messages: (async function* () {})(),
          result: Promise.resolve({ status: "completed", exitCode: 0 }),
          kill: () => {},
        };
      },
    };
    try {
      await executeTask({ client, backend: capturing, runnerRoot, cancelPollMs: 50 }, pkg);
    } finally {
      delete process.env.ANVIL_DAEMON_TOKEN;
    }
    expect(capturedEnv).not.toBeNull();
    expect(capturedEnv!["ANVIL_DAEMON_TOKEN"]).toBeUndefined();
    expect(capturedEnv!["ANVIL_TOKEN"]).toBe(pkg.task_token);
  });
});
