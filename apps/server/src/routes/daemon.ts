import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { makeDaemonAuth, makeTaskAuth } from "../lib/auth.js";
import { claimTasks, getTask, setIssueStatusFromAgent, startTaskForDaemon, completeTaskForDaemon, failTaskForDaemon, COMPLETE_ALLOWED_FIELDS } from "../services/tasks.js";
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

  // Agent plane:status / delivery / messages / issue-status 继续用 task token。
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

  // ---------- A03 · daemon plane:start / complete / fail 改用 daemon token + body.daemon_id ----------

  app.post("/api/daemon/tasks/:id/start", { preHandler: daemonAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // A03-FIX:start 接受完整 v2 锚点;未携带时为兼容路径,继续走老 Runner
    const body = (req.body ?? {}) as {
      daemon_id?: string; work_dir?: string;
      task_branch?: string | null; target_branch?: string | null;
      base_commit?: string | null; delivery_contract_version?: number | null;
    };
    if (!body.daemon_id || !body.work_dir) {
      return reply.code(400).send({ code: "invalid_schema", message: "daemon_id 与 work_dir 必填" });
    }
    const workspaceId = (req as any).workspaceId as string;
    try {
      // A03-FIX:start 副作用(状态更新 + 锚点 + autoAdvanceIssue + 系统评论 + 幂等回执)
      // 全部在 service 内部同一 transaction 完成;route 只负责 commit 后的广播
      const { response, task, replayed, advancedIssue } = startTaskForDaemon(db, id, workspaceId, body.daemon_id, {
        daemon_id: body.daemon_id,
        work_dir: body.work_dir,
        task_branch: body.task_branch ?? null,
        target_branch: body.target_branch ?? null,
        base_commit: body.base_commit ?? null,
        delivery_contract_version: body.delivery_contract_version ?? null,
      });
      if (!replayed) {
        hub.broadcast({ type: "task.updated", data: task });
        if (advancedIssue) hub.broadcast({ type: "issue.updated", data: advancedIssue });
      }
      return response;
    } catch (e: any) {
      if (typeof e?.code === "string" && typeof e?.http === "number") {
        const body: Record<string, unknown> = { code: e.code, message: e.message };
        if (e.details) body.details = e.details;
        return reply.code(e.http).send(body);
      }
      throw e;
    }
  });

  app.post("/api/daemon/tasks/:id/complete", { preHandler: daemonAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    if (!rawBody.daemon_id) {
      return reply.code(400).send({ code: "invalid_schema", message: "daemon_id 必填" });
    }
    // A03-FIX4 · 拒绝未知顶层字段:白名单内才允许进入 service。
    // 未知字段不允许落库,不允许写 complete_payload_hash,不允许推进 Task 终态。
    const unknownFields = Object.keys(rawBody).filter((k) => !COMPLETE_ALLOWED_FIELDS.has(k));
    if (unknownFields.length > 0) {
      return reply.code(400).send({
        code: "invalid_schema",
        message: `complete body 包含未知字段:${unknownFields.join(", ")}`,
        details: { unknown_fields: unknownFields, allowed_fields: [...COMPLETE_ALLOWED_FIELDS].filter((f) => f !== "daemon_id") },
      });
    }
    // A03-FIX:daemonId 由方法参数最终写入,确保 result.daemon_id 不会覆盖参数
    const { daemon_id, ...rest } = rawBody as { daemon_id: string } & Record<string, unknown>;
    const body: Record<string, unknown> = { daemon_id, ...rest };
    const workspaceId = (req as any).workspaceId as string;
    try {
      const { response, task, replayed, advancedIssue } = completeTaskForDaemon(db, id, workspaceId, daemon_id, body);
      if (!replayed) {
        hub.broadcast({ type: "task.updated", data: task });
        if (advancedIssue) hub.broadcast({ type: "issue.updated", data: advancedIssue });
      }
      return response;
    } catch (e: any) {
      if (typeof e?.code === "string" && typeof e?.http === "number") {
        const respBody: Record<string, unknown> = { code: e.code, message: e.message };
        if (e.details) respBody.details = e.details;
        return reply.code(e.http).send(respBody);
      }
      throw e;
    }
  });

  app.post("/api/daemon/tasks/:id/fail", { preHandler: daemonAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { daemon_id?: string; failure_reason?: string; error?: string; work_dir?: string };
    if (!body.daemon_id || !body.failure_reason || !body.error) {
      return reply.code(400).send({ code: "invalid_schema", message: "daemon_id / failure_reason / error 必填" });
    }
    const workspaceId = (req as any).workspaceId as string;
    try {
      const { response, task, replayed } = failTaskForDaemon(db, id, workspaceId, body.daemon_id, {
        daemon_id: body.daemon_id,
        failure_reason: body.failure_reason,
        error: body.error,
        work_dir: body.work_dir ?? null,
      });
      if (!replayed) {
        hub.broadcast({ type: "task.updated", data: task });
      }
      return response;
    } catch (e: any) {
      if (typeof e?.code === "string" && typeof e?.http === "number") {
        const respBody: Record<string, unknown> = { code: e.code, message: e.message };
        if (e.details) respBody.details = e.details;
        return reply.code(e.http).send(respBody);
      }
      throw e;
    }
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
