import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let token: string;
let agentId: string;
let issueId: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: { label: "t" } });
  token = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "demo", assignee_type: "agent", assignee_id: agentId },
  });
  issueId = i.json().id;
  await app.inject({
    method: "POST", url: "/api/daemon/register",
    headers: { authorization: `Bearer ${token}` },
    payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1.0.0" }] },
  });
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe("daemon auth + claim", () => {
  it("rejects claim without token", async () => {
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", payload: { daemon_id: "d1" } });
    expect(res.statusCode).toBe(401);
  });

  it("claims queued task atomically: second claim gets nothing", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(r1.statusCode).toBe(200);
    const body = r1.json();
    expect(body.tasks).toHaveLength(1);
    const pkg = body.tasks[0];
    expect(pkg.task.status).toBe("dispatched");
    expect(pkg.task.lease_expires_at).toBeTruthy();
    expect(pkg.task_token).toMatch(/^atk_/);
    expect(pkg.issue.id).toBe(issueId);
    expect(pkg.prior_work_dir).toBeNull();

    const r2 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(r2.json().tasks).toHaveLength(0);
  });

  it("concurrent claims: only one winner", async () => {
    const [r1, r2] = await Promise.all([
      app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } }),
      app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } }),
    ]);
    const total = r1.json().tasks.length + r2.json().tasks.length;
    expect(total).toBe(1);
  });

  it("respects agent max_concurrent_tasks", async () => {
    await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    await app.inject({ method: "POST", url: "/api/issues", payload: { title: "second", assignee_type: "agent", assignee_id: agentId } });
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    expect(res.json().tasks).toHaveLength(0);
  });

  it("priority order: urgent claimed before medium", async () => {
    const db = app.db;
    db.prepare(`DELETE FROM tasks`).run();
    const mk = async (priority: string) => {
      await app.inject({ method: "POST", url: "/api/issues", payload: { title: priority, priority, assignee_type: "agent", assignee_id: agentId } });
    };
    await mk("medium");
    await mk("urgent");
    db.prepare(`UPDATE agents SET max_concurrent_tasks=2 WHERE id=?`).run(agentId);
    const res = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1", max_tasks: 2 } });
    expect(res.json().tasks).toHaveLength(2);
    expect(res.json().tasks[0].issue.title).toBe("urgent");
  });

  it("task token authorizes task-scoped endpoints", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
    const pkg = r1.json().tasks[0];
    const bad = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: "Bearer wrong" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: `/api/daemon/tasks/${pkg.task.id}/status`, headers: { authorization: `Bearer ${pkg.task_token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("dispatched");
  });
});

// =============================================================================
// A04-FIX1 · claimTasks 跨 Task 锚点接力 + 历史 v1 兼容 + 无 repo 接力
//
// 直连 claimTasks(db, ws, daemonId, maxTasks),跳过 HTTP 层,验证:
//  - Git prior 三锚点齐全 → 当前 Task 落库三个锚点 + pkg.task 反映
//  - prior 部分锚点 → 补齐缺失字段(已有字段必须一致)
//  - prior 只有 work_dir 缺三锚点 → prior_work_dir 为 null,不猜测
//  - 无 repo_path issue → prior_work_dir 正常下发,三锚点保持 null
//  - 锚点继承不复制 head_commit / verification_* / 任何 hash / response_json
// =============================================================================

describe("A04-FIX1 · claimTasks anchor inheritance", () => {
  // 与默认 setup() 同形:多一个可空 repo_path 字段。
  async function makeIssueWithRepoPath(repoPath: string | null) {
    app = await buildApp({ dbPath: ":memory:", logger: false });
    const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
    token = tk.json().token;
    const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
    agentId = a.json().id;
    const i = await app.inject({
      method: "POST", url: "/api/issues",
      payload: repoPath
        ? { title: "demo", assignee_type: "agent", assignee_id: agentId, repo_path: repoPath }
        : { title: "demo", assignee_type: "agent", assignee_id: agentId },
    });
    issueId = i.json().id;
    await app.inject({
      method: "POST", url: "/api/daemon/register",
      headers: { authorization: `Bearer ${token}` },
      payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1.0.0" }] },
    });
    return { app, token, agentId, issueId };
  }

  function readTask(id: string) {
    return app.db.$client.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as any;
  }

  function forceCompleteAndStart(taskId: string, anchors: {
    work_dir?: string; task_branch?: string; target_branch?: string; base_commit?: string;
    head_commit?: string; verification_status?: string; verification_run_id?: string;
    start_payload_hash?: string; complete_payload_hash?: string;
  }) {
    const now = new Date().toISOString();
    // 若给了 verification_run_id,先确保 verification_runs 行存在(FK 要求)
    if (anchors.verification_run_id) {
      const exists = app.db.$client.prepare(`SELECT id FROM verification_runs WHERE id=?`).get(anchors.verification_run_id);
      if (!exists) {
        app.db.$client
          .prepare(`INSERT INTO verification_runs
                    (id, task_id, schema_version, policy_source, base_commit, status, completed_at, created_at)
                    VALUES (?, ?, 1, 'none', ?, 'not_configured', ?, ?)`)
          .run(anchors.verification_run_id, taskId, anchors.base_commit ?? "0".repeat(40), now, now);
      }
    }
    app.db.$client
      .prepare(`UPDATE tasks
                SET status='completed', result_json=?, completed_at=?,
                    work_dir=COALESCE(?, work_dir),
                    task_branch=COALESCE(?, task_branch),
                    target_branch=COALESCE(?, target_branch),
                    base_commit=COALESCE(?, base_commit),
                    head_commit=COALESCE(?, head_commit),
                    verification_status=COALESCE(?, verification_status),
                    verification_run_id=COALESCE(?, verification_run_id),
                    start_payload_hash=COALESCE(?, start_payload_hash),
                    complete_payload_hash=COALESCE(?, complete_payload_hash)
                WHERE id=?`)
      .run(
        JSON.stringify({ branch: anchors.task_branch ?? "task/x" }),
        now,
        anchors.work_dir ?? null,
        anchors.task_branch ?? null,
        anchors.target_branch ?? null,
        anchors.base_commit ?? null,
        anchors.head_commit ?? null,
        anchors.verification_status ?? null,
        anchors.verification_run_id ?? null,
        anchors.start_payload_hash ?? null,
        anchors.complete_payload_hash ?? null,
        taskId,
      );
  }

  it("Git v2 prior 三锚点齐全 → 当前 Task 落库 task_branch/target_branch/base_commit + pkg 同步", async () => {
    await makeIssueWithRepoPath(null);
    const firstTaskRes = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    const firstTask = firstTaskRes.json()[0];
    const base = "0123456789abcdef0123456789abcdef01234567";
    forceCompleteAndStart(firstTask.id, {
      work_dir: "/tmp/prior1",
      task_branch: "task/abcd1234",
      target_branch: "main",
      base_commit: base,
      head_commit: "fedcba9876543210fedcba9876543210fedcba98",
      verification_status: "passed",
      verification_run_id: "vr-xyz",
      start_payload_hash: "deadbeefstart",
      complete_payload_hash: "deadbeefcomplete",
    });
    // 改 issue 加上 repo_path
    app.db.$client.prepare(`UPDATE issues SET repo_path=? WHERE id=?`).run("/tmp/some-repo", issueId);
    // 重新入队一个新 queued Task
    const c = await app.inject({ method: "POST", url: `/api/issues/${issueId}/comments`, payload: { body: "接力" } });
    expect(c.json().trigger.enqueued).toBe(true);
    // claim
    const claim = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${token}` }, payload: { daemon_id: "d1" } });
    const pkg = claim.json().tasks[0];
    expect(pkg).toBeTruthy();
    // pkg.prior_work_dir 必须有值
    expect(pkg.prior_work_dir).toBe("/tmp/prior1");
    // pkg.task 已经持久化三个锚点
    expect(pkg.task.task_branch).toBe("task/abcd1234");
    expect(pkg.task.target_branch).toBe("main");
    expect(pkg.task.base_commit).toBe(base);
    // 重新从数据库读取,三个锚点都已落库
    const reloaded = readTask(pkg.task.id);
    expect(reloaded.task_branch).toBe("task/abcd1234");
    expect(reloaded.target_branch).toBe("main");
    expect(reloaded.base_commit).toBe(base);
    // 关键:完成证据绝不能被继承
    expect(reloaded.head_commit).toBeNull();
    expect(reloaded.verification_status).toBeNull();
    expect(reloaded.verification_run_id).toBeNull();
    expect(reloaded.start_payload_hash).toBeNull();
    expect(reloaded.complete_payload_hash).toBeNull();
    expect(reloaded.fail_payload_hash).toBeNull();
    expect(reloaded.start_response_json).toBeNull();
    expect(reloaded.complete_response_json).toBeNull();
    expect(reloaded.fail_response_json).toBeNull();
  });

  it("Git prior 与当前 Task 已有部分锚点一致 → 补齐缺失字段,不覆盖已有", async () => {
    await makeIssueWithRepoPath(null);
    const firstTaskRes = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    const firstTask = firstTaskRes.json()[0];
    const base = "abcdef1234567890abcdef1234567890abcdef12";
    forceCompleteAndStart(firstTask.id, {
      work_dir: "/tmp/prior2",
      task_branch: "task/abcd1234",
      target_branch: "main",
      base_commit: base,
    });
    app.db.$client.prepare(`UPDATE issues SET repo_path=? WHERE id=?`).run("/tmp/some-repo", issueId);
    // 入队新 task
    const c = await app.inject({ method: "POST", url: `/api/issues/${issueId}/comments`, payload: { body: "接力2" } });
    expect(c.json().trigger.enqueued).toBe(true);
    const queuedId = c.json().trigger.task_id;
    // SQL 直接给 child 写 target_branch/base_commit(模拟自动重试已继承的事实)
    app.db.$client.prepare(`UPDATE tasks SET target_branch=?, base_commit=? WHERE id=?`)
      .run("main", base, queuedId);
    // claim
    const claim = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${token}` }, payload: { daemon_id: "d1" } });
    const pkg = claim.json().tasks[0];
    expect(pkg.task.id).toBe(queuedId);
    // task_branch 应补齐
    expect(pkg.task.task_branch).toBe("task/abcd1234");
    // target_branch / base_commit 保留一致值
    expect(pkg.task.target_branch).toBe("main");
    expect(pkg.task.base_commit).toBe(base);
    expect(pkg.prior_work_dir).toBe("/tmp/prior2");
  });

  it("Git 历史 prior 只有 work_dir 无完整三锚点 → 不下发 prior_work_dir,允许 fresh worktree", async () => {
    await makeIssueWithRepoPath(null);
    const firstTaskRes = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    const firstTask = firstTaskRes.json()[0];
    // 模拟历史 v1:只有 work_dir,三锚点都 null
    forceCompleteAndStart(firstTask.id, { work_dir: "/tmp/prior-legacy" });
    app.db.$client.prepare(`UPDATE issues SET repo_path=? WHERE id=?`).run("/tmp/some-repo", issueId);
    // 重新入队
    const c = await app.inject({ method: "POST", url: `/api/issues/${issueId}/comments`, payload: { body: "接力" } });
    expect(c.json().trigger.enqueued).toBe(true);
    // claim
    const claim = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${token}` }, payload: { daemon_id: "d1" } });
    const pkg = claim.json().tasks[0];
    // 关键:prior_work_dir 必须为 null,不能下发 v1 legacy worktree
    expect(pkg.prior_work_dir).toBeNull();
    // 三个 Git 锚点保持 null(不猜测)
    expect(pkg.task.task_branch).toBeNull();
    expect(pkg.task.target_branch).toBeNull();
    expect(pkg.task.base_commit).toBeNull();
    // 数据库里也保持 null
    const reloaded = readTask(pkg.task.id);
    expect(reloaded.task_branch).toBeNull();
    expect(reloaded.target_branch).toBeNull();
    expect(reloaded.base_commit).toBeNull();
  });

  it("无 repo_path 普通目录接力 → prior_work_dir 下发,三 Git 锚点保持 null", async () => {
    await makeIssueWithRepoPath(null);
    const firstTaskRes = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    const firstTask = firstTaskRes.json()[0];
    // prior 是普通目录任务,只 work_dir,无锚点(无 repo_path)
    forceCompleteAndStart(firstTask.id, { work_dir: "/tmp/prior-norepo" });
    // issue repo_path 保持 null
    // 入队新 task
    const c = await app.inject({ method: "POST", url: `/api/issues/${issueId}/comments`, payload: { body: "接力 no-repo" } });
    expect(c.json().trigger.enqueued).toBe(true);
    const claim = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${token}` }, payload: { daemon_id: "d1" } });
    const pkg = claim.json().tasks[0];
    // 关键:prior_work_dir 正常下发
    expect(pkg.prior_work_dir).toBe("/tmp/prior-norepo");
    // 三 Git 锚点保持 null
    expect(pkg.task.task_branch).toBeNull();
    expect(pkg.task.target_branch).toBeNull();
    expect(pkg.task.base_commit).toBeNull();
  });

  it("A04-FIX2 · Git prior 与当前 Task 已有锚点不一致 → Server 不覆盖冲突锚点,prior_work_dir 也不下发;Runner 后续必须因\"无 prior 但存在 saved anchors\"明确失败,不得宣称该状态可走 fresh", async () => {
    // 真实语义(2026-08-29 A04-FIX2 修正):
    // 旧版注释把这状态标为"走 fresh"是误导的 —— 当前 Task 仍保留 child 原值(可能部分非 null),
    // Runner prepareWorkdir 现在把"无 prior 但存在任意 saved anchor"判定为非法矛盾状态 C3,
    // 会明确抛错并由 executeTask 收敛为 fail,不会静默 fresh。
    // 本测试只覆盖 Server 侧语义:不覆盖冲突字段 + 不下 prior_work_dir。
    await makeIssueWithRepoPath(null);
    const firstTaskRes = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
    const firstTaskData = firstTaskRes.json()[0];
    const base = "1111111111111111111111111111111111111111";
    forceCompleteAndStart(firstTaskData.id, {
      work_dir: "/tmp/prior-conflict",
      task_branch: "task/abcd1234",
      target_branch: "main",
      base_commit: base,
    });
    app.db.$client.prepare(`UPDATE issues SET repo_path=? WHERE id=?`).run("/tmp/some-repo", issueId);
    // 入队新 task
    const c = await app.inject({ method: "POST", url: `/api/issues/${issueId}/comments`, payload: { body: "接力" } });
    expect(c.json().trigger.enqueued).toBe(true);
    const queuedId = c.json().trigger.task_id;
    // 给 child 写一个与 prior 不一致的 target_branch
    app.db.$client.prepare(`UPDATE tasks SET target_branch=? WHERE id=?`).run("develop", queuedId);
    // claim
    const claim = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${token}` }, payload: { daemon_id: "d1" } });
    const pkg = claim.json().tasks[0];
    // 关键:不一致时 prior_work_dir 也不下发 —— Runner 看到 prior=null + saved anchor(target_branch=develop)
    // 会进入 A04-FIX2 状态矩阵的 C3(priorWorkDir 为空但 Task 存在 saved Git 锚点)→ 明确失败,
    // 而不是静默 fresh,不得在本测试里伪造 Runner 已成功的假象。
    expect(pkg.prior_work_dir).toBeNull();
    // 已有不一致字段(target_branch)不被覆盖,保留 child 原值
    expect(pkg.task.target_branch).toBe("develop");
    // 缺失字段保持 null(prior 不会强加,因整体不继承)
    expect(pkg.task.task_branch).toBeNull();
    expect(pkg.task.base_commit).toBeNull();
    // 这种状态在 Runner 侧必须被 A04-FIX2 拒绝 —— 见 apps/runner/test/worktree.test.ts 的对应测试。
  });
});
