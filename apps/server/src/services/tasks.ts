import crypto from "node:crypto";
import { newId, type Db } from "../db/client.js";
import { sha256Hex } from "../lib/hash.js";
import { getIssue, addComment } from "./issues.js";
import {
  DELIVERY_CONTRACT_CURRENT_VERSION,
  AnvilErrorCode,
  canonicalJsonHash,
} from "@anvil/core";
import type { Issue, Task, TaskComment, TaskPackage, RepositorySnapshot, ReviewPacketStatus, V2CompleteResponse } from "@anvil/core";
import { validateCompleteEvidence, redactVerification, persistVerification, getDeliveryReport, deriveCompletedPacketStatus } from "./delivery.js";

/** SQLite 没有原生 boolean;raw SQL 读出的 worktree_clean 是 0/1/null。
 *  把它归一化为 Task 协议规定的 `boolean | null`:null 保持 null,0/1 转 boolean。 */
function normalizeTaskRow(row: Record<string, unknown>): Record<string, unknown> {
  if ("worktree_clean" in row) {
    const wc = row.worktree_clean;
    row.worktree_clean = (wc === null || wc === undefined) ? null : Boolean(wc);
  }
  return row;
}

export const LEASE_MS = 2 * 60 * 1000;

/** 已绑定 Task 只能消费入队时的快照；损坏/部分绑定不能退回可变 Issue。 */
function readRepositorySnapshot(task: Task): RepositorySnapshot | null {
  if (!task.repository_id && !task.repository_snapshot_json && !task.source_snapshot_id) return null;
  let snapshot: RepositorySnapshot;
  try { snapshot = JSON.parse(task.repository_snapshot_json ?? "null"); }
  catch { throw new Error("任务仓库快照损坏，请重新执行"); }
  const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (!snapshot || snapshot.schema_version !== 1 || !validText(snapshot.repository_id)
    || snapshot.repository_id !== task.repository_id || !["local_git", "github_pr"].includes(snapshot.mode)
    || ![snapshot.host, snapshot.external_id, snapshot.full_name, snapshot.clone_url, snapshot.target_branch, snapshot.checkout_path].every(validText)
    || !snapshot.identity || !validText(snapshot.identity.real_path)
    || typeof snapshot.identity.dev !== "string" || !/^\d+$/.test(snapshot.identity.dev)
    || typeof snapshot.identity.ino !== "string" || !/^\d+$/.test(snapshot.identity.ino)
    || snapshot.source_snapshot_id !== (task.source_snapshot_id ?? null)
    || !(snapshot.source_snapshot_id === null || validText(snapshot.source_snapshot_id))
    || !snapshot.input || typeof snapshot.input.title !== "string"
    || !(snapshot.input.description === null || typeof snapshot.input.description === "string")
    || !(snapshot.input.acceptance === null || typeof snapshot.input.acceptance === "string")) {
    throw new Error("任务仓库快照缺失或与任务不一致，请重新执行");
  }
  return snapshot;
}

function issueForTask(issue: Issue, snapshot: RepositorySnapshot | null): Issue {
  if (!snapshot) return issue;
  return {
    ...issue, ...snapshot.input, repo_path: snapshot.checkout_path,
    repository_id: snapshot.repository_id, source_snapshot_id: snapshot.source_snapshot_id,
  };
}

/** 不给旧任务猜仓库身份，也不自动重试出另一条同样缺快照的任务。 */
function rejectQueuedSnapshot(db: Db, task: Task, error: string): void {
  db.$client.transaction(() => {
    const updated = db.$client.prepare(`UPDATE tasks SET status='failed',failure_reason=NULL,error=?,completed_at=?,
      task_token_hash=NULL,lease_expires_at=NULL WHERE id=? AND status='queued'`)
      .run(error, new Date().toISOString(), task.id);
    if (updated.changes === 1) {
      addComment(db, task.issue_id, { author_type: "system", author_id: "system", type: "system", body: error });
      syncAgentIdle(db, task.agent_id);
    }
  }).immediate();
}

/** A03 · 读 runtime 行(daemon plane ownership 反查需要)。 */
export function getRuntimeById(db: Db, runtimeId: string) {
  return db.$client.prepare(`SELECT * FROM runtimes WHERE id = ?`).get(runtimeId) as
    | { id: string; workspace_id: string; daemon_id: string; provider: string; version: string | null; status: string; last_seen_at: string | null }
    | undefined;
}

/** A03 · runtime ownership 结构化错误(route 层捕获并返回 403)。 */
export interface RuntimeOwnershipError extends Error {
  code: "runtime_ownership_mismatch";
  http: 403;
  message: string;
  details?: Record<string, unknown>;
}

function makeOwnershipError(message: string, details?: Record<string, unknown>): RuntimeOwnershipError {
  const e = new Error(message) as RuntimeOwnershipError;
  e.code = "runtime_ownership_mismatch";
  e.http = 403;
  e.details = details;
  return e;
}

/**
 * A03 · runtime ownership 校验:仅 workspace 一致不够,必须从 Task.runtime_id 反查 runtime
 * 并确认 runtime.daemon_id === body.daemon_id;任一环节不满足抛结构化错误。
 * 错误时不得推进 Task / 写幂等字段 / 广播 / 改 Agent-Runtime 状态。
 */
export function assertRuntimeOwnership(db: Db, task: Task, workspaceId: string, daemonId: string) {
  if (task.workspace_id !== workspaceId) {
    throw makeOwnershipError("Task 不属于当前 workspace", { task_id: task.id, task_ws: task.workspace_id, auth_ws: workspaceId });
  }
  if (!task.runtime_id) {
    throw makeOwnershipError("Task 尚未绑定 runtime,无法由 daemon 上报", { task_id: task.id });
  }
  const rt = getRuntimeById(db, task.runtime_id);
  if (!rt) {
    throw makeOwnershipError("Task 引用的 runtime 不存在", { task_id: task.id, runtime_id: task.runtime_id });
  }
  if (rt.workspace_id !== workspaceId) {
    throw makeOwnershipError("Runtime workspace 与 daemon token workspace 不一致", { task_id: task.id, runtime_id: rt.id });
  }
  if (rt.daemon_id !== daemonId) {
    throw makeOwnershipError("daemon_id 不拥有 Task 引用的 runtime", { task_id: task.id, runtime_id: rt.id, body_daemon_id: daemonId, runtime_daemon_id: rt.daemon_id });
  }
}

/** A03 · D-003 幂等键:读取 operation 之前保存的 hash 与 response。 */
function readOpIdempotency(db: Db, taskId: string, op: "start" | "complete" | "fail") {
  const row = db.$client
    .prepare(`SELECT start_payload_hash, start_response_json, complete_payload_hash, complete_response_json, fail_payload_hash, fail_response_json FROM tasks WHERE id = ?`)
    .get(taskId) as any;
  if (!row) return { hash: null as string | null, response: null as string | null };
  if (op === "start") return { hash: row.start_payload_hash as string | null, response: row.start_response_json as string | null };
  if (op === "complete") return { hash: row.complete_payload_hash as string | null, response: row.complete_response_json as string | null };
  return { hash: row.fail_payload_hash as string | null, response: row.fail_response_json as string | null };
}

/** A03 · D-003:首次成功后持久化 hash 与 response。response 是完整 JSON 字符串,原样回放。
 *  包含 SQL 列名,只允许在白名单的 3 个 operation 中调用,以避免 SQL 注入(op 来自硬编码字符串)。 */
function writeOpIdempotency(db: Db, taskId: string, op: "start" | "complete" | "fail", hash: string, response: string) {
  if (op === "start") db.$client.prepare(`UPDATE tasks SET start_payload_hash=?, start_response_json=? WHERE id=?`).run(hash, response, taskId);
  else if (op === "complete") db.$client.prepare(`UPDATE tasks SET complete_payload_hash=?, complete_response_json=? WHERE id=?`).run(hash, response, taskId);
  else db.$client.prepare(`UPDATE tasks SET fail_payload_hash=?, fail_response_json=? WHERE id=?`).run(hash, response, taskId);
}

