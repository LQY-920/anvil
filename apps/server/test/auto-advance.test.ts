import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;
let issueId: string;

async function claimOne() {
  const c = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
  return c.json().tasks[0] as any;
}

const tpost = (url: string, payload: unknown, token: string) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as any });

const setIssueStatus = (status: string) =>
  app.db.$client.prepare(`UPDATE issues SET status = ? WHERE id = ?`).run(status, issueId);

async function issueDetail() {
  const res = await app.inject({ method: "GET", url: `/api/issues/${issueId}` });
  return res.json();
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", assignee_type: "agent", assignee_id: agentId } });
  issueId = i.json().id;
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
});

describe("issue status auto-advance", () => {
  it("start: todo → in_progress，写 system 评论并广播 issue.updated", async () => {
    const pkg = await claimOne();
    const spy = vi.spyOn(app.hub, "broadcast");
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    expect(s.statusCode).toBe(200);
    const detail = await issueDetail();
    expect(detail.issue.status).toBe("in_progress");
    const comment = detail.comments.find((c: any) => c.type === "status_change");
    expect(comment).toMatchObject({ author_type: "system", author_id: "system", body: "todo → in_progress（开始执行）" });
    expect(spy).toHaveBeenCalledWith({ type: "task.updated", data: expect.objectContaining({ id: pkg.task.id, status: "running" }) });
    expect(spy).toHaveBeenCalledWith({ type: "issue.updated", data: expect.objectContaining({ id: issueId, status: "in_progress" }) });
  });

  it("start: blocked 不动", async () => {
    setIssueStatus("blocked");
    const pkg = await claimOne();
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    expect(s.statusCode).toBe(200);
    const detail = await issueDetail();
    expect(detail.issue.status).toBe("blocked");
    expect(detail.comments.some((c: any) => c.type === "status_change")).toBe(false);
  });

  it("start: in_review 不动", async () => {
    setIssueStatus("in_review");
    const pkg = await claimOne();
    const s = await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    expect(s.statusCode).toBe(200);
    const detail = await issueDetail();
    expect(detail.issue.status).toBe("in_review");
    expect(detail.comments.some((c: any) => c.type === "status_change")).toBe(false);
  });

  it("complete 有 branch: in_progress → in_review", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    const spy = vi.spyOn(app.hub, "broadcast");
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { branch: "task/abc", diff_stat: "2 files changed" }, pkg.task_token);
    expect(c.statusCode).toBe(200);
    const detail = await issueDetail();
    expect(detail.issue.status).toBe("in_review");
    const bodies = detail.comments.filter((c: any) => c.type === "status_change").map((c: any) => c.body);
    expect(bodies).toEqual(["todo → in_progress（开始执行）", "in_progress → in_review（产出待验收）"]);
    expect(spy).toHaveBeenCalledWith({ type: "issue.updated", data: expect.objectContaining({ id: issueId, status: "in_review" }) });
  });

  it("complete 有 branch: todo → in_review，且不写 delivered_at", async () => {
    const pkg = await claimOne();
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { branch: "task/abc" }, pkg.task_token);
    expect(c.statusCode).toBe(200);
    const detail = await issueDetail();
    expect(detail.issue.status).toBe("in_review");
    const comment = detail.comments.find((c: any) => c.type === "status_change");
    expect(comment.body).toBe("todo → in_review（产出待验收）");
    // 自动流转 ≠ 交付信号：delivered_at 仍只由 agent 回调写入
    const row = app.db.$client.prepare(`SELECT delivered_at FROM tasks WHERE id = ?`).get(pkg.task.id) as any;
    expect(row.delivered_at).toBeNull();
  });

  it("complete 无 branch 不动", async () => {
    const pkg = await claimOne();
    await tpost(`/api/daemon/tasks/${pkg.task.id}/start`, { work_dir: "/tmp/w1" }, pkg.task_token);
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { diff_stat: "no branch" }, pkg.task_token);
    expect(c.statusCode).toBe(200);
    const detail = await issueDetail();
    expect(detail.issue.status).toBe("in_progress");
    expect(detail.comments.filter((c: any) => c.type === "status_change")).toHaveLength(1);
  });

  it("complete 有 branch 但 issue 为 done 不动", async () => {
    const pkg = await claimOne();
    setIssueStatus("done");
    const c = await tpost(`/api/daemon/tasks/${pkg.task.id}/complete`, { branch: "task/abc" }, pkg.task_token);
    expect(c.statusCode).toBe(200);
    const detail = await issueDetail();
    expect(detail.issue.status).toBe("done");
    expect(detail.comments.some((c: any) => c.type === "status_change")).toBe(false);
  });
});
