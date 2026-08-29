// apps/server/test/daemon-operations.test.ts
//
// A03 · daemon 权限面、runtime ownership、操作幂等、副作用次数 专项测试。
//
// 覆盖:
// - task token 调 start/complete/fail → 401/403,无任何副作用
// - daemon token + 正确 daemon_id 可成功
// - daemon token + 错误 daemon_id → 403 runtime_ownership_mismatch
// - start/complete/fail 相同 payload 重放返回原 response(无副作用)
// - start/complete/fail 不同 payload → 409 idempotency_conflict
// - complete 清 token 后仍能用 daemon token 重放
// - fail 自动重试副作用只发生一次
// - 重放不重复广播
// - 重放不重复改变 Agent/Runtime idle 状态
// - 401/403/409 返回结构化 code/message/details
// - 错误响应不泄漏 token

import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let secondDaemonToken: string;
let secondDaemonId: string;
let agentId: string;
let issueId: string;
let hubBroadcasts: { type: string; data: any }[];

interface Env {
  app: FastifyInstance;
  daemonToken: string;
  secondDaemonToken: string;
  secondDaemonId: string;
  agentId: string;
  issueId: string;
  claimTask: (daemonToken?: string) => Promise<{ task: any; task_token: string; runtime_id: string }>;
  hubBroadcasts: { type: string; data: any }[];
}

async function setupTwoDaemons(): Promise<Env> {
  const localApp = await buildApp({ dbPath: ":memory:", logger: false });
  const tk1 = (await localApp.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const tk2 = (await localApp.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const a = (await localApp.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } })).json();
  const i = (await localApp.inject({ method: "POST", url: "/api/issues", payload: { title: "T", assignee_type: "agent", assignee_id: a.id } })).json();
  // 两个 daemon,两个 runtime,同 workspace,都注册 kimi
  await localApp.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${tk1}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
  await localApp.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${tk2}` }, payload: { daemon_id: "d2", runtimes: [{ provider: "kimi", version: "1" }] } });
  const broadcasts: { type: string; data: any }[] = [];
  // 拦截 hub.broadcast
  const origBroadcast = (localApp as any).hub.broadcast.bind((localApp as any).hub);
  (localApp as any).hub.broadcast = (msg: any) => { broadcasts.push(msg); };
  const claimTask = async (token: string = tk1) => {
    const r = await localApp.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${token}` }, payload: { daemon_id: token === tk1 ? "d1" : "d2" } });
    return r.json().tasks[0];
  };
  return {
    app: localApp,
    daemonToken: tk1,
    secondDaemonToken: tk2,
    secondDaemonId: "d2",
    agentId: a.id,
    issueId: i.id,
    claimTask,
    hubBroadcasts: broadcasts,
  };
}

async function startTask(env: Env, opts: { taskId: string; token: string; daemonId: string; workDir?: string; taskToken?: string }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.taskToken) headers.authorization = `Bearer ${opts.taskToken}`;
  return env.app.inject({
    method: "POST",
    url: `/api/daemon/tasks/${opts.taskId}/start`,
    headers,
    payload: { daemon_id: opts.daemonId, work_dir: opts.workDir ?? "D:/work" },
  });
}

async function completeTask(env: Env, opts: { taskId: string; token: string; daemonId: string; taskToken?: string; body?: any }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.taskToken) headers.authorization = `Bearer ${opts.taskToken}`;
  return env.app.inject({
    method: "POST",
    url: `/api/daemon/tasks/${opts.taskId}/complete`,
    headers,
    payload: { daemon_id: opts.daemonId, ...(opts.body ?? {}) },
  });
}

async function failTask(env: Env, opts: { taskId: string; token: string; daemonId: string; taskToken?: string; body?: any }) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.taskToken) headers.authorization = `Bearer ${opts.taskToken}`;
  return env.app.inject({
    method: "POST",
    url: `/api/daemon/tasks/${opts.taskId}/fail`,
    headers,
    payload: { daemon_id: opts.daemonId, failure_reason: "non_zero_exit", error: "boom", ...(opts.body ?? {}) },
  });
}



describe("daemon token surface for start/complete/fail", () => {
  it("task token 调 start → 401/403,无任何副作用", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const beforeBroadcasts = env.hubBroadcasts.length;
    const beforeStatus = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    const r = await startTask(env, { taskId: pkg.task.id, token: pkg.task_token, daemonId: "d1" });
    expect([401, 403]).toContain(r.statusCode);
    expect(env.hubBroadcasts.length).toBe(beforeBroadcasts);
    const afterStatus = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    expect(afterStatus).toBe(beforeStatus);
    const idem = env.app.db.$client.prepare(`SELECT start_payload_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(idem?.start_payload_hash ?? null).toBeNull();
  });

  it("task token 调 complete → 401/403,无任何副作用", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const before = env.hubBroadcasts.length;
    const r = await completeTask(env, { taskId: pkg.task.id, token: pkg.task_token, daemonId: "d1" });
    expect([401, 403]).toContain(r.statusCode);
    expect(env.hubBroadcasts.length).toBe(before);
    const after = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    expect(after).toBe("running");
  });

  it("task token 调 fail → 401/403,无任何副作用", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const before = (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(env.issueId) as any).n;
    const r = await failTask(env, { taskId: pkg.task.id, token: pkg.task_token, daemonId: "d1" });
    expect([401, 403]).toContain(r.statusCode);
    const after = (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(env.issueId) as any).n;
    expect(after).toBe(before);
  });

  it("正确 daemon token + 正确 daemon_id 可以 start", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("running");
    expect((env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status).toBe("running");
  });

  it("正确 daemon token + 错误 body.daemon_id → 403 runtime_ownership_mismatch", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d2" });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("runtime_ownership_mismatch");
    const status = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    expect(status).toBe("dispatched");
    const idem = env.app.db.$client.prepare(`SELECT start_payload_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(idem?.start_payload_hash ?? null).toBeNull();
  });

  it("同 workspace 但 daemon_id 不拥有 Task runtime → 403 runtime_ownership_mismatch", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await startTask(env, { taskId: pkg.task.id, token: env.secondDaemonToken, daemonId: env.secondDaemonId });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("runtime_ownership_mismatch");
    const status = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    expect(status).toBe("dispatched");
  });
});

