// apps/runner/test/executor.test.ts
//
// A03 更新:start/complete/fail 改用 daemon token + daemonId,messages/status/delivery 保持 task token;
// 新增 10 个 A03 专项测试覆盖:Agent env 隔离 / daemonId 显式传递 / fetch retry。

import { describe, it, expect, afterEach, vi } from "vitest";
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

afterEach(async () => { await app?.close(); vi.restoreAllMocks(); });

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
  Object.defineProperty(backend, "killed", { get() { return state.killed; } });
  return backend as AgentBackend & { readonly killed: boolean };
}

async function setup() {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  const tk = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json();
  const a = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } })).json();
  const i = (await app.inject({ method: "POST", url: "/api/issues", payload: { title: "修复登录 bug", assignee_type: "agent", assignee_id: a.id } })).json();
  const client = new ApiClient(url, tk.token);
  await client.register("d1", [{ provider: "kimi", version: "test" }]);
  const { tasks } = await client.claim("d1");
  const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-runner-"));
  return { client, pkg: tasks[0], runnerRoot, issueId: i.id, url, daemonToken: tk.token, daemonId: "d1", task_token: tasks[0].task_token };
}

function capturePrompts(): { backend: AgentBackend; prompts: string[] } {
  const prompts: string[] = [];
  const backend: AgentBackend = {
    provider: "kimi",
    execute(opts) { prompts.push(opts.prompt); return { messages: (async function* () {})(), result: Promise.resolve({ status: "completed", exitCode: 0 }), kill: () => {} }; },
  };
  return { backend, prompts };
}

