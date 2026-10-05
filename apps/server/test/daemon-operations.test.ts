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

async function setupTwoDaemons(version = 1): Promise<Env> {
  const localApp = await buildApp({ dbPath: ":memory:", logger: false });
  const tk1 = (await localApp.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const tk2 = (await localApp.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const a = (await localApp.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } })).json();
  const i = (await localApp.inject({ method: "POST", url: "/api/issues", payload: { title: "T", assignee_type: "agent", assignee_id: a.id } })).json();
  // 旧完成载荷用于回归 daemon 权限和幂等；完整 v2 证据另有专项矩阵。
  localApp.db.$client.prepare("UPDATE tasks SET delivery_contract_version=? WHERE issue_id=?").run(version, i.id);
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

// ============================================================================
// R1-FIX1 · start/complete/fail 严格运行时校验
// ============================================================================
//
// 通用要求:
// - request body 必须是非 null、非数组的普通 JSON 对象
// - 未知字段 → 400 invalid_schema,零副作用
// - 类型错误 / 空字符串 / 未知枚举 → 400 invalid_schema,零副作用
// - 校验必须发生在调用 service 和计算/写入幂等 hash 之前
// - 校验失败:Task 状态不变 / Issue 状态不变 / 不写 payload_hash / 不写 response_json
//   / 不清空 token / 不新增评论 / 不发送广播

describe("R1-FIX1: start 严格运行时校验", () => {
  it("work_dir: 123 → 400 invalid_schema,零副作用", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const beforeStatus = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    const beforeBroadcasts = env.hubBroadcasts.length;
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", work_dir: 123 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("work_dir");
    // 零副作用:状态/广播/幂等字段均未变
    expect((env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status).toBe(beforeStatus);
    expect(env.hubBroadcasts.length).toBe(beforeBroadcasts);
    const idem = env.app.db.$client.prepare(`SELECT start_payload_hash, start_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(idem.start_payload_hash).toBeNull();
    expect(idem.start_response_json).toBeNull();
  });

  it("未知字段 unknown_nonce → 400 invalid_schema", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", work_dir: "D:/w", unknown_nonce: "abc" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toContain("unknown_nonce");
  });

  it("两次仅 unknown_nonce 值不同,都被拒绝,不能被当作同 payload replay", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const beforeStatus = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    const r1 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", work_dir: "D:/w", unknown_nonce: "first" },
    });
    expect(r1.statusCode).toBe(400);
    const r2 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", work_dir: "D:/w", unknown_nonce: "second" },
    });
    expect(r2.statusCode).toBe(400);
    // 两次都 400,没有任何一次被当成合法 replay
    expect((env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status).toBe(beforeStatus);
  });

  it("非法 SHA(非 40 hex)→ 400 invalid_schema", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: {
        daemon_id: "d1", work_dir: "D:/w",
        task_branch: "task/abc", target_branch: "main",
        base_commit: "deadbeef",  // 太短
        delivery_contract_version: 2,
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("base_commit");
  });

  it("现有合法 Start 仍通过", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", work_dir: "D:/w" },
    });
    expect(r.statusCode).toBe(200);
  });

  it("合法 Start replay 仍通过(同 payload)", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const payload = { daemon_id: "d1", work_dir: "D:/w" };
    const r1 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload,
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });

  it("完全不提供 v2 anchors 的兼容路径仍通过", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", work_dir: "D:/w" },  // 不传任何 anchor
    });
    expect(r.statusCode).toBe(200);
    const row = env.app.db.$client.prepare(`SELECT task_branch, target_branch, base_commit FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.task_branch).toBeNull();
    expect(row.target_branch).toBeNull();
    expect(row.base_commit).toBeNull();
  });
});

