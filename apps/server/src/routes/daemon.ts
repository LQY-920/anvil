import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { makeDaemonAuth, makeTaskAuth } from "../lib/auth.js";
import { claimTasks, getTask, startTask, completeTask, failTaskInternal, setIssueStatusFromAgent } from "../services/tasks.js";
import { getIssue } from "../services/issues.js";
import { registerRuntimes, heartbeat } from "../services/runtimes.js";
import { appendTaskMessages } from "../services/messages.js";
import type { ClaimRequest, DaemonHeartbeatRequest, DaemonRegisterRequest } from "@anvil/core";

export function registerDaemonRoutes(app: FastifyInstance, db: Db, hub: Hub) {
  const daemonAuth = makeDaemonAuth(db);
  const taskAuth = makeTaskAuth(db);

  app.post("/api/daemon/register", { preHandler: daemonAuth }, async (req) => {
    const body = req.body as DaemonRegisterRequest;
    return { runtimes: registerRuntimes(db, (req as any).workspaceId, body.daemon_id, body.runtimes) };
  });

  app.post("/api/daemon/heartbeat", { preHandler: daemonAuth }, async (req) => {
    const body = req.body as DaemonHeartbeatRequest;
    heartbeat(db, (req as any).workspaceId, body.daemon_id);
    return { ok: true };
  });

  app.post("/api/daemon/claim", { preHandler: daemonAuth }, async (req) => {
    const body = req.body as ClaimRequest;
    const tasks = claimTasks(db, (req as any).workspaceId, body.daemon_id, body.max_tasks ?? 1);
    for (const pkg of tasks) hub.broadcast({ type: "task.updated", data: pkg.task });
    return { tasks };
  });

  app.get("/api/daemon/ws", { websocket: true, preHandler: daemonAuth }, (socket) => {
    hub.addDaemon(socket);
  });

  app.get("/api/daemon/tasks/:id/status", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(db, id);
    if (!task) return reply.code(404).send({ error: "not found" });
    return { status: task.status };
  });

  app.get("/api/daemon/tasks/:id/delivery", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = getTask(db, id);
    if (!task) return reply.code(404).send({ error: "not found" });
    return { delivered: task.delivered_at != null };
  });

  app.post("/api/daemon/tasks/:id/messages", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { messages } = (req.body ?? {}) as { messages?: any[] };
    const result = appendTaskMessages(db, hub, id, messages ?? []);
    if (!result.ok) return reply.code(409).send({ last_seq: result.last_seq });
    return result;
  });

  app.post("/api/daemon/tasks/:id/start", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { work_dir } = (req.body ?? {}) as { work_dir?: string };
    if (!work_dir) return reply.code(400).send({ error: "work_dir required" });
    if (!startTask(db, id, work_dir)) return reply.code(409).send({ error: "task not in dispatched state" });
    hub.broadcast({ type: "task.updated", data: getTask(db, id) });
    return { ok: true };
  });

  app.post("/api/daemon/tasks/:id/complete", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!completeTask(db, id, req.body as any)) return reply.code(409).send({ error: "task not active" });
    const task = getTask(db, id)!;
    hub.broadcast({ type: "task.updated", data: task });
    return { ok: true };
  });

  app.post("/api/daemon/tasks/:id/fail", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { failure_reason?: string; error?: string; work_dir?: string };
    if (!body.failure_reason || !body.error) return reply.code(400).send({ error: "failure_reason/error required" });
    failTaskInternal(db, id, body.failure_reason, body.error, body.work_dir ?? null);
    hub.broadcast({ type: "task.updated", data: getTask(db, id) });
    return { ok: true };
  });

  app.post("/api/daemon/tasks/:id/issue-status", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { status: string; note?: string };
    const r = setIssueStatusFromAgent(db, id, body.status, body.note);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    const task = getTask(db, id)!;
    hub.broadcast({ type: "issue.updated", data: getIssue(db, task.issue_id) });
    return { ok: true };
  });
}
