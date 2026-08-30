import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { makeDaemonAuth, makeTaskAuth } from "../lib/auth.js";
import {
  claimTasks,
  getTask,
  setIssueStatusFromAgent,
  startTaskForDaemon,
  completeTaskForDaemon,
  failTaskForDaemon,
  COMPLETE_ALLOWED_FIELDS,
} from "../services/tasks.js";
import { getIssue } from "../services/issues.js";
import { registerRuntimes, heartbeat } from "../services/runtimes.js";
import { appendTaskMessages } from "../services/messages.js";
import { submitDeliveryReport, getDeliveryQuery, type DeliveryError } from "../services/delivery.js";
import { FAILURE_REASONS, type ClaimRequest, type DaemonHeartbeatRequest, type DaemonRegisterRequest } from "@anvil/core";

// ----------------------------------------------------------------------------
// R1-FIX1 · 路由层严格运行时校验
//
// 设计原则:
//  1. request body 必须是非 null、非数组的普通 JSON 对象;
//  2. 未知字段白名单之外一律 400 invalid_schema;
//  3. 类型错误、空字符串、未知枚举同样 400 invalid_schema;
//  4. 校验必须发生在调用 service 和计算/写入幂等 hash 之前;
//  5. 校验失败零副作用:Task 状态不变、Issue 状态不变、不写 payload_hash、
//     不写 response_json、不清空 token、不新增评论、不发送广播。
//
// 禁止:把任意 untrusted value 用 String(...) 强转后继续走 service 流程。
// ----------------------------------------------------------------------------

/** 完整 40 位 hex SHA-1 正则(与 server-side isValidGitSha1Hex40 等价)。 */
const SHA1_40_REGEX = /^[0-9a-f]{40}$/i;

/** 字段白名单:start 请求除 `daemon_id` 之外的合法业务字段。
 *  R1-FIX2:Start 请求不允许 `head_commit`(它属于 Complete 请求)。
 *  若 Runner 误把 `head_commit` 放在 Start body,会被"未知字段"分支直接拒绝
 *  为 400 invalid_schema,在调用 service / 计算 hash / 任何副作用之前。 */
const START_ALLOWED_FIELDS = new Set<string>([
  "daemon_id",
  "work_dir",
  "task_branch",
  "target_branch",
  "base_commit",
  "delivery_contract_version",
]);

/** 字段白名单:fail 请求除 `daemon_id` 之外的合法业务字段。
 *  PRD Fail 请求只允许 daemon_id / failure_reason / error / work_dir;
 *  head_commit / worktree_clean / delivery_contract_version 明确不在白名单内。 */
