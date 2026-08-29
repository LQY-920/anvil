import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  await app.inject({
    method: "POST", url: "/api/daemon/register",
    headers: { authorization: `Bearer ${daemonToken}` },
    payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] },
  });
});

const auth = () => ({ authorization: `Bearer ${daemonToken}` });

async function createIssue(payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "demo", ...payload },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function postComment(issueId: string, body = "补充指令") {
  const res = await app.inject({
    method: "POST", url: `/api/issues/${issueId}/comments`,
    payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function claimOne() {
  const c = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth(), payload: { daemon_id: "d1" } });
  return c.json().tasks[0] as any;
}

describe("comment-driven tasks", () => {
  it("无活跃任务 + agent + todo → enqueued，时间线有系统评论", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    // 把创建时自动入队的任务置为终态，模拟"无活跃任务"
    app.db.prepare(`UPDATE tasks SET status='failed', failure_reason='non_zero_exit'`).run();
    const res = await postComment(issue.id);
    expect(res.trigger.enqueued).toBe(true);
    expect(res.trigger.task_id).toBeTruthy();
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(2);
    expect(tasks.json().find((t: any) => t.id === res.trigger.task_id).status).toBe("queued");
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    expect(detail.json().comments.some((c: any) => c.body === "任务已入队（触发：comment）" && c.author_type === "system")).toBe(true);
  });

  it("已有 queued 任务 → merged_into_pending，任务数不增", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    const res = await postComment(issue.id);
    expect(res.trigger).toEqual({ enqueued: false, reason: "merged_into_pending" });
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(1);
  });

  it("running 任务存在时 → enqueued（唯一索引不挡 running）", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    const pkg = await claimOne();
    const s = await app.inject({
      method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`,
      headers: { authorization: `Bearer ${daemonToken}` },
      payload: { daemon_id: "d1", work_dir: "/tmp/w1" },
    });
    expect(s.statusCode).toBe(200);
    const res = await postComment(issue.id);
    expect(res.trigger.enqueued).toBe(true);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(2);
    expect(tasks.json().map((t: any) => t.status).sort()).toEqual(["queued", "running"]);
  });

  it("未指派 agent → assignee_not_agent", async () => {
    const issue = await createIssue();
    const res = await postComment(issue.id);
    expect(res.trigger).toEqual({ enqueued: false, reason: "assignee_not_agent" });
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(0);
  });

  it("issue done → status_inactive", async () => {
    const issue = await createIssue({ status: "done", assignee_type: "agent", assignee_id: agentId });
    const res = await postComment(issue.id);
    expect(res.trigger).toEqual({ enqueued: false, reason: "status_inactive" });
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(0);
  });

  it("issue blocked → 评论仍入队（评论可能即解锁指令，语义显式钉住）", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    app.db.prepare(`UPDATE tasks SET status='cancelled', failure_reason='cancelled_by_user'`).run();
    await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { status: "blocked" } });
    const res = await postComment(issue.id);
    expect(res.trigger.enqueued).toBe(true);
  });

  it("触发后 claim 的 TaskPackage.comments 含该评论", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    app.db.prepare(`UPDATE tasks SET status='failed', failure_reason='non_zero_exit'`).run();
    const res = await postComment(issue.id, "接着把边界情况补一下");
    expect(res.trigger.enqueued).toBe(true);
    const pkg = await claimOne();
    expect(pkg.task.id).toBe(res.trigger.task_id);
    expect(pkg.comments.some((c: any) => c.body === "接着把边界情况补一下" && c.author_type === "member")).toBe(true);
  });
});