/**
 * A03-FIX · 校验 start 携带的 v2 锚点。返回 null 表示校验通过;否则返回结构化错误。
 *
 * 两种明确模式:
 *  - 兼容模式:四项全部缺省(null/undefined)。不生成假数据;保留旧 Runner 临时路径。
 *  - 完整 v2 模式:四项必须全部提供,且 task_branch / target_branch 非空、
 *    base_commit 严格 40 位 hex、delivery_contract_version === 2 且等于 Task 已存值。
 *
 * 部分提供(例如只填 task_branch)→ 400 invalid_schema。
 * 非法格式(空 branch / 非 40 位 SHA / version 错)→ 400 invalid_schema。
 * 与 Task 已存锚点不一致 → 409 base_mismatch。
 *
 * 注意:非法 Git 锚点(机器码)留给 R1 契约审查;此处暂用 invalid_schema 表达。
 */
export function validateStartAnchors(
  task: Task,
  payload: {
    task_branch?: string | null;
    target_branch?: string | null;
    base_commit?: string | null;
    delivery_contract_version?: number | null;
  },
): { ok: true } | { ok: false; http: number; code: AnvilErrorCode; message: string; details: Record<string, unknown> } {
  let repositorySnapshot: RepositorySnapshot | null;
  try { repositorySnapshot = readRepositorySnapshot(task); }
  catch (error) {
    return { ok: false, http: 409, code: "base_mismatch", message: (error as Error).message, details: { task_id: task.id } };
  }
  const hasAnyAnchor =
    payload.task_branch != null || payload.target_branch != null ||
    payload.base_commit != null || payload.delivery_contract_version != null;

  // 兼容模式:全 null,放行
  if (!hasAnyAnchor && !repositorySnapshot) return { ok: true };

  // 至少一项存在 → 必须是完整 v2
  if (payload.task_branch == null || payload.target_branch == null ||
      payload.base_commit == null || payload.delivery_contract_version == null) {
    return {
      ok: false, http: 400, code: "invalid_schema",
      message: "v2 锚点必须四项齐全(task_branch / target_branch / base_commit / delivery_contract_version),不能部分提供",
      details: {
        provided: {
          task_branch: payload.task_branch ?? null,
          target_branch: payload.target_branch ?? null,
          base_commit: payload.base_commit ?? null,
          delivery_contract_version: payload.delivery_contract_version ?? null,
        },
      },
    };
  }

  // A03-FIX4 · task_branch 严格 Git ref 校验
  const taskBranchErr = validateGitRef("task_branch", payload.task_branch);
  if (taskBranchErr) {
    return {
      ok: false, http: 400, code: "invalid_git_anchor",
      message: `task_branch 非法:${taskBranchErr.reason}`,
      details: { field: "task_branch", value: taskBranchErr.value, reason: taskBranchErr.reason },
    };
  }
  // A03-FIX4 · target_branch 严格 Git ref 校验
  const targetBranchErr = validateGitRef("target_branch", payload.target_branch);
  if (targetBranchErr) {
    return {
      ok: false, http: 400, code: "invalid_git_anchor",
      message: `target_branch 非法:${targetBranchErr.reason}`,
      details: { field: "target_branch", value: targetBranchErr.value, reason: targetBranchErr.reason },
    };
  }

  // A03-FIX4 · base_commit 严格 40 位 hex SHA-1
  if (!isValidGitSha1Hex40(payload.base_commit)) {
    return {
      ok: false, http: 400, code: "invalid_git_anchor",
      message: "base_commit 必须是完整 40 位 hex SHA-1",
      details: { field: "base_commit", value: String(payload.base_commit) },
    };
  }

  // delivery_contract_version 必须是 2,且与 Task 已存值一致
  if (payload.delivery_contract_version !== 2) {
    return {
      ok: false, http: 400, code: "invalid_schema",
      message: "delivery_contract_version 必须等于 2", details: { field: "delivery_contract_version", value: payload.delivery_contract_version },
    };
  }
  if (task.delivery_contract_version !== payload.delivery_contract_version) {
    return {
      ok: false, http: 400, code: "invalid_schema",
      message: "delivery_contract_version 与 Task 已存值不一致",
      details: { task_value: task.delivery_contract_version, payload_value: payload.delivery_contract_version },
    };
  }

  if (repositorySnapshot && payload.target_branch !== repositorySnapshot.target_branch) {
    return {
      ok: false, http: 409, code: "base_mismatch", message: "目标分支与 Task 入队快照不一致",
      details: { field: "target_branch", task_value: repositorySnapshot.target_branch, payload_value: payload.target_branch },
    };
  }

  // Task 已存锚点必须一致(已存 task_branch / target_branch / base_commit 都不允许被覆盖)
  if (task.task_branch != null && task.task_branch !== payload.task_branch) {
    return {
      ok: false, http: 409, code: "base_mismatch",
      message: "Task 已存 task_branch,不允许 UPDATE 覆盖", details: { field: "task_branch", task_value: task.task_branch, payload_value: payload.task_branch },
    };
  }
  if (task.target_branch != null && task.target_branch !== payload.target_branch) {
    return {
      ok: false, http: 409, code: "base_mismatch",
      message: "Task 已存 target_branch,不允许 UPDATE 覆盖", details: { field: "target_branch", task_value: task.target_branch, payload_value: payload.target_branch },
    };
  }
  if (task.base_commit != null && task.base_commit !== payload.base_commit) {
    return {
      ok: false, http: 409, code: "base_mismatch",
      message: "Task 已存 base_commit,不允许 UPDATE 覆盖", details: { field: "base_commit", task_value: task.base_commit, payload_value: payload.base_commit },
    };
  }

  return { ok: true };
}


/**
 * A03-FIX · 从 result_json 业务字段中剥离 daemon_id。
 * complete 调用方需要把 daemon_id 参与 hash(让"同 daemon 重放"语义一致),
 * 但 result_json 是业务结果,daemon_id 属于协议包络,不能写进 task.result_json。
 */
export function stripDaemonIdFromResult(body: Record<string, unknown>): Record<string, unknown> {
  const { daemon_id: _ignored, ...rest } = body;
  return rest;
}

/**
 * A03-FIX4 · 严格 Git ref 校验。返回 null 表示通过;否则返回结构化错误。
 *
 * 拒绝:
 *  - 空字符串
 *  - 前后空白
 *  - 含 ASCII 控制字符(< 0x20 或 0x7f)
 *  - 含空格
 *  - 含 `~` `^` `:` `?` `*` `[` `\`
 *  - 含 `..`
 *  - 含 `@{`
 *  - 以 `/` 开头或结尾
 *  - 含 `//`
 *  - 以 `.` 结尾
 *  - 任一路径片段以 `.` 开头
 *  - 任一路径片段以 `.lock` 结尾
 *  - 单独的 `@`
 *  - 以 `-` 开头
 *
 * 允许正常示例:
 *  - "main"、"develop"
 *  - "task/abc12345"
 *  - "feature/中文说明"
 *  - "release/v1.2.3"
 *
 * 不调任何外部命令:这是无副作用的纯字符串校验函数。
 */
export type GitRefValidationError = { field: string; value: string; reason: string };

export function validateGitRef(field: "task_branch" | "target_branch", value: unknown): GitRefValidationError | null {
  if (typeof value !== "string") {
    return { field, value: typeof value === "string" ? value : String(value), reason: "must be a string" };
  }
  // 拒绝前后空白 —— 不做 .trim(),因为 branch 字面就是分支名
  if (value.length === 0) {
    return { field, value, reason: "empty string" };
  }
  if (value !== value.trim()) {
    return { field, value, reason: "leading or trailing whitespace" };
  }
  // ASCII 控制字符(< 0x20) + DEL(0x7f)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { field, value, reason: "contains ASCII control characters" };
  }
  if (value.includes(" ")) {
    return { field, value, reason: "contains space" };
  }
  // 严格列出禁止字符
  const bannedChars = ["~", "^", ":", "?", "*", "[", "\\"];
  for (const c of bannedChars) {
    if (value.includes(c)) {
      return { field, value, reason: `contains banned character '${c}'` };
    }
  }
  if (value.includes("..")) {
    return { field, value, reason: "contains '..'" };
  }
  if (value.includes("@{")) {
    return { field, value, reason: "contains '@{'" };
  }
  if (value.startsWith("/") || value.endsWith("/")) {
    return { field, value, reason: "starts or ends with '/'" };
  }
  if (value.includes("//")) {
    return { field, value, reason: "contains '//'" };
  }
  if (value.endsWith(".")) {
    return { field, value, reason: "ends with '.'" };
  }
  if (value === "@") {
    return { field, value, reason: "single '@' is not a valid ref" };
  }
  if (value.startsWith("-")) {
    return { field, value, reason: "starts with '-'" };
  }
  // 路径片段检查
  const segments = value.split("/");
  for (const seg of segments) {
    if (seg.startsWith(".")) {
      return { field, value, reason: `path segment '${seg}' starts with '.'` };
    }
    if (seg.endsWith(".lock")) {
      return { field, value, reason: `path segment '${seg}' ends with '.lock'` };
    }
  }
  return null;
}

