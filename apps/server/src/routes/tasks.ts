import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { getTask } from "../services/tasks.js";
import { listMessages } from "../services/messages.js";
import { getIssue } from "../services/issues.js";

export function registerTaskRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(db, id);
    if (!task) return reply.code(404).send({ error: "not found" });
    return { task, issue: getIssue(db, task.issue_id) };
  });

  app.get("/api/tasks/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const { after_seq } = req.query as { after_seq?: string };
    const parsed = after_seq !== undefined ? Number(after_seq) : -1;
    const afterSeq = Number.isFinite(parsed) ? parsed : -1;
    return listMessages(db, id, afterSeq);
  });
}