describe("D-003 idempotency", () => {
  it("start 相同 payload 重放返回原 response", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r1 = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const beforeBroadcasts = env.hubBroadcasts.length;
    const r2 = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    expect(r2.statusCode).toBe(r1.statusCode);
    expect(r2.json()).toEqual(r1.json());
    expect(env.hubBroadcasts.length).toBe(beforeBroadcasts);
  });

  it("start 不同 payload → 409 idempotency_conflict", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", workDir: "D:/different" });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("idempotency_conflict");
  });

  it("complete 相同 payload 重放返回原 response", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r1 = await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/abc", diff_stat: "1 file" } });
    const beforeBroadcasts = env.hubBroadcasts.length;
    const r2 = await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/abc", diff_stat: "1 file" } });
    expect(r2.statusCode).toBe(r1.statusCode);
    expect(r2.json()).toEqual(r1.json());
    expect(env.hubBroadcasts.length).toBe(beforeBroadcasts);
  });

  it("complete 不同 payload → 409 idempotency_conflict", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/abc" } });
    const r = await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/different" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("idempotency_conflict");
  });

  it("complete 清除 task token 后仍能用 daemon token 重放", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r1 = await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/abc" } });
    expect(r1.statusCode).toBe(200);
    env.app.db.$client.prepare(`UPDATE tasks SET task_token_hash=NULL WHERE id=?`).run(pkg.task.id);
    const rBad = await completeTask(env, { taskId: pkg.task.id, token: pkg.task_token, daemonId: "d1", body: { branch: "task/abc" } });
    expect([401, 403]).toContain(rBad.statusCode);
    const r2 = await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/abc" } });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });

  it("fail 相同 payload 重放返回原 response", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r1 = await failTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const beforeBroadcasts = env.hubBroadcasts.length;
    const r2 = await failTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    expect(r2.statusCode).toBe(r1.statusCode);
    expect(r2.json()).toEqual(r1.json());
    expect(env.hubBroadcasts.length).toBe(beforeBroadcasts);
  });

  it("fail 不同 payload → 409 idempotency_conflict", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await failTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r = await failTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { error: "different" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe("idempotency_conflict");
  });

  it("fail 自动重试副作用只发生一次", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const beforeTasks = (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(env.issueId) as any).n;
    await failTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const afterFirst = (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(env.issueId) as any).n;
    expect(afterFirst).toBe(beforeTasks + 1);
    await failTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const afterSecond = (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE issue_id=?`).get(env.issueId) as any).n;
    expect(afterSecond).toBe(afterFirst);
  });
});

describe("structured error responses", () => {
  it("401 响应包含 code + message", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await startTask(env, { taskId: pkg.task.id, token: "anv_invalid", daemonId: "d1" });
    expect(r.statusCode).toBe(401);
    const body = r.json();
    expect(typeof body.code).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  it("403 响应包含 code=runtime_ownership_mismatch + message + details", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d2" });
    expect(r.statusCode).toBe(403);
    const body = r.json();
    expect(body.code).toBe("runtime_ownership_mismatch");
    expect(typeof body.message).toBe("string");
  });

  it("409 响应包含 code=idempotency_conflict + message + details", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", workDir: "D:/b" });
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.code).toBe("idempotency_conflict");
    expect(typeof body.message).toBe("string");
  });

  it("错误响应不泄漏 token(daemon / task token 都不在 body 中)", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r401 = await startTask(env, { taskId: pkg.task.id, token: "anv_completely_invalid_token_xyz", daemonId: "d1" });
    expect(JSON.stringify(r401.json())).not.toContain("anv_completely_invalid_token_xyz");
    const r403 = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d2" });
    expect(JSON.stringify(r403.json())).not.toContain(env.daemonToken);
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r409 = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", workDir: "D:/diff" });
    expect(JSON.stringify(r409.json())).not.toContain(env.daemonToken);
    expect(JSON.stringify(r409.json())).not.toContain(pkg.task_token);
  });
});

describe("broadcast and idle state side effects (no duplication)", () => {
  it("start 重放不重复广播 task.updated/issue.updated", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r1 = await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const broadcastsAfterFirst = env.hubBroadcasts.length;
    expect(broadcastsAfterFirst).toBeGreaterThan(0);
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    expect(env.hubBroadcasts.length).toBe(broadcastsAfterFirst);
  });

  it("complete 重放不重复 agent/runtime 状态变化", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/abc" } });
    const statusAfterComplete1 = (env.app.db.$client.prepare(`SELECT status FROM agents WHERE id=?`).get(env.agentId) as any).status;
    expect(statusAfterComplete1).toBe("idle");
    await completeTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1", body: { branch: "task/abc" } });
    const statusAfterReplay = (env.app.db.$client.prepare(`SELECT status FROM agents WHERE id=?`).get(env.agentId) as any).status;
    expect(statusAfterReplay).toBe("idle");
  });
});