function seedWorkdir(runnerRoot: string, taskId: string): string {
  const dir = path.join(runnerRoot, "worktrees", taskId.slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 辅助:在测试中用 vi.spyOn 拦截 fetch,记录所有调用并用 handler 路由。 */
function interceptFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url ?? String(input);
    const safeInit: RequestInit = init ?? {};
    calls.push({ url, init: safeInit });
    return await handler(url, safeInit);
  });
  return { calls, restore: () => spy.mockRestore() };
}

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("executor", () => {
  it("happy path: start → stream messages → complete", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.work_dir).toContain(runnerRoot);
    const msgs = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}/messages` });
    expect(msgs.json().some((m: any) => m.content === "working...")).toBe(true);
  });

  it("crash path: reports fail with failure_reason", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    await executeTask({ client, backend: fakeBackend("crash"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("failed");
    expect(got.json().task.failure_reason).toBe("non_zero_exit");
  });

  it("cancel path: kills backend when task cancelled on server", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    const backend = fakeBackend("hang");
    const run = executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    await new Promise((r) => setTimeout(r, 150));
    await app.inject({ method: "POST", url: `/api/tasks/${pkg.task.id}/cancel` });
    await run;
    expect(backend.killed).toBe(true);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("cancelled");
  });

  it("buildPrompt carries issue content and callback instruction", () => {
    const p = buildPrompt({ title: "标题", description: "描述" } as any, { id: "t1" } as any);
    expect(p).toContain("标题");
    expect(p).toContain("描述");
    expect(p).toContain("issue-status");
    expect(p).toContain("ANVIL_TOKEN");
  });

  it("buildPrompt includes comments section after the boundaries section", () => {
    const p = buildPrompt(
      { title: "标题", description: "描述", acceptance: null } as any,
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
    expect(p.indexOf("# 目标")).toBeLessThan(p.indexOf("# 边界与停止规则"));
    expect(p.indexOf("# 边界与停止规则")).toBeLessThan(p.indexOf("# 讨论与补充意见（按时间）"));
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
    const p = buildPrompt({ title: "标题", description: "描述" } as any, { id: "t1" } as any, []);
    expect(p).not.toContain("讨论与补充意见");
  });

  // A03 · Agent 子进程 env 不含 daemon token(纵深防御 + ANVIL_DAEMON_TOKEN 不进 env)
  it("does not leak ANVIL_DAEMON_TOKEN or any daemon token into agent env", async () => {
    const { client, pkg, runnerRoot, daemonId, daemonToken } = await setup();
    process.env.ANVIL_DAEMON_TOKEN = "anv_supersecret_xyz";
    let capturedEnv: Record<string, string> | null = null;
    const capturing: AgentBackend = {
      provider: "kimi",
      execute(opts) { capturedEnv = opts.env; return { messages: (async function* () {})(), result: Promise.resolve({ status: "completed", exitCode: 0 }), kill: () => {} }; },
    };
    try {
      await executeTask({ client, backend: capturing, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    } finally { delete process.env.ANVIL_DAEMON_TOKEN; }
    expect(capturedEnv).not.toBeNull();
    // A03 断言 1: ANVIL_DAEMON_TOKEN 绝不能进入子进程 env
    expect(capturedEnv!["ANVIL_DAEMON_TOKEN"]).toBeUndefined();
    // A03 断言 2: 其他 daemon token 形式也不能进入(env 里所有键都不是 daemonToken 字符串)
    for (const [k, v] of Object.entries(capturedEnv!)) {
      expect(v, `env.${k} 不应包含 daemonToken`).not.toContain(daemonToken);
    }
    // ANVIL_TOKEN 仍使用 task token
    expect(capturedEnv!["ANVIL_TOKEN"]).toBe(pkg.task_token);
    expect(capturedEnv!["ANVIL_TASK_ID"]).toBe(pkg.task.id);
  });

  it("buildPrompt follows goal-contract structure with issue acceptance", () => {
    const p = buildPrompt({ title: "标题", description: "描述", acceptance: "1. 单测通过\n2. 已 commit" } as any, { id: "t1" } as any);
    expect(p).toContain("# 目标\n标题");
    expect(p).toContain("描述");
    expect(p).toContain("# 完成标准（全部满足才算交付）\n1. 单测通过\n2. 已 commit\n3. 调用平台回调把 issue 移到 in_review（见下）");
    expect(p).toContain("# 平台回调");
    expect(p).toContain("issue-status");
    expect(p).toContain("status=blocked");
    expect(p).toContain("# 边界与停止规则");
    expect(p.indexOf("# 目标")).toBeLessThan(p.indexOf("# 完成标准（全部满足才算交付）"));
    expect(p.indexOf("# 完成标准（全部满足才算交付）")).toBeLessThan(p.indexOf("# 平台回调"));
    expect(p.indexOf("# 平台回调")).toBeLessThan(p.indexOf("# 边界与停止规则"));
  });

  it("buildPrompt falls back to default acceptance when issue has none", () => {
    const p = buildPrompt({ title: "标题", description: null, acceptance: null } as any, { id: "t1" } as any);
    expect(p).toContain("1. 完成任务目标中的工作\n2. 改动已 git commit（保持当前分支）\n3. 调用平台回调把 issue 移到 in_review（见下）");
  });

  it("undelivered completion: follows up with resume twice, then completes with undelivered flag", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    const calls: { resume: boolean }[] = [];
    const neverDeliver: AgentBackend = {
      provider: "kimi",
      execute(opts) {
        calls.push({ resume: opts.resume });
        return { messages: (async function* (): AsyncGenerator<AgentMessage> { yield { type: "text", content: "working..." }; })(), result: Promise.resolve({ status: "completed", exitCode: 0 }), kill: () => {} };
      },
    };
    await executeTask({ client, backend: neverDeliver, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    expect(calls).toHaveLength(3);
    expect(calls[0].resume).toBe(false);
    expect(calls[1].resume).toBe(true);
    expect(calls[2].resume).toBe(true);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(JSON.parse(got.json().task.result_json).undelivered).toBe(true);
  });

  it("delivered completion: no follow-up, result_json has no undelivered flag", async () => {
    const { client, pkg, runnerRoot, url, daemonId } = await setup();
    let calls = 0;
    const delivering: AgentBackend = {
      provider: "kimi",
      execute() {
        calls++;
        const result = (async () => {
          const res = await fetch(`${url}/api/daemon/tasks/${pkg.task.id}/issue-status`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${pkg.task_token}` },
            body: JSON.stringify({ status: "in_review" }),
          });
          expect(res.status).toBe(200);
          return { status: "completed" as const, exitCode: 0 };
        })();
        return { messages: (async function* () {})(), result, kill: () => {} };
      },
    };
    await executeTask({ client, backend: delivering, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    expect(calls).toBe(1);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(JSON.parse(got.json().task.result_json).undelivered).toBeUndefined();
  });

  it("appends ANVIL.md guidance section to the end of prompt when present", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    fs.writeFileSync(path.join(seedWorkdir(runnerRoot, pkg.task.id), "ANVIL.md"), "改完跑 pnpm test");
    const { backend, prompts } = capturePrompts();
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    expect(prompts[0]).toContain("## 仓库常驻指引（ANVIL.md）\n\n改完跑 pnpm test");
    expect(prompts[0].indexOf("# 边界与停止规则")).toBeLessThan(prompts[0].indexOf("## 仓库常驻指引（ANVIL.md）"));
  });

  it("omits guidance section when workDir has no ANVIL.md", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    const { backend, prompts } = capturePrompts();
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    expect(prompts[0]).not.toContain("仓库常驻指引");
  });

  it("truncates ANVIL.md beyond 8KB and marks it", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    fs.writeFileSync(path.join(seedWorkdir(runnerRoot, pkg.task.id), "ANVIL.md"), "x".repeat(9000));
    const { backend, prompts } = capturePrompts();
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    expect(prompts[0]).toContain(`${"x".repeat(8 * 1024)}\n（已截断）`);
    expect(prompts[0]).not.toContain("x".repeat(8 * 1024 + 1));
  });

  it("silently skips unreadable ANVIL.md and still completes the task", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    fs.mkdirSync(path.join(seedWorkdir(runnerRoot, pkg.task.id), "ANVIL.md"));
    const { backend, prompts } = capturePrompts();
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    expect(prompts[0]).not.toContain("仓库常驻指引");
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
  });
});

