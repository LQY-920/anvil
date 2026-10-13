// apps/runner/test/executor.test.ts
//
// A03 更新:start/complete/fail 改用 daemon token + daemonId,messages/status/delivery 保持 task token;
// 新增 10 个 A03 专项测试覆盖:Agent env 隔离 / daemonId 显式传递 / fetch retry。

import { describe, it, expect, afterEach, vi } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { executeTask, buildPrompt } from "../src/executor.js";
import * as verificationModule from "../src/verification.js";
import type { AgentBackend } from "../src/agents/backend.js";
import type { AgentMessage } from "@anvil/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

  it("GitHub 连接环境变量及值别名不进入 Agent，Provider 普通环境仍保留", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "ANVIL_TEST_TOKEN_ALIAS", "ANVIL_TEST_PROVIDER_VALUE"];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names.slice(0, 4)) process.env[name] = `fake-connection-secret-${name}`;
    process.env.ANVIL_TEST_TOKEN_ALIAS = `alias:${process.env.GH_TOKEN}`;
    process.env.ANVIL_TEST_PROVIDER_VALUE = "provider-config";
    let captured: Record<string, string> = {};
    const backend: AgentBackend = { provider: "kimi", execute(opts) { captured = opts.env; return { messages: (async function* () {})(), result: Promise.resolve({ status: "completed", exitCode: 0 }), kill() {} }; } };
    try { await executeTask({ client, backend, runnerRoot, daemonId }, pkg); }
    finally { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; } }
    for (const name of names.slice(0, 5)) expect(captured[name]).toBeUndefined();
    expect(captured.ANVIL_TEST_PROVIDER_VALUE).toBe("provider-config");
    expect(captured.ANVIL_TOKEN).toBe(pkg.task_token);
  });

  it("损坏的绑定快照在启动 Agent 前失败，不降级使用 Issue 路径", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup();
    pkg.task.repository_snapshot_json = "{坏快照";
    const backend = fakeBackend("success"), execute = vi.spyOn(backend, "execute");
    await executeTask({ client, backend, runnerRoot, daemonId }, pkg);
    expect(execute).not.toHaveBeenCalled();
    expect((await app.inject(`/api/tasks/${pkg.task.id}`)).json().task).toMatchObject({ status: "failed", work_dir: null });
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

  it.each([1, 3])("v1 第 %i 轮回调成功后不标记未交付", async (deliveryRound) => {
    const { client, pkg, runnerRoot, url, daemonId } = await setup();
    // A05: 把 task 标为 v1,保留旧 issue-status=in_review 回调路径。
    // 同步修改内存对象 pkg.task,executor 的 isV2Task 是从内存对象读取。
    pkg.task.delivery_contract_version = 1;
    app.db.$client.prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`).run(pkg.task.id);
    let calls = 0;
    const delivering: AgentBackend = {
      provider: "kimi",
      execute() {
        calls++;
        const result = (async () => {
          if (calls !== deliveryRound) return { status: "completed" as const, exitCode: 0 };
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
    expect(calls).toBe(deliveryRound);
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

// =============================================================================
// A04 · Git 锚点 + 固定 Diff 范围 + Start 上报 v2 锚点
// =============================================================================

describe("executor · A04 Git anchors & fixed diff", () => {
  // 公共 setup:创建一个本地 Git 仓库,创建带 repo_path 的 issue,claim 出对应 task。
  // 流程不复用默认 setup() 的"无 repo_path" issue,而是单独造一个本地仓库 + agent + issue。
  async function setupGitIssue() {
    const { client, url, daemonId, daemonToken } = await setup();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-a04-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const preHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const preBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).toString().trim();
    // 新建 agent(避免占用 setup() 默认 agent 的并发槽)
    const a = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: `bot-a04-${Date.now()}`, provider: "kimi" } })).json();
    const i = (await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "A04 git 任务", assignee_type: "agent", assignee_id: a.id, repo_path: repo },
    })).json();
    const claim = await client.claim("d1", 5);
    const pkg = claim.tasks.find((t: any) => t.issue.id === i.id)!;
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-a04-runner-"));
    return { client, url, daemonId, daemonToken, runnerRoot, repo, preHead, preBranch, pkg };
  }

  /** 制造一个 commit-in-worktree 的 fake backend:首次 execute 在 workDir 内 commit 一个新文件,
   *  追问轮(同 backend 复用)不再 commit,模拟真实 Agent "提交过就不再补" 的行为。 */
  function commitBackend(label: string): AgentBackend {
    let committed = false;
    return {
      provider: "kimi",
      execute(opts) {
        const cwd = opts.workDir;
        if (!committed) {
          execFileSync("git", ["config", "user.email", "t@t"], { cwd });
          execFileSync("git", ["config", "user.name", "t"], { cwd });
          fs.writeFileSync(path.join(cwd, `${label}.txt`), `${label} change`);
          execFileSync("git", ["add", "-A"], { cwd });
          execFileSync("git", ["commit", "-m", `${label} commit`], { cwd });
          committed = true;
        }
        return {
          messages: (async function* () { yield { type: "text", content: "working" }; })(),
          result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
          kill: () => {},
        };
      },
    };
  }

  it("A04: Git 仓库任务 Start body 精确包含 daemon_id / work_dir / task_branch / target_branch / base_commit / delivery_contract_version=2", async () => {
    const { client, pkg, runnerRoot, daemonId, preHead, preBranch } = await setupGitIssue();
    const { calls, restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) {
        const body = JSON.parse(init.body as string);
        expect(body.daemon_id).toBe(daemonId);
        expect(typeof body.work_dir).toBe("string");
        expect(body.task_branch).toBe(`task/${pkg.task.id.slice(0, 8)}`);
        expect(body.target_branch).toBe(preBranch);
        expect(body.base_commit).toBe(preHead);
        expect(body.delivery_contract_version).toBe(2);
        // Start body 不含 head_commit
        expect(body.head_commit).toBeUndefined();
        return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      }
      if (url.includes("/complete")) return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      return okJson({});
    });
    try {
      await executeTask({ client, backend: commitBackend("start"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      const startCalls = calls.filter((c) => c.url.includes("/start"));
      expect(startCalls).toHaveLength(1);
    } finally { restore(); }
  });

  it("A04: 无 repo_path 任务继续使用兼容 Start body,只含 daemon_id + work_dir,不含 v2 锚点", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setup(); // setup() 默认 issue 无 repo_path
    const { calls, restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) {
        const body = JSON.parse(init.body as string);
        expect(body.daemon_id).toBe(daemonId);
        expect(typeof body.work_dir).toBe("string");
        // 不伪造 Git 锚点
        expect(body.task_branch).toBeUndefined();
        expect(body.target_branch).toBeUndefined();
        expect(body.base_commit).toBeUndefined();
        expect(body.delivery_contract_version).toBeUndefined();
        return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      }
      if (url.includes("/complete")) return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      return okJson({});
    });
    try {
      await executeTask({ client, backend: fakeBackend("success"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      const startCalls = calls.filter((c) => c.url.includes("/start"));
      expect(startCalls).toHaveLength(1);
    } finally { restore(); }
  });

  it("A04: Start transport retry 复用同一序列化 payload,所有重试 body 字节完全一致", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setupGitIssue();
    let callCount = 0;
    const seenStartBodies: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) {
        seenStartBodies.push(init.body as string);
        callCount++;
        if (callCount === 1) throw new Error("ECONNRESET start transport error");
        return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      }
      if (url.includes("/complete")) return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      return okJson({});
    });
    try {
      await executeTask({ client, backend: commitBackend("retry"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      expect(callCount).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < seenStartBodies.length; i++) {
        expect(seenStartBodies[i]).toBe(seenStartBodies[0]);
      }
    } finally { restore(); }
  });

  it("A04: Agent commit 后,Complete 的 diff_stat 来自 base..head 而非 HEAD,不能为空", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setupGitIssue();
    let capturedComplete: any = null;
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      if (url.includes("/complete")) {
        capturedComplete = JSON.parse(init.body as string);
        return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      }
      return okJson({});
    });
    try {
      await executeTask({ client, backend: commitBackend("diff"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      expect(capturedComplete).not.toBeNull();
      // diff_stat 非空且包含本次 commit 的文件
      expect(typeof capturedComplete.diff_stat).toBe("string");
      expect(capturedComplete.diff_stat.length).toBeGreaterThan(0);
      expect(capturedComplete.diff_stat).toContain("diff.txt");
      // branch 来自 prepared 锚点
      expect(capturedComplete.branch).toBe(`task/${pkg.task.id.slice(0, 8)}`);
    } finally { restore(); }
  });

  it("A04: 现有行为不退化 —— start 仍使用 daemon token", async () => {
    const { client, pkg, runnerRoot, daemonId, daemonToken } = await setupGitIssue();
    const seenAuths: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start") || url.includes("/complete") || url.includes("/fail")) {
        const auth = (init.headers as any)?.authorization;
        if (typeof auth === "string") seenAuths.push(auth);
        if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
        if (url.includes("/complete")) return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
        return okJson({ ok: true, task_id: pkg.task.id, status: "failed" });
      }
      return okJson({});
    });
    try {
      await executeTask({ client, backend: commitBackend("reg"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      for (const a of seenAuths) {
        expect(a).toBe(`Bearer ${daemonToken}`);
      }
      expect(seenAuths.length).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it("A04: Git 任务执行成功后,server 端 Task 行写入完整 v2 锚点(task_branch/target_branch/base_commit)", async () => {
    // 走真 server,不 mock start,验证 server 落库端行为(R1-FIX2 已允许 start 携带 v2 锚点)
    const { client, pkg, runnerRoot, daemonId } = await setupGitIssue();
    await executeTask({ client, backend: commitBackend("anchor"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    const task = got.json().task;
    expect(task.task_branch).toBe(`task/${pkg.task.id.slice(0, 8)}`);
    expect(task.target_branch).toBe("main");
    expect(task.base_commit).toMatch(/^[0-9a-f]{40}$/i);
  });
});

// =============================================================================
// A04-FIX1 · 执行期间分支漂移:detached HEAD / 切换到其他分支 → 不发 complete,改走 fail
// =============================================================================

describe("executor · A04-FIX1 branch drift", () => {
  async function setupGitIssue() {
    const { client, url, daemonId, daemonToken } = await setup();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-drift-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const a = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: `bot-drift-${Date.now()}`, provider: "kimi" } })).json();
    const i = (await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "drift 任务", assignee_type: "agent", assignee_id: a.id, repo_path: repo },
    })).json();
    const claim = await client.claim("d1", 5);
    const pkg = claim.tasks.find((t: any) => t.issue.id === i.id)!;
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-drift-runner-"));
    return { client, url, daemonId, daemonToken, runnerRoot, repo, pkg };
  }

  /** Agent 行为:execute 时主动切换 worktree 分支(模拟 Agent 跑完后切换了分支)。 */
  function makeDriftBackend(action: "detach" | "switchBranch" | "normal", label: string): AgentBackend {
    let didDrift = false;
    return {
      provider: "kimi",
      execute(opts) {
        const cwd = opts.workDir;
        try {
          execFileSync("git", ["config", "user.email", "t@t"], { cwd });
          execFileSync("git", ["config", "user.name", "t"], { cwd });
          if (action === "detach") {
            const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
            execFileSync("git", ["checkout", "--detach", head], { cwd });
            didDrift = true;
          } else if (action === "switchBranch") {
            const other = `other/${label}`;
            try {
              execFileSync("git", ["checkout", "-b", other], { cwd });
            } catch {
              execFileSync("git", ["checkout", other], { cwd });
            }
            fs.writeFileSync(path.join(cwd, `${label}.txt`), `${label} drift`);
            execFileSync("git", ["add", "-A"], { cwd });
            execFileSync("git", ["commit", "-m", `${label} drift commit`], { cwd });
            didDrift = true;
          } else {
            // 正常:在 task/<short> 分支上 commit
            fs.writeFileSync(path.join(cwd, `${label}.txt`), `${label} change`);
            execFileSync("git", ["add", "-A"], { cwd });
            execFileSync("git", ["commit", "-m", `${label} commit`], { cwd });
          }
        } catch (e) {
          // 测试断言会反映错误
        }
        return {
          messages: (async function* () { yield { type: "text", content: `drifted=${didDrift}` }; })(),
          result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
          kill: () => {},
        };
      },
    };
  }

  it("A04-FIX1: Agent 执行后 worktree 进入 detached HEAD → 不发 complete,改走 fail,executeTask resolve", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setupGitIssue();
    let completeCalls = 0;
    let failCalls = 0;
    const failBodies: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      if (url.includes("/complete")) { completeCalls++; return okJson({ ok: true, task_id: pkg.task.id, status: "completed" }); }
      if (url.includes("/fail")) { failCalls++; if (init?.body) failBodies.push(init.body as string); return okJson({ ok: true, task_id: pkg.task.id, status: "failed" }); }
      return okJson({});
    });
    try {
      await expect(executeTask({ client, backend: makeDriftBackend("detach", "d1"), runnerRoot, cancelPollMs: 50, daemonId }, pkg))
        .resolves.toBeUndefined();
      // 关键:complete 调用次数必须为 0
      expect(completeCalls).toBe(0);
      // fail 至少 1 次(包含 detached HEAD 错误)
      expect(failCalls).toBeGreaterThan(0);
      // 失败原因应反映 detached
      const allErr = failBodies.join("\n");
      expect(allErr).toMatch(/detached/i);
    } finally { restore(); }
  });

  it("A04-FIX1: Agent 切到其他分支(HEAD 仍是合法 40 位 SHA) → 不发 complete,改走 fail", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setupGitIssue();
    let completeCalls = 0;
    let failCalls = 0;
    const failBodies: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      if (url.includes("/complete")) { completeCalls++; return okJson({ ok: true, task_id: pkg.task.id, status: "completed" }); }
      if (url.includes("/fail")) { failCalls++; if (init?.body) failBodies.push(init.body as string); return okJson({ ok: true, task_id: pkg.task.id, status: "failed" }); }
      return okJson({});
    });
    try {
      await expect(executeTask({ client, backend: makeDriftBackend("switchBranch", "s1"), runnerRoot, cancelPollMs: 50, daemonId }, pkg))
        .resolves.toBeUndefined();
      // 关键:complete 调用次数必须为 0
      expect(completeCalls).toBe(0);
      // fail 至少 1 次
      expect(failCalls).toBeGreaterThan(0);
      const allErr = failBodies.join("\n");
      expect(allErr).toMatch(/branch|taskBranch|mismatch|不一致/i);
    } finally { restore(); }
  });

  it("A04-FIX1: 正常留在 prepared.taskBranch → complete 正常发送,既有 A04 行为不回归", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setupGitIssue();
    let completeCalls = 0;
    let capturedComplete: any = null;
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      if (url.includes("/complete")) {
        completeCalls++;
        capturedComplete = JSON.parse(init.body as string);
        return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      }
      return okJson({});
    });
    try {
      await executeTask({ client, backend: makeDriftBackend("normal", "n1"), runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      expect(completeCalls).toBe(1);
      expect(capturedComplete).not.toBeNull();
      expect(capturedComplete.branch).toBe(`task/${pkg.task.id.slice(0, 8)}`);
      expect(capturedComplete.diff_stat).toContain("n1.txt");
    } finally { restore(); }
  });
});

// =============================================================================
// A04-FIX1 · ApiClient.startTask 锚点 all-or-none 严格校验
//   - 三锚点齐全 → 精确六字段 v2 Start
//   - 三锚点全空(null / 不传)→ 精确两字段兼容 Start
//   - 任何部分锚点 / 空 branch / 非 40 位 base_commit → 抛错,fetch 不调用
//   - 合法 Start 的 transport retry 复用同一序列化 payload
// =============================================================================

describe("ApiClient · A04-FIX1 start anchor validation", () => {
  function makeClient(): { client: ApiClient; baseUrl: string } {
    const baseUrl = "http://127.0.0.1:0";
    return { client: new ApiClient(baseUrl, "anv_dummy"), baseUrl };
  }

  it("三锚点齐全 → 精确六字段 v2 Start (task_branch/target_branch/base_commit/delivery_contract_version=2)", async () => {
    const { client } = makeClient();
    const seen: { url: string; body: string } = { url: "", body: "" };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      seen.url = typeof input === "string" ? input : input.url ?? String(input);
      seen.body = init?.body as string;
      return new Response(JSON.stringify({ ok: true, task_id: "t1", status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      await client.startTask("t1", "d1", "/tmp/w", {
        taskBranch: "task/abcd1234", targetBranch: "main",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
      });
      expect(seen.url).toContain("/api/daemon/tasks/t1/start");
      const body = JSON.parse(seen.body);
      expect(body).toEqual({
        daemon_id: "d1", work_dir: "/tmp/w",
        task_branch: "task/abcd1234",
        target_branch: "main",
        base_commit: "0123456789abcdef0123456789abcdef01234567",
        delivery_contract_version: 2,
      });
    } finally { spy.mockRestore(); }
  });

  it("anchors=null → 精确两字段兼容 Start,只含 daemon_id + work_dir", async () => {
    const { client } = makeClient();
    const seen: { url: string; body: string } = { url: "", body: "" };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      seen.url = typeof input === "string" ? input : input.url ?? String(input);
      seen.body = init?.body as string;
      return new Response(JSON.stringify({ ok: true, task_id: "t1", status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      await client.startTask("t1", "d1", "/tmp/w", null);
      const body = JSON.parse(seen.body);
      expect(body).toEqual({ daemon_id: "d1", work_dir: "/tmp/w" });
      // 不得含有 v2 字段
      expect(body.task_branch).toBeUndefined();
      expect(body.target_branch).toBeUndefined();
      expect(body.base_commit).toBeUndefined();
      expect(body.delivery_contract_version).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it("anchors={全 null} → 精确两字段兼容 Start", async () => {
    const { client } = makeClient();
    const seen: { url: string; body: string } = { url: "", body: "" };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
      seen.url = typeof input === "string" ? input : input.url ?? String(input);
      seen.body = init?.body as string;
      return new Response(JSON.stringify({ ok: true, task_id: "t1", status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      await client.startTask("t1", "d1", "/tmp/w", { taskBranch: null, targetBranch: null, baseCommit: null });
      const body = JSON.parse(seen.body);
      expect(body).toEqual({ daemon_id: "d1", work_dir: "/tmp/w" });
    } finally { spy.mockRestore(); }
  });

  it("只传 taskBranch(部分锚点) → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", { taskBranch: "task/abcd", targetBranch: null, baseCommit: null });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      // 错误信息列的是缺失字段(targetBranch, baseCommit),不是已传的 taskBranch
      const msg = String(thrown.message);
      expect(msg).toContain("targetBranch");
      expect(msg).toContain("baseCommit");
      expect(msg).toContain("缺失");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("只传 targetBranch/baseCommit(部分锚点) → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", { taskBranch: null, targetBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567" });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      // 错误信息列的是缺失字段(taskBranch)
      const msg = String(thrown.message);
      expect(msg).toContain("taskBranch");
      expect(msg).toContain("缺失");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("taskBranch 为 null 但 target/baseCommit 有值 → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", { taskBranch: null, targetBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567" });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(String(thrown.message)).toContain("taskBranch");
      expect(String(thrown.message)).toContain("缺失");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("空字符串 taskBranch → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", { taskBranch: "   ", targetBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567" });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(String(thrown.message)).toContain("taskBranch");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("空字符串 targetBranch → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", { taskBranch: "task/abcd", targetBranch: "", baseCommit: "0123456789abcdef0123456789abcdef01234567" });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(String(thrown.message)).toContain("targetBranch");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("非 40 位 baseCommit(短 SHA) → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", { taskBranch: "task/abcd", targetBranch: "main", baseCommit: "abc123" });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(String(thrown.message)).toContain("baseCommit");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("非 40 位 baseCommit(全 40 字符但含非法字符) → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", {
          taskBranch: "task/abcd", targetBranch: "main",
          baseCommit: "g".repeat(40),
        });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(String(thrown.message)).toContain("baseCommit");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("非 40 位 baseCommit(40 字符但不是 hex) → 抛错,fetch 0 次", async () => {
    const { client } = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("fetch should not be called");
    });
    try {
      let thrown: any = null;
      try {
        await client.startTask("t1", "d1", "/tmp/w", {
          taskBranch: "task/abcd", targetBranch: "main",
          baseCommit: "z".repeat(40),
        });
      } catch (e: any) { thrown = e; }
      expect(thrown).not.toBeNull();
      expect(String(thrown.message)).toContain("baseCommit");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("opWithRetry 对合法 Start 仍复用同一个序列化 payload (transport error → 同 body 重试)", async () => {
    const { client } = makeClient();
    const seen: string[] = [];
    let callCount = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: any, init: any) => {
      seen.push(init?.body as string);
      callCount++;
      if (callCount === 1) throw new Error("ECONNRESET transport");
      return new Response(JSON.stringify({ ok: true, task_id: "t1", status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      await client.startTask("t1", "d1", "/tmp/w", {
        taskBranch: "task/abcd", targetBranch: "main",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
      });
      expect(callCount).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).toBe(seen[0]);
      }
    } finally { spy.mockRestore(); }
  });
});

// =============================================================================
// A04-FIX2 · executeTask 真实收敛:Resume worktree 不存在 / 仓库身份不一致
//
// 关键不变量(代替旧的"无脑 fresh"):
//   - prepareWorkdir 抛错 → executeTask 必须 resolve(不外抛),poller 不受影响
//   - start / complete 调用次数必须为 0(不得发出任何 Start)
//   - fail 必须被调用(状态被收敛为失败)
//   - runnerRoot 下不得新建 task/<id> worktree 或孤儿分支
//   - 错误信息必须明确指向失败原因(Resume worktree 不存在 / 仓库身份不一致)
// =============================================================================

describe("executor · A04-FIX2 resume guard convergence", () => {
  // 公共辅助:造一个本地 Git 仓库
  function setupRepo(prefix: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    return repo;
  }

  it("A04-FIX2: Server 已持久化完整锚点但 prior worktree 在执行前被删除 → resolve,start=0,complete=0,fail>0,runnerRoot 不建新 worktree", async () => {
    const repo = setupRepo("anvil-fix2-exec-");
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix2-runner-"));
    app = await buildApp({ dbPath: ":memory:", logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const url = `http://127.0.0.1:${port}`;
    const tk = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json();
    const a = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } })).json();
    const i = (await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "fix2", assignee_type: "agent", assignee_id: a.id, repo_path: repo },
    })).json();
    const client = new ApiClient(url, tk.token);
    await client.register("d1", [{ provider: "kimi", version: "1.0.0" }]);
    const { tasks } = await client.claim("d1", 5);
    const first = tasks.find((t: any) => t.issue.id === i.id)!;

    // 把 Task 的锚点写满(模拟 Server 持久化的完整 Resume 锚点)
    app.db.$client.prepare(
      `UPDATE tasks SET task_branch=?, target_branch=?, base_commit=? WHERE id=?`,
    ).run("task/12345678", "main", "0123456789abcdef0123456789abcdef01234567", first.task.id);

    // 重新读 task + issue(锚点已落库)
    const reloadedTask = app.db.$client.prepare(`SELECT * FROM tasks WHERE id=?`).get(first.task.id) as any;
    const reloadedIssueResp = (await app.inject({ method: "GET", url: `/api/issues/${i.id}` })).json();
    const reloadedIssue = reloadedIssueResp.issue;
    expect(reloadedTask.task_branch).toBe("task/12345678");
    expect(reloadedIssue.repo_path).toBe(repo);

    // 关键:fakeWorkDir 不存在 —— 模拟 prior worktree 被删
    const fakeWorkDir = path.join(runnerRoot, "worktrees", first.task.id.slice(0, 8));
    expect(fs.existsSync(fakeWorkDir)).toBe(false);

    let executeCalls = 0;
    let startCalls = 0;
    let completeCalls = 0;
    let failCalls = 0;
    const failBodies: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) { startCalls++; return okJson({ ok: true, task_id: first.task.id, status: "running" }); }
      if (url.includes("/complete")) { completeCalls++; return okJson({ ok: true, task_id: first.task.id, status: "completed" }); }
      if (url.includes("/fail")) { failCalls++; if (init?.body) failBodies.push(init.body as string); return okJson({ ok: true, task_id: first.task.id, status: "failed" }); }
      return okJson({});
    });
    const noop: AgentBackend = {
      provider: "kimi",
      execute() { executeCalls++; return { messages: (async function* () {})(), result: Promise.resolve({ status: "completed" as const, exitCode: 0 }), kill: () => {} }; },
    };

    const pkg: any = {
      task: reloadedTask,
      issue: reloadedIssue,
      prior_work_dir: fakeWorkDir,
      task_token: first.task_token,
      comments: [],
    };

    try {
      await expect(executeTask({ client, backend: noop, runnerRoot, cancelPollMs: 50, daemonId: "d1" }, pkg))
        .resolves.toBeUndefined();
      expect(executeCalls).toBe(0);
      expect(startCalls).toBe(0);
      expect(completeCalls).toBe(0);
      expect(failCalls).toBeGreaterThan(0);
      const allErr = failBodies.join("\n");
      expect(allErr).toMatch(/不存在|Resume worktree/i);
      expect(fs.existsSync(path.join(runnerRoot, "worktrees", first.task.id.slice(0, 8)))).toBe(false);
    } finally { restore(); }
  });

  it("A04-FIX2: prior worktree 属于仓库 A 但 pkg.issue.repo_path 是仓库 B → backend.execute=0,start=0,complete=0,fail>0,错误指向仓库不一致", async () => {
    const repoA = setupRepo("anvil-fix2a-");
    const repoB = setupRepo("anvil-fix2b-");
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix2-runner-"));

    app = await buildApp({ dbPath: ":memory:", logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const url = `http://127.0.0.1:${port}`;
    const tk = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json();
    const a = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } })).json();
    const i = (await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "fix2 mismatch", assignee_type: "agent", assignee_id: a.id, repo_path: repoA },
    })).json();
    const client = new ApiClient(url, tk.token);
    await client.register("d1", [{ provider: "kimi", version: "1.0.0" }]);
    const { tasks } = await client.claim("d1", 5);
    const first = tasks.find((t: any) => t.issue.id === i.id)!;

    // 先准备一个属于 repoA 的 worktree(模拟 prior)
    const wt = path.join(runnerRoot, "worktrees", first.task.id.slice(0, 8));
    execFileSync("git", ["-C", repoA, "worktree", "add", "-b", "task/12345678", wt, "HEAD"]);
    expect(fs.existsSync(wt)).toBe(true);

    // 把 Task 的锚点写满(模拟 Server 持久化的完整 Resume 锚点)
    app.db.$client.prepare(
      `UPDATE tasks SET task_branch=?, target_branch=?, base_commit=? WHERE id=?`,
    ).run("task/12345678", "main", "0123456789abcdef0123456789abcdef01234567", first.task.id);

    // 关键:把 issue.repo_path 改为 repoB(模拟 PATCH Issue 改 repo_path)
    app.db.$client.prepare(`UPDATE issues SET repo_path=? WHERE id=?`).run(repoB, i.id);

    // 重新读 task + issue
    const reloadedTask = app.db.$client.prepare(`SELECT * FROM tasks WHERE id=?`).get(first.task.id) as any;
    const reloadedIssueResp = (await app.inject({ method: "GET", url: `/api/issues/${i.id}` })).json();
    const reloadedIssue = reloadedIssueResp.issue;
    expect(reloadedTask.task_branch).toBe("task/12345678");
    expect(reloadedIssue.repo_path).toBe(repoB);

    let executeCalls = 0;
    let startCalls = 0;
    let completeCalls = 0;
    let failCalls = 0;
    const failBodies: string[] = [];
    const { restore } = interceptFetch(async (url, init) => {
      if (url.includes("/start")) { startCalls++; return okJson({ ok: true, task_id: first.task.id, status: "running" }); }
      if (url.includes("/complete")) { completeCalls++; return okJson({ ok: true, task_id: first.task.id, status: "completed" }); }
      if (url.includes("/fail")) { failCalls++; if (init?.body) failBodies.push(init.body as string); return okJson({ ok: true, task_id: first.task.id, status: "failed" }); }
      return okJson({});
    });
    const noop: AgentBackend = {
      provider: "kimi",
      execute() { executeCalls++; return { messages: (async function* () {})(), result: Promise.resolve({ status: "completed" as const, exitCode: 0 }), kill: () => {} }; },
    };

    const pkg: any = {
      task: reloadedTask,
      issue: reloadedIssue,
      prior_work_dir: wt,
      task_token: first.task_token,
      comments: [],
    };

    try {
      await expect(executeTask({ client, backend: noop, runnerRoot, cancelPollMs: 50, daemonId: "d1" }, pkg))
        .resolves.toBeUndefined();
      expect(executeCalls).toBe(0);
      expect(startCalls).toBe(0);
      expect(completeCalls).toBe(0);
      expect(failCalls).toBeGreaterThan(0);
      const allErr = failBodies.join("\n");
      expect(allErr).toMatch(/仓库|repo|repository|不一致|不匹配/i);
      const branchesB = execFileSync("git", ["branch", "--list"], { cwd: repoB }).toString();
      expect(branchesB).not.toContain("task/12345678");
    } finally { restore(); }
  });
});

