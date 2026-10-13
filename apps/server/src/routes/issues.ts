import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { addComment, createIssueRow, enqueueForComment, enqueueForIssue, getIssue, listIssues, listTasksForIssue, updateIssueRow } from "../services/issues.js";
import { seed } from "../db/client.js";
import { ISSUE_STATUSES, PRIORITIES, type CreateIssueRequest, type UpdateIssueRequest } from "@anvil/core";
import { withGitLock } from "@anvil/core/git-lock";
import { excludeReviewMeasurement } from "../services/review-measurements.js";

export function registerIssueRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  app.get("/api/issues", async (req) => {
    const { workspace_id } = req.query as { workspace_id: string };
    return listIssues(db, workspace_id);
  });

  app.post("/api/issues", async (req, reply) => {
    const { user, workspace } = seed(db);
    const body = req.body as (CreateIssueRequest & { status?: string }) | undefined;
    if (!body) return reply.code(400).send({ error: "body required" });
    if (!body.title) return reply.code(400).send({ error: "title required" });
    if (body.status !== undefined && !(ISSUE_STATUSES as readonly string[]).includes(body.status)) {
      return reply.code(400).send({ error: "invalid status" });
    }
    if (body.priority !== undefined && !(PRIORITIES as readonly string[]).includes(body.priority)) {
      return reply.code(400).send({ error: "invalid priority" });
    }
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
    const body = (req.body ?? {}) as UpdateIssueRequest;
    if (body.status !== undefined && !(ISSUE_STATUSES as readonly string[]).includes(body.status)) {
      return reply.code(400).send({ error: "invalid status" });
    }
    if (body.priority !== undefined && !(PRIORITIES as readonly string[]).includes(body.priority)) {
      return reply.code(400).send({ error: "invalid priority" });
    }
    const mutate = () => db.$client.transaction(() => {
      const updated = updateIssueRow(db, id, body)!;
      if (body.status && before.status !== body.status) {
        addComment(db, id, { author_type: "member", author_id: seed(db).user.id, type: "status_change", body: `${before.status} → ${body.status}` });
      }
      return updated;
    }).immediate();
    const repository = before.repository_id && (body.repository_id !== undefined || body.repo_path !== undefined)
      ? db.$client.prepare("SELECT identity_json FROM repositories WHERE id=?").get(before.repository_id) as { identity_json: string } | undefined : null;
    const lockDirectory: string | undefined = repository ? JSON.parse(repository.identity_json).real_path : undefined;
    // 已删除的 checkout 没有可参与竞争的 Git 操作，仍允许用户修复绑定。
    const after = lockDirectory && fs.existsSync(lockDirectory) ? await withGitLock(lockDirectory, async () => mutate()) : mutate();
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
    const issue = getIssue(db, id);
    if (!issue) return reply.code(404).send({ error: "not found" });
    const { body } = req.body as { body: string };
    if (!body) return reply.code(400).send({ error: "body required" });
    try { excludeReviewMeasurement(db, (req.body as any)?.review_measurement_failed_for, { issueId: id }); }
    catch (e: any) {
      if (e.http) return reply.code(e.http).send({ error: e.message });
      throw e;
    }
    const cid = addComment(db, id, { author_type: "member", author_id: seed(db).user.id, type: "comment", body });
    // member 评论即指令：满足守卫则入队新任务（trigger=comment），判别结果随响应回传
    const trigger = enqueueForComment(db, issue);
    if (trigger.enqueued) hub.hintDaemons({ type: "task.available", data: { task_id: trigger.task.id } });
    hub.broadcast({ type: "issue.updated", data: getIssue(db, id) });
    return reply.code(201).send({
      id: cid,
      trigger: trigger.enqueued
        ? { enqueued: true, task_id: trigger.task.id }
        : { enqueued: false, reason: trigger.reason },
    });
  });
}
