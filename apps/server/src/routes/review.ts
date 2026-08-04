import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { getIssue } from "../services/issues.js";
import { getTask } from "../services/tasks.js";
import { getTaskDiff, mergeTaskBranch } from "../services/review.js";

export function registerReviewRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  app.get("/api/tasks/:id/diff", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await getTaskDiff(db, id);
    if (!r.ok) return reply.code(404).send({ error: r.error });
    return r.data;
  });

  app.post("/api/tasks/:id/merge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await mergeTaskBranch(db, id);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    const task = getTask(db, id)!;
    hub.broadcast({ type: "issue.updated", data: getIssue(db, task.issue_id) });
    return r.data;
  });
}
