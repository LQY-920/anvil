import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let workspaceId: string;
let agentId: string;
let userId: string;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const boot = await app.inject({ method: "GET", url: "/api/bootstrap" });
  workspaceId = boot.json().workspace.id;
  userId = boot.json().user.id;
  const a = await app.inject({
    method: "POST", url: "/api/agents",
    payload: { name: "bot", provider: "kimi" },
  });
  agentId = a.json().id;
});

async function createIssue(payload: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "demo", ...payload },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("issue CRUD + enqueue triggers", () => {
  it("assign to agent with status todo → queued task created", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    expect(issue.status).toBe("todo");
    const list = await app.inject({ method: "GET", url: `/api/issues?workspace_id=${workspaceId}` });
    expect(list.json()).toHaveLength(1);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(1);
    expect(tasks.json()[0].status).toBe("queued");
    expect(tasks.json()[0].agent_id).toBe(agentId);
  });

  it("backlog does not trigger; moving backlog→todo with agent assignee triggers", async () => {
    const issue = await createIssue({ status: "backlog", assignee_type: "agent", assignee_id: agentId });
    let tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(0);
    await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { status: "todo" } });
    tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(1);
  });

  it("assign to member → no task", async () => {
    const issue = await createIssue({ assignee_type: "member", assignee_id: userId });
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(0);
  });

  it("rerun creates a new task after previous reached terminal state", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    let res = await app.inject({ method: "POST", url: `/api/issues/${issue.id}/rerun` });
    expect(res.statusCode).toBe(409);
    const db = app.db;
    db.prepare(`UPDATE tasks SET status='failed', failure_reason='non_zero_exit'`).run();
    res = await app.inject({ method: "POST", url: `/api/issues/${issue.id}/rerun` });
    expect(res.statusCode).toBe(201);
    const tasks = await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` });
    expect(tasks.json()).toHaveLength(2);
  });

  it("issue detail includes comments; adding comment works", async () => {
    const issue = await createIssue();
    const c = await app.inject({
      method: "POST", url: `/api/issues/${issue.id}/comments`,
      payload: { body: "补充说明" },
    });
    expect(c.statusCode).toBe(201);
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    expect(detail.json().comments).toHaveLength(1);
    expect(detail.json().comments[0].body).toBe("补充说明");
  });

  it("rejects invalid enum values", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "x", status: "bogus" } });
    expect(bad.statusCode).toBe(400);
    const issue = await createIssue();
    const badPatch = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { status: "bogus" } });
    expect(badPatch.statusCode).toBe(400);
  });

  it("rejects empty body on create", async () => {
    const res = await app.inject({ method: "POST", url: "/api/issues" });
    expect(res.statusCode).toBe(400);
  });

  it("stores acceptance on create and updates it on patch", async () => {
    const issue = await createIssue({ acceptance: "1. 单测通过\n2. 改动已 commit" });
    expect(issue.acceptance).toBe("1. 单测通过\n2. 改动已 commit");
    const patched = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { acceptance: "新验收标准" } });
    expect(patched.json().acceptance).toBe("新验收标准");
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    expect(detail.json().issue.acceptance).toBe("新验收标准");
  });

  it("acceptance defaults to null and is untouched by unrelated patch", async () => {
    const issue = await createIssue();
    expect(issue.acceptance).toBeNull();
    const patched = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { title: "改名" } });
    expect(patched.json().acceptance).toBeNull();
  });

  it("trims repo_path whitespace on create and patch", async () => {
    const issue = await createIssue({ repo_path: "  D:/anvil  " });
    expect(issue.repo_path).toBe("D:/anvil");
    const res = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { repo_path: " D:/other " } });
    expect(res.json().repo_path).toBe("D:/other");
    const cleared = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { repo_path: "   " } });
    expect(cleared.json().repo_path).toBeNull();
  });
});

describe("recent_repos", () => {
  it("createIssue 带 repo_path → bootstrap 返回 recent_repos（最新在前、去重）", async () => {
    await createIssue({ repo_path: "D:/a" });
    await createIssue({ repo_path: "https://github.com/u/r.git" });
    await createIssue({ repo_path: "D:/a" }); // 重复 → 去重置顶
    const boot = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(boot.json().recent_repos).toEqual(["D:/a", "https://github.com/u/r.git"]);
  });

  it("无 repo_path 不记录；上限 8 条", async () => {
    await createIssue();
    let boot = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(boot.json().recent_repos).toEqual([]);
    for (let i = 0; i < 10; i++) await createIssue({ repo_path: `D:/r${i}` });
    boot = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const rr = boot.json().recent_repos;
    expect(rr).toHaveLength(8);
    expect(rr[0]).toBe("D:/r9");
    expect(rr[7]).toBe("D:/r2");
  });
});
