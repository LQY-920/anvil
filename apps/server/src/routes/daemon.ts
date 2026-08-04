import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { makeDaemonAuth, makeTaskAuth } from "../lib/auth.js";
import { claimTasks, getTask } from "../services/tasks.js";
import { registerRuntimes, heartbeat } from "../services/runtimes.js";
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
}