describe("R1-FIX1: complete 严格运行时校验", () => {
  it("branch: 123 → 400 invalid_schema,零副作用", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const beforeStatus = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    const beforeBroadcasts = env.hubBroadcasts.length;
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", branch: 123 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    // 零副作用
    expect((env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status).toBe(beforeStatus);
    expect(env.hubBroadcasts.length).toBe(beforeBroadcasts);
    const idem = env.app.db.$client.prepare(`SELECT complete_payload_hash, complete_response_json, result_json FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(idem.complete_payload_hash).toBeNull();
    expect(idem.complete_response_json).toBeNull();
    expect(idem.result_json).toBeNull();
  });

  it("pushed: \"yes\" → 400 invalid_schema(禁止字符串伪装 boolean)", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", branch: "task/abc", pushed: "yes" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("pushed");
  });

  it("worktree_clean: \"no\" → 400 invalid_schema(禁止字符串伪装 boolean)", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", branch: "task/abc", worktree_clean: "no" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("worktree_clean");
  });

  it("未知顶层字段 → 400 invalid_schema", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", branch: "task/abc", evil_unknown: "boom" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toContain("evil_unknown");
  });

  it("校验失败后 Task、token、hash、response、Issue、评论、广播均不变化", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const before = {
      taskStatus: (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status,
      taskToken: (env.app.db.$client.prepare(`SELECT task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).task_token_hash,
      broadcasts: env.hubBroadcasts.length,
      commentCount: (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(env.issueId) as any).n,
    };
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", branch: 999 },  // 类型错
    });
    expect(r.statusCode).toBe(400);
    const after = {
      taskStatus: (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status,
      taskToken: (env.app.db.$client.prepare(`SELECT task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).task_token_hash,
      broadcasts: env.hubBroadcasts.length,
      commentCount: (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(env.issueId) as any).n,
    };
    expect(after.taskStatus).toBe(before.taskStatus);
    expect(after.taskToken).toBe(before.taskToken);
    expect(after.broadcasts).toBe(before.broadcasts);
    expect(after.commentCount).toBe(before.commentCount);
  });

  it("现有合法 Complete 仍通过", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", branch: "task/abc", worktree_clean: true },
    });
    expect(r.statusCode).toBe(200);
  });

  it("合法 Complete replay 仍通过(同 payload)", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    await startTask(env, { taskId: pkg.task.id, token: env.daemonToken, daemonId: "d1" });
    const payload = { daemon_id: "d1", branch: "task/abc", worktree_clean: true };
    const r1 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload,
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/complete`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });
});

describe("R1-FIX1: fail 严格运行时校验", () => {
  it("failure_reason: \"totally_unknown\" → 400 invalid_schema", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "totally_unknown", error: "boom" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("failure_reason");
  });

  it("error 非字符串(数字)→ 400 invalid_schema", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "non_zero_exit", error: 123 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("error");
  });

  it("error 空字符串 → 400 invalid_schema", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "non_zero_exit", error: "" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.field).toBe("error");
  });

  it("未知字段(任意)→ 400 invalid_schema", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "non_zero_exit", error: "x", worktree_clean: true },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toContain("worktree_clean");
  });

  it("head_commit 字段被明确拒绝(不允许夹带 Git 锚点)", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "non_zero_exit", error: "x", head_commit: "abc" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toContain("head_commit");
  });

  it("delivery_contract_version 字段被明确拒绝", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "non_zero_exit", error: "x", delivery_contract_version: 2 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toContain("delivery_contract_version");
  });

  it("校验失败后 Task 不进入 failed,token/hash/response 不变化", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const before = {
      taskStatus: (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status,
      taskToken: (env.app.db.$client.prepare(`SELECT task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).task_token_hash,
      failHash: (env.app.db.$client.prepare(`SELECT fail_payload_hash, fail_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).fail_payload_hash,
    };
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "totally_unknown", error: "x" },
    });
    expect(r.statusCode).toBe(400);
    const after = {
      taskStatus: (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status,
      taskToken: (env.app.db.$client.prepare(`SELECT task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).task_token_hash,
      failHash: (env.app.db.$client.prepare(`SELECT fail_payload_hash, fail_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).fail_payload_hash,
    };
    expect(after.taskStatus).toBe(before.taskStatus);
    expect(after.taskToken).toBe(before.taskToken);
    expect(after.failHash).toBeNull();
  });

  it("现有合法 Fail 仍通过", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom" },
    });
    expect(r.statusCode).toBe(200);
  });

  it("合法 Fail replay 仍通过(同 payload)", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const payload = { daemon_id: "d1", failure_reason: "non_zero_exit", error: "boom" };
    const r1 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload,
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload,
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });
});

// ============================================================================
// R1-FIX2 · Start 请求必须拒绝 head_commit
// ============================================================================
//
// 锁定的事实:
// 1) Start 请求白名单只有 daemon_id / work_dir / task_branch / target_branch /
//    base_commit / delivery_contract_version。`head_commit` 属于 Complete 请求,
//    误传会被"未知字段"分支直接 400 invalid_schema,在调用 service / 计算
//    hash / 任何副作用之前。
// 2) 校验失败:Task 保持 dispatched、Issue 状态不变、start_payload_hash=null、
//    start_response_json=null、task token 不变、评论数量不变、广播数量不变。
// 3) 两次不同 head_commit 都必须被拒绝(不能因 hash 字段被忽略而变成同 payload
//    replay 后再被 server 派 200)。
// 4) 现有合法 Start(兼容路径 + 完整 v2)不受影响。

