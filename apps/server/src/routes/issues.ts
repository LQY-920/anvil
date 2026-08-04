import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { addComment, createIssueRow, enqueueForIssue, getIssue, listIssues, listTasksForIssue, updateIssueRow } from "../services/issues.js";
import { seed } from "../db/client.js";
import type { CreateIssueRequest, UpdateIssueRequest } from "@anvil/core";

export function registerIssueRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  app.get("/api/issues", async (req) => {
    const { workspace_id } = req.query as { workspace_id: string };
    return listIssues(db, workspace_id);
  });

  app.post("/api/issues", async (req, reply) => {
    const { user, workspace } = seed(db);
    const body = req.body as CreateIssueRequest & { status?: string };
    if (!body.title) return reply.code(400).send({ error: "title required" });
    let issue = createIssueRow(db, workspace.id, user.id, body);
    const wasActive = issue.status !== "backlog";
    if (wasActive) {
      const task = enqueueForIssue(db, issue, "assign");
      if (task) hub.hintDaemons({ type: "task.available", data: { task_id: task.id } });
    }
    hub.broadcast({ type: "issue.updated", data: issue });
    return reply.code(201).send(issue);
  });

  app.patch("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const before = getIssue(db, id);
    if (!before) return reply.code(404).send({ error: "not found" });
    const body = req.body as UpdateIssueRequest;
    if (body.status && before.status !== body.status) {
      addComment(db, id, { author_type: "member", author_id: seed(db).user.id, type: "status_change", body: `${before.status} → ${body.status}` });
    }
    const after = updateIssueRow(db, id, body)!;
    const becameActive = before.status === "backlog" && after.status !== "backlog";
    const assignedAgent = after.assignee_type === "agent" &&
      (before.assignee_id !== after.assignee_id || before.assignee_type !== "agent");
    if ((becameActive || assignedAgent) && after.assignee_type === "agent") {
      const task = enqueueForIssue(db, after, becameActive ? "status" : "assign");
      if (task) hub.hintDaemons({ type: "task.available", data: { task_id: task.id } });
    }
    hub.broadcast({ type: "issue.updated", data: after });
    return after;
  });

  app.post("/api/issues/:id/rerun", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(db, id);
    if (!issue) return reply.code(404).send({ error: "not found" });
    const task = enqueueForIssue(db, issue, "rerun");
    if (!task) return reply.code(409).send({ error: "已有 pending 任务或 assignee 不是 agent" });
    hub.hintDaemons({ type: "task.available", data: { task_id: task.id } });
    return reply.code(201).send(task);
  });

  app.get("/api/issues/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const issue = getIssue(db, id);
    if (!issue) return reply.code(404).send({ error: "not found" });
    const commentRows = db.$client
      .prepare(`SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC`)
      .all(id);
    return { issue, comments: commentRows };
  });

  app.get("/api/issues/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return listTasksForIssue(db, id);
  });

  app.post("/api/issues/:id/comments", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getIssue(db, id)) return reply.code(404).send({ error: "not found" });
    const { body } = req.body as { body: string };
    if (!body) return reply.code(400).send({ error: "body required" });
    const cid = addComment(db, id, { author_type: "member", author_id: seed(db).user.id, type: "comment", body });
    hub.broadcast({ type: "issue.updated", data: getIssue(db, id) });
    return reply.code(201).send({ id: cid });
  });
}
