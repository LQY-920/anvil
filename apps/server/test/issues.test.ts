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
});