// =============================================================================
// A05 · Delivery Report、v2 delivered_at 与同会话追问契约
//
// 关键不变量:
//  1. v2 prompt 显式要求 commit + rev-parse HEAD + Delivery Report 提交
//  2. v2 prompt 不得要求 issue-status=in_review/done
//  3. v1 prompt 保留旧 issue-status 回调说明
//  4. v2 Report SHA 与当前 HEAD 一致 → 不追问
//  5. v2 缺 Report → 最多追问两轮
//  6. v2 Report SHA 不一致 → 追问
//  7. 第一次追问更新为正确 SHA → 停止追问
//  8. 追问中产生新 commit → 重新读取 HEAD,并再次识别旧 Report 失效
//  9. 连续两轮仍 mismatch → complete 为 undelivered
//  10. mismatch 时不得调用 fail
// 11. GET delivery 使用 task token,不泄漏 daemon token
// 12. v1 旧行为不回归(issue-status 路径)
// =============================================================================

describe("A05 · buildPrompt v1/v2 分流", () => {
  it("v1 prompt 仍要求 issue-status=in_review 回调", () => {
    const issue = { title: "标题", description: "描述", acceptance: "1. 改完" } as any;
    const task = { id: "t1", delivery_contract_version: 1 } as any;
    const p = buildPrompt(issue, task);
    expect(p).toContain("issue-status");
    expect(p).toContain("in_review");
  });

  it("v2 prompt 要求 commit + rev-parse HEAD + Delivery Report 提交", () => {
    const issue = { title: "标题", description: "描述", acceptance: "1. 改完" } as any;
    const task = { id: "t1", delivery_contract_version: 2 } as any;
    const p = buildPrompt(issue, task);
    expect(p).toContain("Delivery Report");
    expect(p).toContain("rev-parse HEAD");
    expect(p).toContain("delivery-report");
    expect(p).toContain("report_head_commit");
  });

  it("v2 prompt 不要求 issue-status=in_review/done,blocked 保留", () => {
    const issue = { title: "标题", description: "描述", acceptance: null } as any;
    const task = { id: "t1", delivery_contract_version: 2 } as any;
    const p = buildPrompt(issue, task);
    // v2 prompt 应明确禁止 Agent 自己推进 in_review
    expect(p).not.toMatch(/issue-status.*in_review|status.*in_review/);
    // blocked 保留
    expect(p).toContain("blocked");
  });

  it("v2 prompt 包含 required fields(problem_understanding / solution_summary / changed_areas / risks / unresolved)", () => {
    const issue = { title: "标题", description: null, acceptance: null } as any;
    const task = { id: "t1", delivery_contract_version: 2 } as any;
    const p = buildPrompt(issue, task);
    for (const f of ["problem_understanding", "solution_summary", "changed_areas", "risks", "unresolved"]) {
      expect(p, `v2 prompt 缺字段 ${f}`).toContain(f);
    }
  });

  it("v2 prompt 不泄漏 daemon token,只使用 task token", () => {
    const issue = { title: "t", description: null, acceptance: null } as any;
    const task = { id: "t1", delivery_contract_version: 2 } as any;
    const p = buildPrompt(issue, task);
    expect(p).toContain("ANVIL_TOKEN");
    // 不得引用 ANVIL_DAEMON_TOKEN
    expect(p).not.toContain("ANVIL_DAEMON_TOKEN");
  });
});