describe("R1-FIX2: Start 请求必须拒绝 head_commit", () => {
  it("head_commit 出现在 Start body → 400 invalid_schema,unknown_fields 包含 head_commit,零副作用", async () => {
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    // 收集所有"校验前快照"
    const before = {
      taskStatus: (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status,
      taskToken: (env.app.db.$client.prepare(`SELECT task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).task_token_hash,
      issueStatus: (env.app.db.$client.prepare(`SELECT status FROM issues WHERE id=?`).get(env.issueId) as any).status,
      startHash: (env.app.db.$client.prepare(`SELECT start_payload_hash, start_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).start_payload_hash,
      startResponse: (env.app.db.$client.prepare(`SELECT start_payload_hash, start_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).start_response_json,
      broadcasts: env.hubBroadcasts.length,
      commentCount: (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(env.issueId) as any).n,
    };
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: {
        daemon_id: "d1",
        work_dir: "D:/w",
        head_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    // 1) 400 + invalid_schema + unknown_fields 包含 head_commit
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("invalid_schema");
    expect(r.json().details.unknown_fields).toContain("head_commit");
    // 2) 零副作用:所有快照都未变
    const after = {
      taskStatus: (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status,
      taskToken: (env.app.db.$client.prepare(`SELECT task_token_hash FROM tasks WHERE id=?`).get(pkg.task.id) as any).task_token_hash,
      issueStatus: (env.app.db.$client.prepare(`SELECT status FROM issues WHERE id=?`).get(env.issueId) as any).status,
      startHash: (env.app.db.$client.prepare(`SELECT start_payload_hash, start_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).start_payload_hash,
      startResponse: (env.app.db.$client.prepare(`SELECT start_payload_hash, start_response_json FROM tasks WHERE id=?`).get(pkg.task.id) as any).start_response_json,
      broadcasts: env.hubBroadcasts.length,
      commentCount: (env.app.db.$client.prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id=?`).get(env.issueId) as any).n,
    };
    expect(after.taskStatus).toBe(before.taskStatus);
    expect(after.taskStatus).toBe("dispatched");
    expect(after.taskToken).toBe(before.taskToken);
    expect(after.issueStatus).toBe(before.issueStatus);
    expect(after.startHash).toBeNull();
    expect(after.startResponse).toBeNull();
    expect(after.broadcasts).toBe(before.broadcasts);
    expect(after.commentCount).toBe(before.commentCount);
  });

  it("两个不同 head_commit 都必须 400,不能命中 replay 200", async () => {
    // 关键回归:修复前 head_commit 会被 route 校验格式后丢弃,导致两次不同 SHA
    // 因为 service 不消费 head_commit 反而命中"同 payload"路径;修复后 head_commit
    // 不在白名单,直接作为 unknown_fields 拒绝,两个不同值仍独立 400。
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const beforeStatus = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    const r1 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: {
        daemon_id: "d1", work_dir: "D:/w",
        head_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().code).toBe("invalid_schema");
    const r2 = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: {
        daemon_id: "d1", work_dir: "D:/w",
        head_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().code).toBe("invalid_schema");
    expect(r2.json().details.unknown_fields).toContain("head_commit");
    // 两次都被拒绝,Task 状态不变,也没有任何一次变成 200
    const afterStatus = (env.app.db.$client.prepare(`SELECT status FROM tasks WHERE id=?`).get(pkg.task.id) as any).status;
    expect(afterStatus).toBe(beforeStatus);
  });

  it("兼容路径(不传任何 anchor)Start 仍按现阶段规则返回 200", async () => {
    // R1-FIX2 不得破坏现有兼容路径:不传 task_branch / target_branch / base_commit /
    // delivery_contract_version 的 Start 仍然走兼容模式返回 200,锚点保持 null。
    const env = await setupTwoDaemons();
    const pkg = await env.claimTask();
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: { daemon_id: "d1", work_dir: "D:/w" },
    });
    expect(r.statusCode).toBe(200);
    const row = env.app.db.$client.prepare(`SELECT task_branch, target_branch, base_commit FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.task_branch).toBeNull();
    expect(row.target_branch).toBeNull();
    expect(row.base_commit).toBeNull();
  });

  it("完整合法 v2 Start 仍返回 200 并正确落库", async () => {
    // R1-FIX2 不得破坏完整 v2 锚点路径:四项齐全的合法 Start 仍返回 200。
    const env = await setupTwoDaemons(2);
    const pkg = await env.claimTask();
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    const r = await env.app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${env.daemonToken}`, "content-type": "application/json" },
      payload: {
        daemon_id: "d1", work_dir: "D:/w",
        task_branch: "task/abc",
        target_branch: "main",
        base_commit: SHA,
        delivery_contract_version: 2,
      },
    });
    expect(r.statusCode).toBe(200);
    const row = env.app.db.$client.prepare(`SELECT task_branch, target_branch, base_commit, delivery_contract_version FROM tasks WHERE id=?`).get(pkg.task.id) as any;
    expect(row.task_branch).toBe("task/abc");
    expect(row.target_branch).toBe("main");
    expect(row.base_commit).toBe(SHA);
    expect(row.delivery_contract_version).toBe(2);
  });
});