/**
 * A03-FIX4 · 严格 SHA-1 40 位 hex 校验。不依赖外部库,纯字符串检查。
 */
export function isValidGitSha1Hex40(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * A03-FIX4 · 服务端 token 脱敏:在 hash 与持久化之前完成。
 *
 * 识别并替换:
 *  - `anv_<token-content>`                → anv_[REDACTED]
 *  - `atk_<token-content>`                → atk_[REDACTED]
 *  - `Authorization: Bearer <value>`      → Authorization: Bearer [REDACTED]
 *  - `Bearer <value>`                     → Bearer [REDACTED]
 *
 * 原始 token 不得出现在:tasks.error、fail_response_json、HTTP 错误响应、测试日志。
 *
 * 适用范围:fail.error(以及其它 runner 自由文本字段若有)。
 */
export const TOKEN_REDACTION_PLACEHOLDER = "[REDACTED]";

export function redactTokens(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  // 顺序固定,保证不被后续规则误匹配:
  // 1. Authorization ... Bearer <value>(大小写不敏感,允许 : 两侧任意空白)。
  //    凭据从 Bearer 之后第一个非空白字符开始(\S+),到下一个空白字符结束。
  //    不能再用受限字符集([A-Za-z0-9_\-\.]+)——JWT/Bearer 凭据常含 `/` `+` `=` `~`。
  //    加 negative lookahead 防止对已脱敏的 `[REDACTED]` 重复匹配。
  out = out.replace(
    /(Authorization\s*:\s*Bearer\s+)(?!\[REDACTED\])\S+/gi,
    `$1${TOKEN_REDACTION_PLACEHOLDER}`,
  );
  // 2. 独立的 "Bearer <value>" 形式,大小写不敏感,同样取到下一个空白字符。
  //    用 `(^|[^\w])` 避免在单词中间误匹配("fooBearer" 不算 Bearer token)。
  out = out.replace(
    /(^|[^\w])Bearer\s+(?!\[REDACTED\])\S+/gi,
    (_m, prefix) => `${prefix}Bearer ${TOKEN_REDACTION_PLACEHOLDER}`,
  );
  // 3. Anvil 内部 token。字符集:字母/数字/下划线/连字符(anvil 自己的 token 生成规则)。
  //    长 token 在前,避免短前缀吃掉长 token 的前缀。
  out = out.replace(/anv_[A-Za-z0-9_\-]+/g, `anv_${TOKEN_REDACTION_PLACEHOLDER}`);
  out = out.replace(/atk_[A-Za-z0-9_\-]+/g, `atk_${TOKEN_REDACTION_PLACEHOLDER}`);
  return out;
}

/**
 * A03-FIX4 · 完整 payload 允许字段白名单。未知字段必须被拒绝(400 invalid_schema)。
 * 注意:daemon_id 是必需字段,会被单独校验,不在"业务字段"白名单内。
 */
export const COMPLETE_ALLOWED_FIELDS = new Set<string>([
  "daemon_id",
  "branch",
  "diff_stat",
  "work_dir",
  "session_id",
  "pushed",
  "undelivered",
  "base_commit",
  "head_commit",
  "worktree_clean",
  "verification",
]);


/**
 * A03 · 标准化业务 payload 用于哈希(去 daemonId 之外的所有请求包络字段),
 * 避免因时序键、客户端冗余字段导致 hash 漂移。
 * 故意不包含 token、Authorization、任何随机 ID 或时间戳。
 * A03-FIX:start 接受完整 v2 锚点(task_branch / target_branch / base_commit / delivery_contract_version),
 * 都必须参与 hash 参与 replay 检测。
 * R1-FIX1:导出供测试与 runXxxInTransaction 共用同一规范化逻辑。
 */
export function normalizeOpPayload(op: "start" | "complete" | "fail", body: unknown): unknown {
  if (op === "start") {
    const b = body as {
      daemon_id?: string; work_dir?: string;
      task_branch?: string | null; target_branch?: string | null;
      base_commit?: string | null; delivery_contract_version?: number | null;
    };
    const out: Record<string, unknown> = {
      daemon_id: String(b.daemon_id ?? ""),
      work_dir: String(b.work_dir ?? ""),
    };
    // 仅当请求携带锚点时纳入 hash;老 Runner 不携带这些字段,继续走兼容路径且不生成假数据。
    if (b.task_branch !== undefined && b.task_branch !== null) out.task_branch = b.task_branch;
    if (b.target_branch !== undefined && b.target_branch !== null) out.target_branch = b.target_branch;
    if (b.base_commit !== undefined && b.base_commit !== null) out.base_commit = b.base_commit;
    if (b.delivery_contract_version !== undefined && b.delivery_contract_version !== null) {
      out.delivery_contract_version = b.delivery_contract_version;
    }
    return out;
  }
  if (op === "complete") {
    // 客户端业务字段与持久化快照一致；daemon_id 仅参与 hash，服务端派生字段另行追加。
    // 字段白名单:daemon_id / branch / diff_stat / work_dir / session_id / pushed / undelivered /
    // base_commit / head_commit / worktree_clean / verification。
    // 未知字段(顶层)由 route 在调用 service 之前用 rejectUnknownCompleteFields 拒绝。
    const b = body as Record<string, unknown>;
    const out: Record<string, unknown> = { daemon_id: String(b.daemon_id ?? "") };
    if (b.branch !== undefined) out.branch = b.branch;
    if (b.diff_stat !== undefined) out.diff_stat = b.diff_stat;
    if (b.work_dir !== undefined) out.work_dir = b.work_dir;
    if (b.session_id !== undefined) out.session_id = b.session_id;
    if (b.pushed !== undefined) out.pushed = b.pushed;
    if (b.undelivered !== undefined) out.undelivered = b.undelivered;
    if (b.base_commit !== undefined) out.base_commit = b.base_commit;
    if (b.head_commit !== undefined) out.head_commit = b.head_commit;
    if (b.worktree_clean !== undefined) out.worktree_clean = b.worktree_clean;
    if (b.verification !== undefined) out.verification = redactVerification(b.verification);
    return out;
  }
  // fail: error 在 hash 之前走 redactTokens;原始 token 不参与 hash,也不进 tasks.error。
  const b = body as Record<string, unknown>;
  const redactedError = redactTokens(String(b.error ?? ""));
  const out: Record<string, unknown> = {
    daemon_id: String(b.daemon_id ?? ""),
    failure_reason: String(b.failure_reason ?? ""),
    error: redactedError,
  };
  if (b.work_dir !== undefined) out.work_dir = b.work_dir;
  return out;
}

/**
 * complete 的客户端业务快照，与 hash 输入保持相同的字段和值（剥离 daemon_id）。
 * v2 在事务内另加 schema_version、verification_run_id 与 review_packet_status；
 * 这些服务端派生值不参与请求 hash，重放直接返回首次持久化的回执。
 */
export function buildCompleteResultJson(payload: Record<string, unknown>): Record<string, unknown> {
  // 与 normalizeOpPayload("complete") 同字段集合,只剥 daemon_id
  const out: Record<string, unknown> = {};
  const keys = ["branch", "diff_stat", "work_dir", "session_id", "pushed", "undelivered",
                "base_commit", "head_commit", "worktree_clean", "verification"];
  for (const k of keys) {
    if (payload[k] !== undefined) out[k] = k === "verification" ? redactVerification(payload[k]) : payload[k];
  }
  return out;
}

/**
 * A03-FIX4 · fail 业务字段(用于 tasks.error)从脱敏后的 payload 派生。
 * 关键:error 字段在 hash 之前已 redactTokens;这里直接读取 payload 已被规范化的 error。
 */
export function buildFailPersistedFields(payload: Record<string, unknown>): { error: string; failure_reason: string; work_dir: string | null } {
  return {
    error: redactTokens(String(payload.error ?? "")),
    failure_reason: String(payload.failure_reason ?? ""),
    work_dir: payload.work_dir != null ? String(payload.work_dir) : null,
  };
}


export function getTask(db: Db, id: string): Task | null {
  const row = db.$client.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return normalizeTaskRow(row) as unknown as Task;
}

/** 任务进入终态后回写 agent 状态：没有 dispatched/running 任务则置回 idle。 */
function syncAgentIdle(db: Db, agentId: string) {
  const active = db.$client
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('dispatched','running')`)
    .get(agentId) as any;
  if (active.n === 0)
    db.$client.prepare(`UPDATE agents SET status='idle' WHERE id = ?`).run(agentId);
}

/**
 * 原子认领：候选按 priority DESC, created_at ASC 排序；
 * 逐个用单条 UPDATE ... WHERE status='queued' 判赢（better-sqlite3 同步执行 + SQLite 单写者，
 * 语义等价 FOR UPDATE SKIP LOCKED）。认领前检查 agent 并发上限。
 *
 * T01：绑定 Task 消费不可变输入，采用新工作树，不从其他 Task 猜测续作。
 * A04-FIX1 · 未绑定历史任务继续沿用跨 Task 锚点接力:
 *  - Git 仓库任务:优先读 prior Task 的 task_branch / target_branch / base_commit,
 *    全部完整且合法时,在认领 UPDATE 中一并 SET 到当前 Task;prior_work_dir 一并下发。
 *    当前 Task 已存锚点与 prior 一致时允许补齐缺失字段;不一致则拒绝继承
 *    (prior_work_dir 也不下发,Runner 走 fresh worktree 路径)。
 *  - 无 repo_path 普通目录任务:prior_work_dir 正常下发,三锚点保持 null,不要求继承。
 *  - 历史 v1 prior(有 work_dir 但缺完整锚点):不向 Runner 返回该 prior_work_dir,
 *    不猜测锚点,新 Task 走 fresh worktree。
 *  - 锚点继承绝不能复制 head_commit / verification_status / verification_run_id /
 *    任何 payload hash 或 response JSON 等完成证据。
 */
export function claimTasks(db: Db, workspaceId: string, daemonId: string, maxTasks: number): TaskPackage[] {
  const providers = (db.$client
    .prepare(`SELECT provider FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND status = 'online'`)
    .all(workspaceId, daemonId) as any[]).map((r) => r.provider);
  if (providers.length === 0) return [];

  const out: TaskPackage[] = [];
  const candidates = db.$client
    .prepare(`SELECT * FROM tasks WHERE workspace_id = ? AND status = 'queued'
              ORDER BY priority DESC, created_at ASC LIMIT 50`)
    .all(workspaceId) as any[];

  for (const cand of candidates) {
    if (out.length >= maxTasks) break;
    const agent = db.$client.prepare(`SELECT * FROM agents WHERE id = ?`).get(cand.agent_id) as any;
    if (!agent || !providers.includes(agent.provider)) continue;
    const running = db.$client
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('dispatched','running')`)
      .get(cand.agent_id) as any;
    if (running.n >= agent.max_concurrent_tasks) continue;

    const currentIssue = getIssue(db, cand.issue_id)!;
    let repositorySnapshot: RepositorySnapshot | null;
    try { repositorySnapshot = readRepositorySnapshot(cand); }
    catch (error) {
      rejectQueuedSnapshot(db, cand, (error as Error).message);
      continue;
    }
    if (!repositorySnapshot && currentIssue.repository_id) {
      rejectQueuedSnapshot(db, cand, "旧任务缺仓库快照，请重新执行");
      continue;
    }
    const frozenIssue = issueForTask(currentIssue, repositorySnapshot);

    const runtime = db.$client
      .prepare(`SELECT * FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND provider = ? AND status = 'online'`)
      .get(workspaceId, daemonId, agent.provider) as any;
    const taskToken = `atk_${crypto.randomBytes(24).toString("hex")}`;
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    const now = new Date().toISOString();
    // 绑定 Task 暂按 fresh 执行；历史未绑定任务继续读取 prior 的 Git 锚点。
    // 故意只 SELECT 锚点字段,不读 head_commit / verification_* / 任何 hash / response_json:
    // 这些是完成证据,本次认领不得复制。
    const prior = repositorySnapshot ? null : db.$client
      .prepare(`SELECT work_dir, task_branch, target_branch, base_commit
                FROM tasks WHERE issue_id = ? AND id != ? AND work_dir IS NOT NULL
                  AND repository_id IS NULL AND repository_snapshot_json IS NULL
                ORDER BY created_at DESC LIMIT 1`)
      .get(cand.issue_id, cand.id) as any;

    // 计算继承决策:issue.repo_path 决定本次任务是 Git 还是普通目录
    const issueHasRepo = !!frozenIssue.repo_path;
    let priorWorkDir: string | null = null;
    let inheritTaskBranch: string | null = null;
    let inheritTargetBranch: string | null = null;
    let inheritBaseCommit: string | null = null;

    if (prior?.work_dir) {
      if (!issueHasRepo) {
        // A · 无 repo_path 普通目录任务:prior_work_dir 正常下发,三锚点保持 null
        priorWorkDir = prior.work_dir;
      } else {
        // B · Git 仓库任务:必须 prior 三锚点齐全才继承
        const tBranch = typeof prior.task_branch === "string" && prior.task_branch.length > 0 ? prior.task_branch : null;
        const tgBranch = typeof prior.target_branch === "string" && prior.target_branch.length > 0 ? prior.target_branch : null;
        const bCommit = typeof prior.base_commit === "string" && isValidGitSha1Hex40(prior.base_commit) ? prior.base_commit.toLowerCase() : null;
        if (tBranch && tgBranch && bCommit) {
          // 当前 cand 已有锚点必须与 prior 一致,否则不继承
          const curBranch = typeof cand.task_branch === "string" && cand.task_branch.length > 0 ? cand.task_branch : null;
          const curTg = typeof cand.target_branch === "string" && cand.target_branch.length > 0 ? cand.target_branch : null;
          const curBase = typeof cand.base_commit === "string" && isValidGitSha1Hex40(cand.base_commit) ? cand.base_commit.toLowerCase() : null;
          const branchOk = curBranch == null || curBranch === tBranch;
          const tgOk = curTg == null || curTg === tgBranch;
          const baseOk = curBase == null || curBase === bCommit;
          if (branchOk && tgOk && baseOk) {
            priorWorkDir = prior.work_dir;
            inheritTaskBranch = tBranch;
            inheritTargetBranch = tgBranch;
            inheritBaseCommit = bCommit;
          }
          // 任一不一致 → priorWorkDir 保持 null,Runner 走 fresh worktree
        }
        // C · prior 锚点不全(任一 null 或 base_commit 非 40 位)→ 历史 v1 兼容,不下发 prior_work_dir
      }
    }

    // 原子认领:同一 UPDATE 同时写 status 与继承的三个锚点(全部继承时才会写)
    const setInherit = inheritTaskBranch != null
      ? `, task_branch=?, target_branch=?, base_commit=?`
      : "";
    const updateParams: any[] = [runtime.id, sha256Hex(taskToken), lease, now];
    if (inheritTaskBranch != null) {
      updateParams.push(inheritTaskBranch, inheritTargetBranch, inheritBaseCommit);
    }
    updateParams.push(cand.id);
    const res = db.$client
      .prepare(`UPDATE tasks SET status='dispatched', runtime_id=?, task_token_hash=?, lease_expires_at=?, dispatched_at=?${setInherit}
                WHERE id=? AND status='queued'`)
      .run(...updateParams);
    if (res.changes !== 1) continue; // 被别人抢先
    db.$client.prepare(`UPDATE agents SET status='working' WHERE id = ?`).run(cand.agent_id);

    // 重新读取以反映继承后的真实状态(anchors 已落库)
    const task = getTask(db, cand.id)!;
    const issue = frozenIssue;
    // issue 最近 10 条评论随任务包下发（组 prompt 用）；rowid 作 created_at 同毫秒的决胜序，返回反转为时间正序
    const comments = (db.$client
      .prepare(`SELECT author_type, body, created_at FROM comments WHERE issue_id = ?
                ORDER BY created_at DESC, rowid DESC LIMIT 10`)
      .all(cand.issue_id) as TaskComment[]).reverse();
    out.push({ task, issue, prior_work_dir: priorWorkDir, task_token: taskToken, comments });
  }
  return out;
}