describe("A05 · v2 同会话追问契约", () => {
  // 公共 setup:把当前 task 标为 v2(默认就是 2),并提供工作树(本地 git 仓库)。
  async function setupV2GitTask(verificationCode?: string) {
    const { client, url, daemonId } = await setup();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-a05-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    if (verificationCode) fs.writeFileSync(path.join(repo, "ANVIL.verify.json"), JSON.stringify({ version: 1, commands: [
      { id: "test", label: "真实终检", command: `"${process.execPath}" -e "${verificationCode}"`, required: true, timeout_ms: 10000 },
    ] }));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const a = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: `a05-${Date.now()}`, provider: "kimi" } })).json();
    const i = (await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "A05 v2 任务", assignee_type: "agent", assignee_id: a.id, repo_path: repo },
    })).json();
    const claim = await client.claim("d1", 5);
    const pkg = claim.tasks.find((t: any) => t.issue.id === i.id)!;
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-a05-runner-"));
    return { client, url, daemonId, runnerRoot, repo, pkg };
  }

  /** A05 用的 fake backend:每次 execute 时根据 report 状态决定下一步。
   *  `commit: "a" | "b" | null`
   *    - "a": 第一次 execute commit 一个文件,但不调 delivery-report
   *    - "b": 追问 execute 再 commit 一个新文件
   *    - null: 不 commit
   *  `submitReport: boolean` 是否在执行结束后自动 submit delivery-report
   *  `reportHead`: 提交时使用的 report_head_commit(默认与当前 head 一致)
   *
   *  注意:AgentBackend.execute 必须是同步返回 session 对象,
   *  不能 async(否则 executor 拿到的 session 是 Promise,session.messages 会变 undefined)。
   */
  function makeA05Backend(opts: {
    commit?: "a" | "b" | null;
    submitReport?: boolean;
    reportHead?: string;
    fakeClient?: { url: string; task_token: string; taskId: string };
  }): AgentBackend {
    let followupIndex = 0;
    return {
      provider: "kimi",
      execute(o) {
        const cwd = o.workDir;
        if (opts.commit) {
          try {
            execFileSync("git", ["config", "user.email", "t@t"], { cwd });
            execFileSync("git", ["config", "user.name", "t"], { cwd });
            const tag = o.resume ? `${opts.commit}_f${followupIndex}` : `${opts.commit}_0`;
            fs.writeFileSync(path.join(cwd, `${tag}.txt`), `${tag} change`);
            execFileSync("git", ["add", "-A"], { cwd });
            execFileSync("git", ["commit", "-m", `${tag} commit`], { cwd });
          } catch {
            // ignore
          }
        }
        if (o.resume) followupIndex++;
        const messages = (async function* (): AsyncGenerator<AgentMessage> {
          yield { type: "text", content: `execute resume=${o.resume}` };
        })();
        const result = (async () => {
          if (opts.submitReport && opts.fakeClient) {
            const { url, task_token, taskId } = opts.fakeClient;
            let head: string;
            try {
              head = opts.reportHead ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
            } catch (e: any) {
              return { status: "failed" as const, exitCode: 1, error: `rev-parse HEAD failed: ${e?.message}` };
            }
            try {
              const r = await fetch(`${url}/api/daemon/tasks/${taskId}/delivery-report`, {
                method: "PUT",
                headers: { "content-type": "application/json", authorization: `Bearer ${task_token}` },
                body: JSON.stringify({
                  schema_version: 1,
                  report_head_commit: head,
                  problem_understanding: "p",
                  solution_summary: "s",
                  changed_areas: [{ path: "src/a.ts", summary: "x" }],
                  risks: [],
                  unresolved: [],
                }),
              });
              // 读取 body 让连接复用
              await r.text().catch(() => undefined);
            } catch {
              // ignore fetch errors
            }
          }
          return { status: "completed" as const, exitCode: 0 };
        })();
        return { messages, result, kill: () => {} };
      },
    };
  }

  it.each([1, 2, 3])("A05: 第 %i 轮绑定最终 HEAD 的 Report 被确认，停止追问且不标记未交付", async (deliveryRound) => {
    const { client, pkg, runnerRoot, daemonId } = await setupV2GitTask();
    const query = vi.spyOn(client, "getTaskDelivery");
    const fail = vi.spyOn(client, "fail");
    const resumes: boolean[] = [];
    let finalHead = "";
    const backend: AgentBackend = {
      provider: "kimi",
      execute(opts) {
        resumes.push(opts.resume);
        const round = resumes.length;
        const result = (async () => {
          // 每轮推进 HEAD，确保最后一次追问读取的是最终版本。
          fs.writeFileSync(path.join(opts.workDir, "交付.txt"), `第 ${round} 轮`);
          execFileSync("git", ["add", "交付.txt"], { cwd: opts.workDir });
          execFileSync("git", ["commit", "-m", `第 ${round} 轮交付`], { cwd: opts.workDir });
          finalHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: opts.workDir }).toString().trim();
          const res = await app.inject({
            method: "PUT",
            url: `/api/daemon/tasks/${pkg.task.id}/delivery-report`,
            headers: { authorization: `Bearer ${pkg.task_token}` },
            payload: {
              schema_version: 1,
              report_head_commit: round === deliveryRound ? finalHead : pkg.task.base_commit ?? "0".repeat(40),
              problem_understanding: "核对交付版本",
              solution_summary: `第 ${round} 轮结果`,
              changed_areas: [{ path: "交付.txt", summary: "更新结果" }],
              risks: [], unresolved: [],
            },
          });
          expect(res.statusCode).toBe(200);
          return { status: "completed" as const, exitCode: 0 };
        })();
        return {
          messages: (async function* () {})(),
          result,
          kill: () => {},
        };
      },
    };
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.delivered_at).toBeTruthy();
    expect(JSON.parse(got.json().task.result_json).undelivered).toBeUndefined();
    expect(resumes).toEqual(Array.from({ length: deliveryRound }, (_, i) => i > 0));
    expect(query).toHaveBeenCalledTimes(deliveryRound);
    expect(fail).not.toHaveBeenCalled();
    const report = app.db.$client.prepare("SELECT report_head_commit FROM task_delivery_reports WHERE task_id = ?").get(pkg.task.id) as { report_head_commit: string };
    expect(report.report_head_commit).toBe(finalHead);
  });

  it("A06: Agent 已提交 Report，真实终检失败仍记录证据且不自动追加修复会话", async () => {
    const { client, pkg, runnerRoot, daemonId, url } = await setupV2GitTask("console.log('真实失败');process.exit(7)");
    const backend = makeA05Backend({ commit: "a", submitReport: true, fakeClient: { url, task_token: pkg.task_token, taskId: pkg.task.id } });
    const executions = vi.spyOn(backend, "execute");
    const complete = vi.spyOn(client, "complete");
    const fail = vi.spyOn(client, "fail");
    await executeTask({ client, backend, runnerRoot, daemonId, cancelPollMs: 50 }, pkg);
    expect(executions).toHaveBeenCalledTimes(1);
    expect(fail).not.toHaveBeenCalled();
    const payload = complete.mock.calls[0][2] as any;
    expect(payload.verification).toMatchObject({ status: "failed", verification_sha: payload.head_commit, checks: [{ exit_code: 7, status: "failed" }] });
    expect(payload.verification.checks[0].output_excerpt).toContain("真实失败");
    expect(payload.head_commit).not.toBe(payload.base_commit);
    expect(payload.worktree_clean).toBe(true);
    expect(payload.undelivered).toBeUndefined();
    const got = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    expect(got.task.status).toBe("completed");
    expect(JSON.parse(got.task.result_json).verification.status).toBe("failed");
  }, 15000);

  it("A06: 终检中取消会杀验证进程，不发送 complete 或 fail", async () => {
    const { client, pkg, runnerRoot, daemonId, url } = await setupV2GitTask("require('fs').writeFileSync('验证开始.txt','x');setInterval(()=>{},100)");
    const backend = makeA05Backend({ commit: "a", submitReport: true, fakeClient: { url, task_token: pkg.task_token, taskId: pkg.task.id } });
    const agentKill = vi.fn();
    const execute = backend.execute.bind(backend);
    vi.spyOn(backend, "execute").mockImplementation(opts => ({ ...execute(opts), kill: agentKill }));
    const complete = vi.spyOn(client, "complete");
    const fail = vi.spyOn(client, "fail");
    let cancelSent = false;
    const taskStatus = client.taskStatus.bind(client);
    vi.spyOn(client, "taskStatus").mockImplementation(async (id, token) => {
      const marker = path.join(runnerRoot, "worktrees", pkg.task.id.slice(0, 8), "验证开始.txt");
      if (!cancelSent && fs.existsSync(marker)) {
        cancelSent = true;
        await app.inject({ method: "POST", url: `/api/tasks/${id}/cancel` });
      }
      return taskStatus(id, token);
    });
    await executeTask({ client, backend, runnerRoot, daemonId, cancelPollMs: 50 }, pkg);
    expect(cancelSent).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(agentKill).not.toHaveBeenCalled();
    const got = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    expect(got.task.status).toBe("cancelled");
  }, 15000);

  it("A06: 终检后 HEAD 又推进，最终上报降为 stale 且 diff 绑定新 HEAD", async () => {
    const { client, pkg, runnerRoot, daemonId, url } = await setupV2GitTask("process.exit(0)");
    const backend = makeA05Backend({ commit: "a", submitReport: true, fakeClient: { url, task_token: pkg.task_token, taskId: pkg.task.id } });
    const complete = vi.spyOn(client, "complete");
    const verify = verificationModule.runVerification;
    vi.spyOn(verificationModule, "runVerification").mockImplementation(async opts => {
      const result = await verify(opts);
      expect(result.verification.status).toBe("passed");
      fs.writeFileSync(path.join(opts.workDir, "late.txt"), "终检之后的修改");
      execFileSync("git", ["add", "late.txt"], { cwd: opts.workDir });
      execFileSync("git", ["commit", "-m", "终检之后推进"], { cwd: opts.workDir });
      return result;
    });
    await executeTask({ client, backend, runnerRoot, daemonId, cancelPollMs: 50 }, pkg);
    const payload = complete.mock.calls[0][2] as any;
    expect(payload.verification.status).toBe("stale");
    expect(payload.head_commit).not.toBe(payload.verification.verification_sha);
    expect(payload.diff_stat).toContain("late.txt");
  }, 15000);

  it("A05: v2 缺 Report → 最多追问两轮,3 次 execute,最终 complete 为 undelivered", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setupV2GitTask();
    let executeCount = 0;
    const backend: AgentBackend = {
      provider: "kimi",
      execute() {
        executeCount++;
        return {
          messages: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
          kill: () => {},
        };
      },
    };
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    // 1 首次 + 2 追问 = 3
    expect(executeCount).toBe(3);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    const rj = JSON.parse(got.json().task.result_json);
    expect(rj.undelivered).toBe(true);
  });

  it("A05: v2 Report SHA 不一致 → 追问", async () => {
    const { client, pkg, runnerRoot, daemonId, url } = await setupV2GitTask();
    let executeCount = 0;
    const backend: AgentBackend = {
      provider: "kimi",
      execute(o) {
        executeCount++;
        // 第一次:commit 但不调用 delivery-report
        // 第二次:追问轮,提交一个与 head 不一致的 report
        if (o.resume) {
          const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: o.workDir }).toString().trim();
          const fake = "0".repeat(40);
          // 通过 app.inject 直接调 server 提交(更可靠,不走 fetch)
          const result = (async () => {
            await app.inject({
              method: "PUT",
              url: `/api/daemon/tasks/${pkg.task.id}/delivery-report`,
              headers: { authorization: `Bearer ${pkg.task_token}` },
              payload: {
                schema_version: 1,
                report_head_commit: fake,
                problem_understanding: "p",
                solution_summary: "s",
                changed_areas: [],
                risks: [],
                unresolved: [],
              },
            });
            return { status: "completed" as const, exitCode: 0 };
          })();
          return {
            messages: (async function* () {})(),
            result,
            kill: () => {},
          };
        } else {
          const cwd = o.workDir;
          try {
            execFileSync("git", ["config", "user.email", "t@t"], { cwd });
            execFileSync("git", ["config", "user.name", "t"], { cwd });
            fs.writeFileSync(path.join(cwd, "f0.txt"), "x");
            execFileSync("git", ["add", "-A"], { cwd });
            execFileSync("git", ["commit", "-m", "f0"], { cwd });
          } catch { /* ignore */ }
        }
        return {
          messages: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
          kill: () => {},
        };
      },
    };
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    // 1 首次 + 2 追问 = 3
    expect(executeCount).toBe(3);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
  });

  it("A05: 第一次追问更新为正确 SHA → 停止追问,execute=2", async () => {
    const { client, pkg, runnerRoot, daemonId, url } = await setupV2GitTask();
    let executeCount = 0;
    const backend: AgentBackend = {
      provider: "kimi",
      execute(o) {
        executeCount++;
        const cwd = o.workDir;
        try {
          execFileSync("git", ["config", "user.email", "t@t"], { cwd });
          execFileSync("git", ["config", "user.name", "t"], { cwd });
          const tag = o.resume ? `f1_${executeCount}` : `f0`;
          fs.writeFileSync(path.join(cwd, `${tag}.txt`), tag);
          execFileSync("git", ["add", "-A"], { cwd });
          execFileSync("git", ["commit", "-m", tag], { cwd });
        } catch { /* ignore */ }
        // 第一轮不提交 Report,追问轮 commit 后用当前 head 提交 Report
        const result = (async () => {
          if (o.resume) {
            const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
            await app.inject({
              method: "PUT",
              url: `/api/daemon/tasks/${pkg.task.id}/delivery-report`,
              headers: { authorization: `Bearer ${pkg.task_token}` },
              payload: {
                schema_version: 1,
                report_head_commit: head,
                problem_understanding: "p",
                solution_summary: "s",
                changed_areas: [],
                risks: [],
                unresolved: [],
              },
            });
          }
          return { status: "completed" as const, exitCode: 0 };
        })();
        return {
          messages: (async function* () {})(),
          result,
          kill: () => {},
        };
      },
    };
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    // 首轮 + 1 追问 = 2
    expect(executeCount).toBe(2);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    expect(got.json().task.delivered_at).toBeTruthy();
  });

  it("A05: 追问中产生新 commit → 重新读取 HEAD,旧 Report 再次被识别 mismatch", async () => {
    const { client, pkg, runnerRoot, daemonId, url } = await setupV2GitTask();
    let executeCount = 0;
    let firstHeadAfterCommit = "";
    const backend: AgentBackend = {
      provider: "kimi",
      execute(o) {
        executeCount++;
        const cwd = o.workDir;
        try {
          execFileSync("git", ["config", "user.email", "t@t"], { cwd });
          execFileSync("git", ["config", "user.name", "t"], { cwd });
        } catch { /* ignore */ }
        if (!o.resume) {
          // 首轮 commit 并提交 Report(head = X)
          fs.writeFileSync(path.join(cwd, "x0.txt"), "x0");
          execFileSync("git", ["add", "-A"], { cwd });
          execFileSync("git", ["commit", "-m", "x0"], { cwd });
          const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd }).toString().trim();
          firstHeadAfterCommit = head;
          // 提交 Report(head = X),让首次 execute 后 v2 判定 head=currentHead 匹配 → break,不追问
          // 但这样测试目标("后续追问")不会触发。改为第 1 轮不提交 Report,让 executor 看到 query.delivered=false → 追问。
          const result = (async () => {
            return { status: "completed" as const, exitCode: 0 };
          })();
          return {
            messages: (async function* () {})(),
            result,
            kill: () => {},
          };
        } else {
          // 追问轮 commit 一个新文件,但不调 delivery-report(模拟 agent 忘记)
          const tag = `x${executeCount}`;
          fs.writeFileSync(path.join(cwd, `${tag}.txt`), tag);
          execFileSync("git", ["add", "-A"], { cwd });
          execFileSync("git", ["commit", "-m", tag], { cwd });
        }
        return {
          messages: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
          kill: () => {},
        };
      },
    };
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    // 首轮 1 + 2 追问 = 3
    expect(executeCount).toBe(3);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    // undelivered 因为最终没有匹配的 report
    const rj = JSON.parse(got.json().task.result_json);
    expect(rj.undelivered).toBe(true);
    // 验证 head 已经推进
    const repoForTask = (await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` })).json();
    expect(rj.undelivered).toBe(true);
  });

  it("A05: 连续两轮仍 mismatch → complete 为 undelivered,不得调用 fail", async () => {
    const { client, pkg, runnerRoot, daemonId, url } = await setupV2GitTask();
    let failCalls = 0;
    let executeCount = 0;
    // 用真实 client 走完整 server 流程,只额外监控 fail 调用次数。
    const origFail = client.fail.bind(client);
    (client as any).fail = (taskId: string, daemonId: string, reason: string, error: string, workDir?: string) => {
      failCalls++;
      return origFail(taskId, daemonId, reason, error, workDir);
    };
    // 测试预期:backend 每次提交一个与 HEAD 不匹配的 Report,
    // 后续 2 轮追问都不修改 Report,query.head 永远不匹配 currentHead。
    const fake: AgentBackend = {
      provider: "kimi",
      execute() {
        executeCount++;
        return {
          messages: (async function* () {})(),
          result: (async () => {
            // 提交 Report(head 永远不匹配,因为是"0".repeat(40))
            await app.inject({
              method: "PUT",
              url: `/api/daemon/tasks/${pkg.task.id}/delivery-report`,
              headers: { authorization: `Bearer ${pkg.task_token}` },
              payload: {
                schema_version: 1,
                report_head_commit: "0".repeat(40),
                problem_understanding: "p",
                solution_summary: "s",
                changed_areas: [{ path: "src/a.ts", summary: "x" }],
                risks: [],
                unresolved: [],
              },
            });
            return { status: "completed" as const, exitCode: 0 };
          })(),
          kill: () => {},
        };
      },
    };
    await executeTask({ client, backend: fake, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    // 1 首次 + 2 追问 = 3(每次都提交与 HEAD 不匹配的 Report)
    expect(executeCount).toBe(3);
    expect(failCalls).toBe(0);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    const rj = JSON.parse(got.json().task.result_json);
    expect(rj.undelivered).toBe(true);
  });

  it("A05: GET delivery 使用 task token,不泄漏 daemon token", async () => {
    const { client, pkg, runnerRoot, daemonId } = await setupV2GitTask();
    // A05: 实际 client 是用 daemon token 构造,但 getTaskDelivery 必须用 task token。
    // 通过对比 client.daemonToken 与实际请求 auth 来验证。
    const daemonToken = (client as any).daemonToken;
    const { calls, restore } = interceptFetch(async (url, init) => {
      if (url.includes("/delivery")) {
        const auth = (init.headers as any)?.authorization;
        expect(auth).toBe(`Bearer ${pkg.task_token}`);
        // 不能是 daemon token
        expect(auth).not.toBe(`Bearer ${daemonToken}`);
        return okJson({ delivered: true, report_submitted: true, report_schema_version: 1, report_head_commit: "0".repeat(40), issue_status_requested: null });
      }
      if (url.includes("/delivery-report")) {
        return okJson({ ok: true, task_id: pkg.task.id, report_version: 1, report_head_commit: "0".repeat(40), submitted_at: "2026-01-01T00:00:00.000Z", replay: false });
      }
      if (url.includes("/start")) return okJson({ ok: true, task_id: pkg.task.id, status: "running" });
      if (url.includes("/complete")) return okJson({ ok: true, task_id: pkg.task.id, status: "completed" });
      return okJson({});
    });
    try {
      const backend: AgentBackend = {
        provider: "kimi",
        execute() {
          return {
            messages: (async function* () {})(),
            result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
            kill: () => {},
          };
        },
      };
      await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
      const deliveryCalls = calls.filter((c) => c.url.includes("/delivery") && !c.url.includes("/delivery-report"));
      expect(deliveryCalls.length).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it("A05: 无 repo_path 的 v2 Task 不构造假 SHA,缺 Report 仍走追问", async () => {
    // 默认 setup() issue 无 repo_path,但 default claim 出来的 v2 task 也属于 v2
    const { client, pkg, runnerRoot, daemonId } = await setup();
    let executeCount = 0;
    const backend: AgentBackend = {
      provider: "kimi",
      execute() {
        executeCount++;
        return {
          messages: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
          kill: () => {},
        };
      },
    };
    await executeTask({ client, backend, runnerRoot, cancelPollMs: 50, daemonId }, pkg);
    // 1 + 2 追问 = 3
    expect(executeCount).toBe(3);
    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    const rj = JSON.parse(got.json().task.result_json);
    expect(rj.undelivered).toBe(true);
  });
});
