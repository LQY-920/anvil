import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { getIssue } from "../services/issues.js";
import { getTask } from "../services/tasks.js";
import { getTaskDiff, mergeTaskBranch } from "../services/review.js";
import { saveReviewMeasurement, excludeReviewMeasurement } from "../services/review-measurements.js";

export function registerReviewRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  app.put("/api/tasks/:id/review-measurement", async (req, reply) => {
    const { id } = req.params as { id: string };
    try { return saveReviewMeasurement(db, id, req.body); }
    catch (e: any) {
      if (e.http) return reply.code(e.http).send({ error: e.message });
      throw e;
    }
  });
  app.get("/api/tasks/:id/diff", async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await getTaskDiff(db, id);
    if (!r.ok) return reply.code(404).send({ error: r.error });
    return r.data;
  });

  app.post("/api/tasks/:id/merge", async (req, reply) => {
    const { id } = req.params as { id: string };
    try { excludeReviewMeasurement(db, (req.body as any)?.review_measurement_failed_for, { taskId: id }); }
    catch (e: any) {
      if (e.http) return reply.code(e.http).send({ error: e.message });
      throw e;
    }
    const r = await mergeTaskBranch(db, id);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    const task = getTask(db, id)!;
    hub.broadcast({ type: "issue.updated", data: getIssue(db, task.issue_id) });
    return r.data;
  });
}