/** 失败落库 + 有限重试:attempt 未满则派生子任务重新入队。
 *  A03-FIX:此函数仅由 sweepExpiredLeases / 老路径在 transaction 内部调用,不直接被 route 调用。
 *  route 的 fail 走 failTaskForDaemon(独立 transaction + 状态守卫 + 幂等回执)。 */
export function failTaskInternal(db: Db, taskId: string, reason: string, error: string, workDir: string | null) {
  const task = getTask(db, taskId);
  if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;
  const now = new Date().toISOString();
  db.$client.transaction(() => {
    db.$client
      .prepare(`UPDATE tasks SET status='failed', failure_reason=?, error=?, completed_at=?, work_dir=COALESCE(?, work_dir),
                task_token_hash=NULL, lease_expires_at=NULL WHERE id=?`)
      .run(reason, error, now, workDir, taskId);
    syncAgentIdle(db, task.agent_id);
    if (task.attempt >= task.max_attempts) return;
    const pending = db.$client
      .prepare(`SELECT id FROM tasks WHERE issue_id = ? AND status IN ('queued','dispatched') LIMIT 1`)
      .get(task.issue_id);
    if (pending) return;
    db.$client
      .prepare(`INSERT INTO tasks
                (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts,
                 parent_task_id, delivery_contract_version, task_branch, target_branch, base_commit,
                 repository_id,repository_snapshot_json,source_snapshot_id,created_at)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId(), task.workspace_id, task.issue_id, task.agent_id,
           task.priority, task.attempt + 1, task.max_attempts,
           task.id, DELIVERY_CONTRACT_CURRENT_VERSION,
           // A04-FIX1 · D:自动重试在父 Task 三锚点齐全时,继承 task_branch;
           // 不得覆盖已有的不一致锚点,也不得继承 head_commit / verification_* /
           // 任何 payload hash / response_json 等完成证据。
           // T01 绑定任务只保留原输入并 fresh；上述锚点继承限于旧未绑定任务。
           task.repository_id ? null : task.task_branch, task.repository_id ? null : task.target_branch, task.repository_id ? null : task.base_commit,
           task.repository_id ?? null, task.repository_snapshot_json ?? null, task.source_snapshot_id ?? null, now);
    addComment(db, task.issue_id, {
      author_type: "system", author_id: "system", type: "system",
      body: `任务失败(${reason}),自动重试 ${task.attempt + 1}/${task.max_attempts}${task.repository_id ? "；保留原始输入并使用新工作树，避免继承失效基线" : ""}`,
    });
  })();
}

export function startTask(db: Db, taskId: string, workDir: string): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='running', started_at=?, work_dir=? WHERE id=? AND status='dispatched'`)
    .run(now, workDir, taskId);
  return res.changes === 1;
}

export function completeTask(db: Db, taskId: string, result: { branch?: string; diff_stat?: string; work_dir?: string; session_id?: string }): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='completed', result_json=?, completed_at=?,
              work_dir=COALESCE(?, work_dir), session_id=COALESCE(?, session_id),
              task_token_hash=NULL, lease_expires_at=NULL
              WHERE id=? AND status IN ('dispatched','running')`)
    .run(JSON.stringify(result), now, result.work_dir ?? null, result.session_id ?? null, taskId);
  if (res.changes === 1) {
    const task = getTask(db, taskId);
    if (task) syncAgentIdle(db, task.agent_id);
  }
  return res.changes === 1;
}

/**
 * 状态自动流转(在 startTask/completeTask 成功后调用):
 * start 且 issue 为 todo → in_progress；complete 且有 branch 时，v1 可推进 in_review，
 * v2 还要求 Report/delivered_at、完整 Git 锚点和终检记录。验证失败仍可进入人工审查。
 * blocked/done 等状态不动(blocked 是人工挂起,不抢)。返回迁移后的 issue,未迁移返回 null(供路由层广播)。
 * 不写 delivered_at：v1 由 issue-status 回调写入，v2 由 Delivery Report 写入。
 */
export function autoAdvanceIssue(db: Db, task: Task, event: "start" | "complete"): Issue | null {
  const issue = getIssue(db, task.issue_id);
  if (!issue) return null;
  let next: string | null = null;
  if (event === "start" && issue.status === "todo") {
    next = "in_progress";
  } else if (event === "complete" && (issue.status === "todo" || issue.status === "in_progress")) {
    let branch: unknown;
    try { branch = JSON.parse(task.result_json ?? "{}")?.branch; } catch { branch = null; }
    const delivered = task.delivery_contract_version !== 2 || Boolean(
      task.delivered_at && task.task_branch && task.target_branch && task.base_commit && task.head_commit && task.verification_run_id && getDeliveryReport(db, task.id),
    );
    if (delivered && typeof branch === "string" && branch.trim()) next = "in_review";
  }
  if (!next) return null;
  const now = new Date().toISOString();
  db.$client.prepare(`UPDATE issues SET status=?, updated_at=? WHERE id=?`).run(next, now, issue.id);
  addComment(db, issue.id, {
    author_type: "system", author_id: "system", type: "status_change",
    body: event === "start" ? `${issue.status} → ${next}（开始执行）` : `${issue.status} → ${next}（产出待验收）`,
  });
  return getIssue(db, issue.id);
}

/** 租约清扫:dispatched 且租约过期 → attempt+1 回 queued,token 作废;attempt 已满 → failed/lease_expired,不再重派(防无限重派)。
 *  返回实际处理的任务 id(供调用方广播);涉及 agent 无其他活跃任务时置回 idle(daemon 死亡场景防卡 working)。 */
export function sweepExpiredLeases(db: Db, nowIso: string): string[] {
  const expired = db.$client
    .prepare(`SELECT id, agent_id, attempt, max_attempts FROM tasks WHERE status='dispatched' AND lease_expires_at < ?`)
    .all(nowIso) as any[];
  const swept: string[] = [];
  const agentIds = new Set<string>();
  for (const t of expired) {
    if (t.attempt >= t.max_attempts) {
      const changes = db.$client
        .prepare(`UPDATE tasks SET status='failed', failure_reason='lease_expired', error='lease expired, max attempts reached',
                  completed_at=?, runtime_id=NULL, task_token_hash=NULL, lease_expires_at=NULL, dispatched_at=NULL
                  WHERE id=? AND status='dispatched'`)
        .run(nowIso, t.id).changes;
      if (changes === 1) { swept.push(t.id); agentIds.add(t.agent_id); }
    } else {
      const changes = db.$client
        .prepare(`UPDATE tasks SET status='queued', attempt=attempt+1, runtime_id=NULL, task_token_hash=NULL,
                  lease_expires_at=NULL, dispatched_at=NULL
                  WHERE id=? AND status='dispatched'`)
        .run(t.id).changes;
      if (changes === 1) { swept.push(t.id); agentIds.add(t.agent_id); }
    }
  }
  for (const agentId of agentIds) syncAgentIdle(db, agentId);
  return swept;
}

/** 看板取消:置 cancelled + failure_reason=cancelled_by_user。保留 token 让 runner 轮询能读到终态。 */
export function cancelTask(db: Db, taskId: string): boolean {
  const now = new Date().toISOString();
  const res = db.$client
    .prepare(`UPDATE tasks SET status='cancelled', failure_reason='cancelled_by_user', completed_at=?, lease_expires_at=NULL
              WHERE id=? AND status IN ('queued','dispatched','running')`)
    .run(now, taskId);
  if (res.changes === 1) {
    const task = getTask(db, taskId);
    if (task) syncAgentIdle(db, task.agent_id);
  }
  return res.changes === 1;
}

/** Agent 回调推进 issue 状态(spec §6:平台不替 Agent 做决定,只提供端点)。
 *  A05 · v2 issue-status 分流:
 *   - v2 in_review → 409 runner_evidence_required(零副作用,delivered_at 不写,评论不增)
 *   - v2 done      → 409 human_decision_required(零副作用)
 *   - v2 blocked   → 200,issue 进入 blocked,delivered_at 保持 null
 *   - v1 行为保持:三个 status 都允许,都写 delivered_at
 *  本函数仍然返回 `{ok, error?}` 旧契约;v2 拒绝时通过 `code` 字段返回稳定机器码,
 *  由 daemon 路由映射 HTTP 状态码。 */
export function setIssueStatusFromAgent(db: Db, taskId: string, status: string, note?: string): { ok: boolean; error?: string; code?: string; http?: number } {
  if (!["in_review", "done", "blocked"].includes(status)) return { ok: false, error: "status must be in_review | done | blocked" };
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "task not found" };
  if (task.status !== "dispatched" && task.status !== "running") return { ok: false, error: "task not active" };
  // A05 · v2 issue-status 分流:active v2 Task 拒绝 in_review / done,blocked 保留逃生路径。
  if (task.delivery_contract_version === 2) {
    if (status === "in_review") {
      return {
        ok: false,
        error: "v2 Task 必须先通过 Delivery Report 路径表达交付,不能直接 issue-status=in_review",
        code: "runner_evidence_required",
        http: 409,
      };
    }
    if (status === "done") {
      return {
        ok: false,
        error: "Issue.done 只由人类批准合入产生,v2 Agent 不能直接把 Issue 标为 done",
        code: "human_decision_required",
        http: 409,
      };
    }
    // blocked 保留:允许 v2 走逃生路径,但绝不写 delivered_at
    const issue = getIssue(db, task.issue_id);
    if (!issue) return { ok: false, error: "issue not found" };
    const now = new Date().toISOString();
    db.$client.prepare(`UPDATE issues SET status=?, updated_at=? WHERE id=?`).run(status, now, issue.id);
    // 故意不 UPDATE tasks.delivered_at:v2 blocked 不代表交付
    addComment(db, issue.id, {
      author_type: "agent", author_id: task.agent_id, type: "status_change",
      body: note ? `${issue.status} → ${status}：${note}` : `${issue.status} → ${status}`,
    });
    return { ok: true };
  }
  // v1 行为保持(三条都允许,都写 delivered_at)
  const issue = getIssue(db, task.issue_id);
  if (!issue) return { ok: false, error: "issue not found" };
  const now = new Date().toISOString();
  db.$client.prepare(`UPDATE issues SET status=?, updated_at=? WHERE id=?`).run(status, now, issue.id);
  db.$client.prepare(`UPDATE tasks SET delivered_at=? WHERE id=?`).run(now, taskId);
  addComment(db, issue.id, {
    author_type: "agent", author_id: task.agent_id, type: "status_change",
    body: note ? `${issue.status} → ${status}：${note}` : `${issue.status} → ${status}`,
  });
  return { ok: true };
}

// ----------------------------------------------------------------------------
// A03 · daemon plane: start / complete / fail 的所有权 + 幂等 + 副作用包装
//
// A03-FIX:每个 operation 都在同一个 SQLite transaction 中:
//   1. 读 Task(状态守卫)
//   2. 状态更新 / 副作用
//   3. 写 hash + response
//   commit 后 route 再 broadcast 与 autoAdvanceIssue。
// replay:命中相同 hash 直接返回,无任何 transaction 与副作用。
// 不同 hash:抛 idempotency_conflict(409)。
// fail 的状态合法性:active 状态才接受;completed/failed/cancelled 且无相同 fail hash → 抛 invalid_transition(409)。
// ----------------------------------------------------------------------------

export interface DaemonOpResult<T> {
  response: T;
  task: Task;
  /** true = 命中 D-003 幂等键,所有副作用已在首次执行过,route 不要再 broadcast / autoAdvance。 */
  replayed: boolean;
  /** complete 在事务内调了 autoAdvanceIssue,route 用这个发 issue.updated 广播。
   *  start / fail 不修改 Issue 状态,固定为 null。 */
  advancedIssue?: Issue | null;
}

/** R1-FIX1 · 事务体内部结果(不含 `task`,由外层包装后填)。
 *  这是把"事务内 replayed 透传"逻辑独立成可测试单元后的契约;
 *  外层 startTaskForDaemon / completeTaskForDaemon / failTaskForDaemon 负责
 *  把 outcome 转成 DaemonOpResult(填 task 字段)。 */
export interface DaemonOpTxResult<T> {
  response: T;
  replayed: boolean;
  advancedIssue: Issue | null;
}

interface DaemonOpError extends Error {
  code: AnvilErrorCode;
  http: number;
  details?: Record<string, unknown>;
}

function makeOpError(http: number, code: AnvilErrorCode, message: string, details?: Record<string, unknown>): DaemonOpError {
  const e = new Error(message) as DaemonOpError;
  e.code = code;
  e.http = http;
  e.details = details;
  return e;
}

/** A03-FIX · start 包装:daemon token + ownership + 事务 + 幂等 + 副作用。
 *  接受完整 v2 锚点(task_branch/target_branch/base_commit/delivery_contract_version),
 *  携带时落库并参与 hash;未携带时为兼容路径(老 Runner 仍可用)。 */
export function startTaskForDaemon(
  db: Db, taskId: string, workspaceId: string, daemonId: string,
  payload: {
    daemon_id: string; work_dir: string;
    task_branch?: string | null; target_branch?: string | null;
    base_commit?: string | null; delivery_contract_version?: number | null;
  },
): DaemonOpResult<{ ok: true; task_id: string; status: "running" }> {
  // A03-FIX · 校验前先看 task 是否存在(在 transaction 外报 404)
  const initial = getTask(db, taskId);
  if (!initial) throw makeOpError(404, "task_not_active", "Task 不存在", { task_id: taskId });
  assertRuntimeOwnership(db, initial, workspaceId, daemonId);
  // A03-FIX · v2 锚点校验(兼容 / 完整 v2 模式);返回结构化错误
  const anchorCheck = validateStartAnchors(initial, payload);
  if (!anchorCheck.ok) {
    throw makeOpError(anchorCheck.http, anchorCheck.code, anchorCheck.message, anchorCheck.details);
  }
  const hash = canonicalJsonHash(normalizeOpPayload("start", payload));
  // 事务前先读一次幂等键,只用于"从未写过任何 start 哈希"的快速失败;
  // 事务内会重新读以防 TOCTOU。
  const preExisting = readOpIdempotency(db, taskId, "start");
  if (preExisting.hash && preExisting.response) {
    if (preExisting.hash === hash) {
      return { response: JSON.parse(preExisting.response), task: initial, replayed: true, advancedIssue: null };
    }
    throw makeOpError(409, "idempotency_conflict", "start 操作已有不同 payload 的同 operation 记录", { task_id: taskId });
  }
  // R1-FIX1:start 事务内幂等 recheck + 业务写入。返回带 replayed 标志的结果,
  // 事务内 recheck 命中时必须把 replayed=true 透传出去,避免外层硬编码 false 重复广播。
  const outcome = runStartInTransaction(db, taskId, hash, payload);
  return {
    response: outcome.response,
    task: getTask(db, taskId)!,
    replayed: outcome.replayed,
    advancedIssue: outcome.advancedIssue,
  };
}

/** R1-FIX1 · start 事务体(可独立测试)。
 *  内部不持有"事务前 fast path"逻辑;调用方负责先读一次 idempotency,
 *  本函数负责事务内 recheck + 业务写入。recheck 命中时返回 `replayed: true`,
 *  不执行任何状态修改 / 评论 / 广播触发副作用。 */
export function runStartInTransaction(
  db: Db, taskId: string, hash: string,
  payload: {
    daemon_id: string; work_dir: string;
    task_branch?: string | null; target_branch?: string | null;
    base_commit?: string | null; delivery_contract_version?: number | null;
  },
): DaemonOpTxResult<{ ok: true; task_id: string; status: "running" }> {
  const outcome: {
    response: { ok: true; task_id: string; status: "running" };
    replayed: boolean;
    advancedIssue: Issue | null;
  } = { response: { ok: true, task_id: taskId, status: "running" }, replayed: false, advancedIssue: null };
  const now = new Date().toISOString();
  // 同一 transaction:recheck → 状态守卫 → 锚点落库 → autoAdvanceIssue + 系统评论 → 幂等写入。
  // 任一异常都会让 better-sqlite3 自动 ROLLBACK,不留半完成状态。
  db.$client.transaction(() => {
    const idem = readOpIdempotency(db, taskId, "start");
    if (idem.hash && idem.response) {
      if (idem.hash === hash) {
        outcome.response = JSON.parse(idem.response);
        outcome.replayed = true;
        outcome.advancedIssue = null;
        return;
      }
      throw makeOpError(409, "idempotency_conflict", "start 操作已有不同 payload 的同 operation 记录", { task_id: taskId });
    }
    const cur = db.$client.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!cur) throw makeOpError(404, "task_not_active", "Task 不存在", { task_id: taskId });
    if (cur.status !== "dispatched") {
      throw makeOpError(409, "invalid_transition", "Task 不在 dispatched 状态,无法 start", { task_id: taskId, status: cur.status });
    }
    // 兼容模式:锚点全 null,不动 task_branch / target_branch / base_commit / delivery_contract_version;
    // 完整 v2 模式:全部显式写入,即使 COALESCE 也不会触发(因为已校验非空)。
    const setBranches = payload.task_branch != null
      ? `, task_branch=?, target_branch=?, base_commit=?, delivery_contract_version=?`
      : "";
    const params: any[] = [now, payload.work_dir];
    if (payload.task_branch != null) {
      params.push(payload.task_branch, payload.target_branch, payload.base_commit, payload.delivery_contract_version);
    }
    params.push(taskId);
    const res = db.$client
      .prepare(`UPDATE tasks SET status='running', started_at=?, work_dir=?${setBranches}
                WHERE id=? AND status='dispatched'`)
      .run(...params);
    if (res.changes !== 1) {
      throw makeOpError(409, "invalid_transition", "Task 状态被并发改动,无法 start", { task_id: taskId });
    }
    // autoAdvanceIssue + 系统评论同 transaction:start 落库成功 → Issue 推进 → 评论写入
    // 必须在写 hash 之前,这样 start 失败时整条 transaction 一起回滚,不留半完成副作用
    const advanced = autoAdvanceIssue(db, getTask(db, taskId)!, "start");
    const response: { ok: true; task_id: string; status: "running" } = { ok: true, task_id: taskId, status: "running" };
    writeOpIdempotency(db, taskId, "start", hash, JSON.stringify(response));
    outcome.response = response;
    outcome.advancedIssue = advanced;
    outcome.replayed = false;
  })();
  return outcome;
}

// 复用 Core 回执；v1 兼容路径不返回 Packet 状态。
type CompleteOpResponse = Omit<V2CompleteResponse, "review_packet_status"> & Partial<Pick<V2CompleteResponse, "review_packet_status">>;

/** A03-FIX · complete 包装:状态守卫 + 事务 + 幂等 + 副作用(syncAgentIdle,Issue 状态与评论)。
 *  replay 命中则不重复任何副作用;不同 hash 抛 idempotency_conflict。 */
export function completeTaskForDaemon(
  db: Db, taskId: string, workspaceId: string, daemonId: string,
  payload: Record<string, unknown>,
): DaemonOpResult<CompleteOpResponse> {
  const initial = getTask(db, taskId);
  if (!initial) throw makeOpError(404, "task_not_active", "Task 不存在", { task_id: taskId });
  assertRuntimeOwnership(db, initial, workspaceId, daemonId);
  // A03-FIX4 · hash 与 result_json 派生自同一规范化对象
  // (normalizeOpPayload("complete") 与 buildCompleteResultJson 字段集合完全一致)
  const hash = canonicalJsonHash(normalizeOpPayload("complete", payload));
  // 事务前 fast path:命中同 hash 直接返回,跨进程 atomic 由事务内重读保证
  const preExisting = readOpIdempotency(db, taskId, "complete");
  if (preExisting.hash && preExisting.response) {
    if (preExisting.hash === hash) {
      return { response: JSON.parse(preExisting.response), task: initial, replayed: true, advancedIssue: null };
    }
    throw makeOpError(409, "idempotency_conflict", "complete 操作已有不同 payload 的同 operation 记录", { task_id: taskId });
  }
  // R1-FIX1:事务内 recheck + 业务写入。recheck 命中时返回 replayed=true。
  const tx = runCompleteInTransaction(db, taskId, hash, payload);
  return {
    response: tx.response,
    task: getTask(db, taskId)!,
    replayed: tx.replayed,
    advancedIssue: tx.advancedIssue,
  };
}

/** R1-FIX1 · complete 事务体(可独立测试)。 */
export function runCompleteInTransaction(
  db: Db, taskId: string, hash: string, payload: Record<string, unknown>,
): DaemonOpTxResult<CompleteOpResponse> {
  const outcome: {
    response: CompleteOpResponse;
    replayed: boolean;
    advancedIssue: Issue | null;
  } = { response: { ok: true, task_id: taskId, status: "completed" }, replayed: false, advancedIssue: null };
  const now = new Date().toISOString();
  // 先构造与 hash 一致的客户端业务快照；事务内追加的服务端派生字段不参与请求 hash。
  const businessResult = buildCompleteResultJson(payload);
  const body = businessResult as { branch?: string; diff_stat?: string; work_dir?: string; session_id?: string; head_commit?: string; base_commit?: string; worktree_clean?: boolean; verification?: unknown; pushed?: boolean; undelivered?: boolean };
  // 同一 transaction:recheck → 状态守卫 → 证据校验/写入 → 终态 → Agent/Issue/评论 → 幂等回执。
  // 任一异常触发 ROLLBACK,不留半完成证据。
  db.$client.transaction(() => {
    // 事务内重新读幂等记录(防 TOCTOU 与并发竞争)
    const idem = readOpIdempotency(db, taskId, "complete");
    if (idem.hash && idem.response) {
      if (idem.hash === hash) {
        outcome.response = JSON.parse(idem.response);
        outcome.replayed = true;
        outcome.advancedIssue = null;
        return;
      }
      throw makeOpError(409, "idempotency_conflict", "complete 操作已有不同 payload 的同 operation 记录", { task_id: taskId });
    }
    const cur = db.$client.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!cur) throw makeOpError(404, "task_not_active", "Task 不存在", { task_id: taskId });
    if (cur.status !== "dispatched" && cur.status !== "running") {
      throw makeOpError(409, "invalid_transition", "Task 不在 active 状态,无法 complete", { task_id: taskId, status: cur.status });
    }
    // 先校验原始字节上限，再校验脱敏后的存储对象；不能截断后静默接受结构化载荷。
    validateCompleteEvidence(cur, payload);
    const verification = validateCompleteEvidence(cur, businessResult);
    let runId: string | null = null;
    if (cur.delivery_contract_version === 2) {
      if (verification) runId = persistVerification(db, cur, verification, now);
      businessResult.schema_version = 2;
      businessResult.verification_run_id = runId;
      businessResult.review_packet_status = deriveCompletedPacketStatus({ ...cur, head_commit: body.head_commit ?? null, worktree_clean: body.worktree_clean ?? null }, getDeliveryReport(db, taskId)?.report_head_commit ?? null, verification);
    }
    const evidenceSet = cur.delivery_contract_version === 2 ? ", head_commit=?, worktree_clean=?, verification_status=?, verification_run_id=?" : "";
    const params: unknown[] = [JSON.stringify(businessResult), now, body.work_dir ?? null, body.session_id ?? null];
    if (cur.delivery_contract_version === 2) params.push(body.head_commit ?? null, typeof body.worktree_clean === "boolean" ? Number(body.worktree_clean) : null, verification?.status ?? null, runId);
    params.push(taskId);
    const res = db.$client
      .prepare(`UPDATE tasks SET status='completed', result_json=?, completed_at=?,
                work_dir=COALESCE(?, work_dir), session_id=COALESCE(?, session_id),
                task_token_hash=NULL, lease_expires_at=NULL${evidenceSet}
                WHERE id=? AND status IN ('dispatched','running')`)
      .run(...params);
    if (res.changes !== 1) {
      throw makeOpError(409, "invalid_transition", "Task 状态被并发改动,无法 complete", { task_id: taskId });
    }
    syncAgentIdle(db, cur.agent_id);
    // Issue 自动流转 + 系统评论(同 transaction)
    const advanced = autoAdvanceIssue(db, getTask(db, taskId)!, "complete");
    const response: CompleteOpResponse = { ok: true, task_id: taskId, status: "completed", ...(cur.delivery_contract_version === 2 ? { review_packet_status: businessResult.review_packet_status as ReviewPacketStatus } : {}) };
    writeOpIdempotency(db, taskId, "complete", hash, JSON.stringify(response));
    outcome.response = response;
    outcome.advancedIssue = advanced;
    outcome.replayed = false;
  })();
  return outcome;
}


/** A03-FIX · fail 包装:状态守卫 + 事务 + 幂等 + 副作用(failTaskInternal 在事务内,保证整体回滚)。
 *  replay 命中 → 不重复副作用;不同 hash → 409;非 active 状态且无相同 fail hash → 409 invalid_transition。
 *  关键:complete 与 fail 竞争时只能有一个成功,因为状态守卫用带条件的 UPDATE + changes===1 判断,
 *  先到的赢,后到的抛 invalid_transition。 */
export function failTaskForDaemon(
  db: Db, taskId: string, workspaceId: string, daemonId: string,
  payload: { daemon_id: string; failure_reason: string; error: string; work_dir?: string | null },
): DaemonOpResult<{ ok: true; task_id: string; status: "failed" }> {
  const initial = getTask(db, taskId);
  if (!initial) throw makeOpError(404, "task_not_active", "Task 不存在", { task_id: taskId });
  assertRuntimeOwnership(db, initial, workspaceId, daemonId);
  // A03-FIX4 · fail payload hash 基于已脱敏 error。同一对象既参与 hash,也用于 tasks.error 落库。
  // 这保证 hash 与持久化对象一致,且原始 token 不进入 hash 也不进入数据库。
  const hash = canonicalJsonHash(normalizeOpPayload("fail", payload));
  // 事务前 fast path
  const preExisting = readOpIdempotency(db, taskId, "fail");
  if (preExisting.hash && preExisting.response) {
    if (preExisting.hash === hash) {
      return { response: JSON.parse(preExisting.response), task: initial, replayed: true, advancedIssue: null };
    }
    throw makeOpError(409, "idempotency_conflict", "fail 操作已有不同 payload 的同 operation 记录", { task_id: taskId });
  }
  // R1-FIX1:事务内 recheck + 业务写入。recheck 命中时返回 replayed=true。
  const tx = runFailInTransaction(db, taskId, hash, payload);
  return {
    response: tx.response,
    task: getTask(db, taskId)!,
    replayed: tx.replayed,
    advancedIssue: tx.advancedIssue,
  };
}

/** R1-FIX1 · fail 事务体(可独立测试)。 */
export function runFailInTransaction(
  db: Db, taskId: string, hash: string,
  payload: { daemon_id: string; failure_reason: string; error: string; work_dir?: string | null },
): DaemonOpTxResult<{ ok: true; task_id: string; status: "failed" }> {
  const outcome: {
    response: { ok: true; task_id: string; status: "failed" };
    replayed: boolean;
    advancedIssue: Issue | null;
  } = { response: { ok: true, task_id: taskId, status: "failed" }, replayed: false, advancedIssue: null };
  const now = new Date().toISOString();
  // A03-FIX4 · 持久化字段(error 已脱敏、failure_reason 原样、work_dir 原样)
  const persisted = buildFailPersistedFields(payload);
  // 同一 transaction:recheck → 状态守卫 → 终态更新 → 重试子任务 + Agent 同步 + 评论 → 幂等写入。
  // 任一异常触发 ROLLBACK,不留半完成副作用。
  db.$client.transaction(() => {
    // 事务内重新读幂等(防 TOCTOU 与并发竞争)
    const idem = readOpIdempotency(db, taskId, "fail");
    if (idem.hash && idem.response) {
      if (idem.hash === hash) {
        outcome.response = JSON.parse(idem.response);
        outcome.replayed = true;
        outcome.advancedIssue = null;
        return;
      }
      throw makeOpError(409, "idempotency_conflict", "fail 操作已有不同 payload 的同 operation 记录", { task_id: taskId });
    }
    const cur = db.$client.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as any;
    if (!cur) throw makeOpError(404, "task_not_active", "Task 不存在", { task_id: taskId });
    if (cur.status !== "dispatched" && cur.status !== "running") {
      throw makeOpError(409, "invalid_transition", "Task 不在 active 状态,无法 fail", { task_id: taskId, status: cur.status });
    }
    const upd = db.$client
      .prepare(`UPDATE tasks SET status='failed', failure_reason=?, error=?, completed_at=?, work_dir=COALESCE(?, work_dir),
                task_token_hash=NULL, lease_expires_at=NULL
                WHERE id=? AND status IN ('dispatched','running')`)
      .run(persisted.failure_reason, persisted.error, now, persisted.work_dir, taskId);
    if (upd.changes !== 1) {
      throw makeOpError(409, "invalid_transition", "Task 状态被并发改动,无法 fail", { task_id: taskId });
    }
    syncAgentIdle(db, cur.agent_id);
    if (cur.attempt < cur.max_attempts) {
      const pending = db.$client
        .prepare(`SELECT id FROM tasks WHERE issue_id = ? AND status IN ('queued','dispatched') LIMIT 1`)
        .get(cur.issue_id);
      if (!pending) {
        db.$client
          .prepare(`INSERT INTO tasks
                    (id, workspace_id, issue_id, agent_id, status, priority, attempt, max_attempts,
                     parent_task_id, delivery_contract_version, task_branch, target_branch, base_commit,
                     repository_id,repository_snapshot_json,source_snapshot_id,created_at)
                    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newId(), cur.workspace_id, cur.issue_id, cur.agent_id,
               cur.priority, cur.attempt + 1, cur.max_attempts,
               cur.id, DELIVERY_CONTRACT_CURRENT_VERSION,
               // A04-FIX1 · D:自动重试在父 Task 三锚点齐全时,继承 task_branch;
               // 不得继承 head_commit / verification_* / 任何 hash / response_json。
               // T01 绑定任务只保留原输入并 fresh；上述锚点继承限于旧未绑定任务。
               cur.repository_id ? null : cur.task_branch, cur.repository_id ? null : cur.target_branch, cur.repository_id ? null : cur.base_commit,
               cur.repository_id ?? null, cur.repository_snapshot_json ?? null, cur.source_snapshot_id ?? null, now);
        addComment(db, cur.issue_id, {
          author_type: "system", author_id: "system", type: "system",
          body: `任务失败(${persisted.failure_reason}),自动重试 ${cur.attempt + 1}/${cur.max_attempts}${cur.repository_id ? "；保留原始输入并使用新工作树，避免继承失效基线" : ""}`,
        });
      }
    }
    const response: { ok: true; task_id: string; status: "failed" } = { ok: true, task_id: taskId, status: "failed" };
    writeOpIdempotency(db, taskId, "fail", hash, JSON.stringify(response));
    outcome.response = response;
    outcome.replayed = false;
  })();
  return outcome;
}