const FAIL_ALLOWED_FIELDS = new Set<string>([
  "daemon_id",
  "failure_reason",
  "error",
  "work_dir",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sendInvalidSchema(reply: FastifyReply, message: string, details?: Record<string, unknown>) {
  const body: Record<string, unknown> = { code: "invalid_schema", message };
  if (details) body.details = details;
  return reply.code(400).send(body);
}

/** 校验后返回 true/false;true 表示字段值合法。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isValidSha1Hex40(v: unknown): v is string {
  return typeof v === "string" && SHA1_40_REGEX.test(v);
}

function isRealBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

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
    // A05:返回完整 DeliveryQueryResponse,而不是只返回 delivered boolean。
    // v1/v2 同时兼容;v1 通过 issue_status_requested 字段反映,无 Report 时 report_submitted=false。
    return getDeliveryQuery(db, id);
  });

  app.post("/api/daemon/tasks/:id/messages", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { messages } = (req.body ?? {}) as { messages?: any[] };
    const result = appendTaskMessages(db, hub, id, messages ?? []);
    if (!result.ok) return reply.code(409).send({ last_seq: result.last_seq });
    return result;
  });

  // A05 · Agent plane:Delivery Report 提交(task token,active v2 Task)
  app.put("/api/daemon/tasks/:id/delivery-report", { preHandler: taskAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = submitDeliveryReport(db, id, req.body ?? null);
      // 广播 task.updated,让 web 看板在 Report 落地时刷新;
      // replay 不广播,避免无变化的噪音。
      if (!result.replay) {
        const task = getTask(db, id);
        if (task) hub.broadcast({ type: "task.updated", data: task });
      }
      return result.response;
    } catch (e: any) {
      if (e && typeof e.code === "string" && typeof e.http === "number") {
        const body: Record<string, unknown> = { code: e.code, message: e.message };
        if (e.details) body.details = e.details;
        return reply.code(e.http).send(body);
      }
      throw e;
    }
  });

  // ---------- A03 · daemon plane:start / complete / fail 改用 daemon token + body.daemon_id ----------

  // ===========================================================================
  // start
  // ===========================================================================
  app.post("/api/daemon/tasks/:id/start", { preHandler: daemonAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    // (1) 顶层必须是普通对象
    const raw = (req.body ?? {}) as unknown;
    if (!isPlainObject(raw)) {
      return sendInvalidSchema(reply, "start body must be a JSON object", {
        received: Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw,
      });
    }

    // (2) 未知字段拒绝
    const unknownFields = Object.keys(raw).filter((k) => !START_ALLOWED_FIELDS.has(k));
    if (unknownFields.length > 0) {
      return sendInvalidSchema(reply, `start body 包含未知字段:${unknownFields.join(", ")}`, {
        unknown_fields: unknownFields,
        allowed_fields: [...START_ALLOWED_FIELDS].filter((f) => f !== "daemon_id"),
      });
    }

    // (3) 必填字段严格类型
    if (!isNonEmptyString(raw.daemon_id)) {
      return sendInvalidSchema(reply, "daemon_id must be a non-empty string", { field: "daemon_id" });
    }
    if (!isNonEmptyString(raw.work_dir)) {
      return sendInvalidSchema(reply, "work_dir must be a non-empty string", { field: "work_dir" });
    }

    // (4) 可选字段(存在时必须是合法类型;null 等同于不存在)
    if (raw.task_branch !== undefined && raw.task_branch !== null) {
      if (!isNonEmptyString(raw.task_branch)) {
        return sendInvalidSchema(reply, "task_branch must be a non-empty string when present", { field: "task_branch" });
      }
    }
    if (raw.target_branch !== undefined && raw.target_branch !== null) {
      if (!isNonEmptyString(raw.target_branch)) {
        return sendInvalidSchema(reply, "target_branch must be a non-empty string when present", { field: "target_branch" });
      }
    }
    if (raw.base_commit !== undefined && raw.base_commit !== null) {
      if (!isValidSha1Hex40(raw.base_commit)) {
        return sendInvalidSchema(reply, "base_commit must be a 40-character hex SHA-1", { field: "base_commit" });
      }
    }
    if (raw.delivery_contract_version !== undefined && raw.delivery_contract_version !== null) {
      if (raw.delivery_contract_version !== 2) {
        return sendInvalidSchema(reply, "delivery_contract_version must be 2 when present", {
          field: "delivery_contract_version",
          value: raw.delivery_contract_version,
        });
      }
    }

    // 校验全部通过 → 进入 service(零副作用前置守卫)
    // Start body 不允许 head_commit(它属于 Complete 请求);若 Runner 误传,
    // 上面"未知字段"分支已经在调用 service / 计算 hash 之前返回 400 invalid_schema。
    const body = raw as {
      daemon_id: string; work_dir: string;
      task_branch?: string | null; target_branch?: string | null;
      base_commit?: string | null; delivery_contract_version?: number | null;
    };
    const workspaceId = (req as any).workspaceId as string;
    try {
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

  // ===========================================================================
  // complete
  // ===========================================================================
  app.post("/api/daemon/tasks/:id/complete", { preHandler: daemonAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    // (1) 顶层必须是普通对象
    const raw = (req.body ?? {}) as unknown;
    if (!isPlainObject(raw)) {
      return sendInvalidSchema(reply, "complete body must be a JSON object", {
        received: Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw,
      });
    }

    // (2) 未知字段拒绝
    const unknownFields = Object.keys(raw).filter((k) => !COMPLETE_ALLOWED_FIELDS.has(k));
    if (unknownFields.length > 0) {
      return sendInvalidSchema(reply, `complete body 包含未知字段:${unknownFields.join(", ")}`, {
        unknown_fields: unknownFields,
        allowed_fields: [...COMPLETE_ALLOWED_FIELDS].filter((f) => f !== "daemon_id"),
      });
    }

    // (3) 必填:daemon_id
    if (!isNonEmptyString(raw.daemon_id)) {
      return sendInvalidSchema(reply, "daemon_id must be a non-empty string", { field: "daemon_id" });
    }

    // (4) 字符串字段存在时必须是字符串
    for (const f of ["branch", "work_dir", "diff_stat", "session_id"] as const) {
      if (raw[f] !== undefined && raw[f] !== null) {
        if (typeof raw[f] !== "string") {
          return sendInvalidSchema(reply, `${f} must be a string when present`, { field: f });
        }
      }
    }

    // (5) SHA 字段存在时必须是 40 hex
    for (const f of ["base_commit", "head_commit"] as const) {
      if (raw[f] !== undefined && raw[f] !== null) {
        if (!isValidSha1Hex40(raw[f])) {
          return sendInvalidSchema(reply, `${f} must be a 40-character hex SHA-1`, { field: f });
        }
      }
    }

    // (6) 布尔字段存在时必须是真正的 boolean(禁止 "yes"/"no"/0/1 等隐式转换)
    for (const f of ["worktree_clean", "pushed", "undelivered"] as const) {
      if (raw[f] !== undefined && raw[f] !== null) {
        if (!isRealBoolean(raw[f])) {
          return sendInvalidSchema(reply, `${f} must be a real boolean when present`, { field: f });
        }
      }
    }

    // (7) verification 存在时至少必须是普通对象(A07 深层业务校验不在本任务)
    if (raw.verification !== undefined && raw.verification !== null) {
      if (!isPlainObject(raw.verification)) {
        return sendInvalidSchema(reply, "verification must be a JSON object when present", { field: "verification" });
      }
    }

    // 校验通过 → 进入 service
    const workspaceId = (req as any).workspaceId as string;
    try {
      const { response, task, replayed, advancedIssue } = completeTaskForDaemon(db, id, workspaceId, raw.daemon_id, raw);
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

  // ===========================================================================
  // fail
  // ===========================================================================
  app.post("/api/daemon/tasks/:id/fail", { preHandler: daemonAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };

    // (1) 顶层必须是普通对象
    const raw = (req.body ?? {}) as unknown;
    if (!isPlainObject(raw)) {
      return sendInvalidSchema(reply, "fail body must be a JSON object", {
        received: Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw,
      });
    }

    // (2) 未知字段拒绝 —— fail 只允许 daemon_id/failure_reason/error/work_dir
    // head_commit/worktree_clean/delivery_contract_version 都属于非法字段
    const unknownFields = Object.keys(raw).filter((k) => !FAIL_ALLOWED_FIELDS.has(k));
    if (unknownFields.length > 0) {
      return sendInvalidSchema(reply, `fail body 包含未知字段:${unknownFields.join(", ")}`, {
        unknown_fields: unknownFields,
        allowed_fields: [...FAIL_ALLOWED_FIELDS].filter((f) => f !== "daemon_id"),
      });
    }

    // (3) 必填字段严格类型
    if (!isNonEmptyString(raw.daemon_id)) {
      return sendInvalidSchema(reply, "daemon_id must be a non-empty string", { field: "daemon_id" });
    }
    if (typeof raw.failure_reason !== "string" || (FAILURE_REASONS as readonly string[]).indexOf(raw.failure_reason) < 0) {
      return sendInvalidSchema(reply, `failure_reason must be one of ${FAILURE_REASONS.join("|")}`, {
        field: "failure_reason",
        value: raw.failure_reason,
      });
    }
    if (!isNonEmptyString(raw.error)) {
      return sendInvalidSchema(reply, "error must be a non-empty string", { field: "error" });
    }

    // (4) work_dir:存在时必须是字符串(允许 null,代表"未在 worktree 中失败")
    if (raw.work_dir !== undefined && raw.work_dir !== null) {
      if (typeof raw.work_dir !== "string") {
        return sendInvalidSchema(reply, "work_dir must be a string when present", { field: "work_dir" });
      }
    }

    // 校验通过 → 进入 service
    const workspaceId = (req as any).workspaceId as string;
    try {
      const { response, task, replayed } = failTaskForDaemon(db, id, workspaceId, raw.daemon_id, {
        daemon_id: raw.daemon_id,
        failure_reason: raw.failure_reason,
        error: raw.error,
        work_dir: raw.work_dir ?? null,
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
    if (!r.ok) {
      // A05: v2 in_review/done 拒绝时由 setIssueStatusFromAgent 返回 code + http
      if (r.http && r.code) {
        return reply.code(r.http).send({ code: r.code, message: r.error });
      }
      return reply.code(400).send({ error: r.error });
    }
    const task = getTask(db, id)!;
    hub.broadcast({ type: "issue.updated", data: getIssue(db, task.issue_id) });
    return { ok: true };
  });
}