// =============================================================================
// A03 · daemon token / daemonId 显式传递 / fetch 重试
// =============================================================================

describe("executor · A03 daemon token surface", () => {
  it("start / complete / fail 使用 daemon token + body 显式带 daemon_id", async () => {
    const { client, pkg, runnerRoot, daemonToken, daemonId } = await setup();
    const { calls, restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) {
        expect(init.headers && (init.headers as any).authorization).toBe(`Bearer ${daemonToken}`);
        const body = JSON.parse(init.body as string);
        expect(body.daemon_id).toBe(daemonId);
        return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      }
      if (url.includes("/complete")) {
        expect(init.headers && (init.headers as any).authorization).toBe(`Bearer ${daemonToken}`);
        const body = JSON.parse(init.body as string);
        expect(body.daemon_id).toBe(daemonId);
        // branch 字段在本地仓库可能为 undefined(测试不强制)
        return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      }
      return okJson({});
    });
    try {
      await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      const startCalls = calls.filter((c) => c.url.includes("/start"));
      const completeCalls = calls.filter((c) => c.url.includes("/complete"));
      expect(startCalls).toHaveLength(1);
      expect(completeCalls).toHaveLength(1);
    } finally { restore(); }
  });

  it("messages / taskStatus / taskDelivered 仍使用 task token", async () => {
    const { client, pkg, runnerRoot, daemonToken, task_token, daemonId } = await setup();
    const { calls, restore } = interceptFetch(async (url, init) => {
      if (url.includes("/messages")) {
        expect(init.headers && (init.headers as any).authorization).toBe(`Bearer ${task_token}`);
        return okJson({ last_seq: -1 });
      }
      if (url.includes("/status") || url.includes("/delivery")) {
        expect(init.headers && (init.headers as any).authorization).toBe(`Bearer ${task_token}`);
        return okJson({ status: "running", delivered: false });
      }
      if (url.includes("/start") || url.includes("/complete")) {
        expect(init.headers && (init.headers as any).authorization).toBe(`Bearer ${daemonToken}`);
        if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
        return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      }
      return okJson({});
    });
    try {
      await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      // 至少 1 个 messages 请求(来自 MessageUploader)
      const messagesCalls = calls.filter((c) => c.url.includes("/messages"));
      expect(messagesCalls.length).toBeGreaterThan(0);
      // status / delivery 来自 cancel 轮询
      const statusCalls = calls.filter((c) => c.url.includes("/status"));
      const deliveryCalls = calls.filter((c) => c.url.includes("/delivery"));
      expect(statusCalls.length + deliveryCalls.length).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it("transport error → 用完全相同 payload 重试", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    let callCount = 0;
    const serializedPayloads: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) {
        const body = init.body as string;
        serializedPayloads.push(body);
        callCount++;
        if (callCount === 1) throw new Error("ECONNRESET mock transport error");
        return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      }
      if (url.includes("/complete")) {
        return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      }
      return okJson({});
    });
    try {
      await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      expect(callCount).toBeGreaterThanOrEqual(2);
      // 重试时 body 字节完全一致(同一已序列化 payload)
      for (let i = 1; i < serializedPayloads.length; i++) {
        expect(serializedPayloads[i]).toBe(serializedPayloads[0]);
      }
    } finally { restore(); }
  });

  it("5xx → 用完全相同 payload 重试", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    let callCount = 0;
    const serializedPayloads: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) {
        serializedPayloads.push(init.body as string);
        callCount++;
        if (callCount === 1) return new Response("server error", { status: 500 });
        return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      }
      if (url.includes("/complete")) {
        return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      }
      return okJson({});
    });
    try {
      await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      expect(callCount).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < serializedPayloads.length; i++) {
        expect(serializedPayloads[i]).toBe(serializedPayloads[0]);
      }
    } finally { restore(); }
  });

  it("4xx → 不重试,ApiClient 1 次请求,executeTask 不外抛", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    let callCount = 0;
    const { restore } = interceptFetch(async (url) => {
      if (url.includes("/start")) {
        callCount++;
        return new Response(JSON.stringify({ code: "runtime_ownership_mismatch", message: "no" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      return okJson({});
    });
    try {
      // A03-FIX:executeTask 不外抛;4xx 走 best-effort fail(swallow),最终 resolve(undefined)
      await expect(executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg))
        .resolves.toBeUndefined();
      expect(callCount).toBe(1); // 只调 1 次,不重试
    } finally { restore(); }
  });

  it("Server 已提交 complete 但首次响应丢失:重放命中幂等回执,不会调用 fail", async () => {
    const { client, pkg, runnerRoot, url, daemonId } = await setup();
    // passthrough mock:让真实 server 处理请求,但首次 complete 完成后丢弃 Response 抛 transport error,
    // 触发 ApiClient 用相同 payload 重试;第二次请求会命中 server 端的 D-003 幂等回执。
    const realFetch = globalThis.fetch;
    let completeCallCount = 0;
    let failCalled = false;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = typeof input === "string" ? input : (input as any).url ?? String(input);
      if (u.includes("/complete")) {
        completeCallCount++;
        const response = await realFetch.call(globalThis, input as any, init as any);
        if (completeCallCount === 1) {
          // 第一次 complete 已让 server 真实提交并写幂等回执;模拟"响应丢失"——直接抛 transport error
          throw new Error("ECONNRESET response lost");
        }
        return response;
      }
      if (u.includes("/fail")) {
        failCalled = true;
      }
      return realFetch.call(globalThis, input as any, init as any);
    });
    try {
      await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      expect(completeCallCount).toBeGreaterThanOrEqual(2);
      expect(failCalled).toBe(false);
      const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
      expect(got.json().task.status).toBe("completed");
      // result_json 业务结果:daemon_id 不写进 result_json(只写业务字段)
      const result = JSON.parse(got.json().task.result_json);
      expect(result.daemon_id).toBeUndefined();
      // complete hash/response 已落库(说明第一次请求真的命中了 server)
      const idem = app.db.$client.prepare(`SELECT complete_payload_hash, complete_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
      expect(idem?.complete_payload_hash).toBeTruthy();
      expect(idem?.complete_response_json).toBeTruthy();
    } finally { spy.mockRestore(); }
  });

  it("complete 连续 3 次 transport error: total 3 complete calls, 0 fail calls, executeTask resolves", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    let completeCallCount = 0;
    let failCallCount = 0;
    const { restore } = interceptFetch(async (url) => {
      if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      if (url.includes("/complete")) {
        completeCallCount++;
        throw new Error("ECONNRESET persistent transport error");
      }
      if (url.includes("/fail")) { failCallCount++; return okJson({ ok: true, task_id: pkg.task.id, status: "failed" }); }
      return okJson({});
    });
    try {
      await expect(executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg))
        .resolves.toBeUndefined();
      // ApiClient 总尝试 3 次:首次 + 2 次重试
      expect(completeCallCount).toBe(3);
      // 一直 transport 失败 → 不允许构造新 fail
      expect(failCallCount).toBe(0);
    } finally { restore(); }
  });

  it("fail 连续 3 次 transport error: 同一 fail payload 重试 3 次,不发其他终态,executeTask resolves", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    let failCallCount = 0;
    let startCallCount = 0;
    let completeCallCount = 0;
    const seenFailBodies: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) {
        startCallCount++;
        return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      }
      if (url.includes("/fail")) {
        failCallCount++;
        seenFailBodies.push(init.body as string);
        throw new Error("ECONNRESET fail transport error");
      }
      if (url.includes("/complete")) {
        completeCallCount++;
        return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      }
      return okJson({});
    });
    try {
      // crash backend → executor 走 fail 路径
      await expect(executeTask({ client, backend: fakeBackend("crash"), runnerRoot, cancelPollMs: 50, daemonId }, pkg))
        .resolves.toBeUndefined();
      // fail 总尝试 3 次:首次 + 2 次重试;payload 字节完全相同
      expect(failCallCount).toBe(3);
      expect(seenFailBodies[0]).toBeTruthy();
      for (let i = 1; i < seenFailBodies.length; i++) {
        expect(seenFailBodies[i]).toBe(seenFailBodies[0]);
      }
      // 没有 start/complete 的副作用(只走了 fail 路径)
      expect(startCallCount).toBe(1); // start 调 1 次就成功
      expect(completeCallCount).toBe(0);
    } finally { restore(); }
  });

  it("重试次数有固定上限,不存在无限循环", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    let callCount = 0;
    const { restore } = interceptFetch(async (url) => {
      if (url.includes("/start")) {
        callCount++;
        return new Response("server error", { status: 500 });
      }
      return okJson({});
    });
    try {
      // 一直 500 → ApiClient 总尝试 3 次(首次 + 最多 2 次重试);executeTask 不外抛
      await expect(executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg))
        .resolves.toBeUndefined();
      expect(callCount).toBe(3);
    } finally { restore(); }
  });
});
