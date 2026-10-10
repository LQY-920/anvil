// apps/server/src/services/delivery.ts
//
// A05 · Delivery Report 服务；A07 · complete 验证证据校验、持久化与快照状态
//
// 契约边界:
//  - 协议类型与校验纯函数(validateDeliveryReport / normalizeReportForHash /
//    reportHash / compareThreeShas)只来自 @anvil/core/delivery;
//    本文件不复制任何 validator 或 hash 算法。
//  - 持久化路径:task_delivery_reports(单行,主键 task_id)+ tasks.delivered_at。
//    两者在同一 SQLite transaction 中写入,任一失败一起回滚。
//  - 首次提交写 delivered_at;相同规范化内容提交视为 replay,行/时间戳/评论
//    全部不动;active Task 提交不同内容则更新同一行,delivered_at 保持首次。
//  - 终态 Task 一律 409 task_not_active,零写入。
//  - v1 Task 提交 Delivery Report 一律 409 invalid_transition,零写入。
//
// 错误码(本地稳定字符串):
//  - task_not_active:终态 Task 提交或 v1 Task 提交 Report
//  - invalid_transition:状态/版本不匹配(与现有 daemon 路由同语义)
//  - payload_too_large / invalid_schema:来自 core 校验层
//  - runner_evidence_required / human_decision_required:v2 issue-status
//    in_review / done 拒绝(本服务用,但 issue-status 在 tasks.ts 内实现)

import crypto from "node:crypto";
import { newId, type Db } from "../db/client.js";
import {
  DELIVERY_CONTRACT_CURRENT_VERSION,
  type DeliveryReportReceipt,
  type DeliveryReportReplay,
  type DeliveryQueryResponse,
  type ValidatedDeliveryReport,
  validateDeliveryReport,
  normalizeReportForHash,
  LIMITS, VERIFICATION_STATUSES, VERIFICATION_CHECK_STATUSES, deriveVerificationStatus,
  type Task, type VerificationRun, type ReviewPacketStatus, type AnvilErrorCode,
} from "@anvil/core";
import { redactTokens } from "./tasks.js";

function evidenceError(message: string, code: AnvilErrorCode = "invalid_verification", http = 400): never {
  throw Object.assign(new Error(message), { code, http });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const iso = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) evidenceError("验证证据包含未知字段", "invalid_schema");
}

/** hash 与 result_json 都使用这个副本，不把未脱敏的输出写进任一快照。 */
export function redactVerification(value: unknown): unknown {
  if (!object(value)) return value;
  return { ...value, ...(Array.isArray(value.checks) ? { checks: value.checks.map(c => {
    if (!object(c)) return c;
    const copy = { ...c };
    for (const key of ["id", "label", "command", "output_excerpt"]) if (typeof copy[key] === "string") copy[key] = redactTokens(copy[key]);
    return copy;
  }) } : {}) };
}

/** 接口结构校验与事实派生分开；未知版本/字段拒绝，不从不完整数据猜测 passed。 */
export function validateCompleteEvidence(task: Task, body: Record<string, unknown>): VerificationRun | null {
  if (task.delivery_contract_version !== 2) return null;
  const anchors = [task.task_branch, task.target_branch, task.base_commit];
  if (anchors.every(v => v == null)) {
    // 无 Git 的普通目录任务保留完成能力，不制造 Git 或验证事实。
    if ([body.branch, body.base_commit, body.head_commit, body.worktree_clean, body.verification].some(v => v != null)) evidenceError("任务没有 start Git 锚点，不能提交 Git 证据");
    return null;
  }
  if (!anchors.every(v => typeof v === "string" && v.length > 0)) evidenceError("start Git 锚点不完整");
  if (!sha(body.base_commit) || typeof body.branch !== "string" || !body.branch.length || typeof body.work_dir !== "string" || !body.work_dir.length) evidenceError("complete 缺少基线、分支或工作目录");
  if (body.base_commit !== task.base_commit || body.branch !== task.task_branch || body.work_dir !== task.work_dir) evidenceError("complete 与 start 的基线、分支或工作目录不同", "base_mismatch", 409);
  if (!sha(body.head_commit) || typeof body.worktree_clean !== "boolean") evidenceError("complete 缺少完整 HEAD 或 clean 事实");
  const raw = body.verification;
  if (!object(raw)) evidenceError("complete 缺少验证证据");
  if (Buffer.byteLength(JSON.stringify(raw)) > LIMITS.VERIFICATION_TOTAL_BYTES) evidenceError("验证载荷超过 64KB", "payload_too_large");
  fields(raw, ["schema_version", "policy_source", "policy_hash", "verification_sha", "status", "started_at", "completed_at", "checks", "error_code"]);
  if (raw.schema_version !== 1 || raw.status === "legacy" || !(VERIFICATION_STATUSES as readonly unknown[]).includes(raw.status)) evidenceError("未知验证版本或状态", "invalid_schema");
  if (raw.policy_source !== "none" && raw.policy_source !== "ANVIL.verify.json") evidenceError("未知策略来源", "invalid_schema");
  if (raw.error_code !== undefined && raw.error_code !== "invalid_policy" && raw.error_code !== "verification_error") evidenceError("未知验证错误码", "invalid_schema");
  if (raw.policy_hash !== null && (typeof raw.policy_hash !== "string" || !/^[a-f0-9]{64}$/i.test(raw.policy_hash))) evidenceError("策略 hash 必须是 SHA-256 或 null");
  if (raw.verification_sha !== null && !sha(raw.verification_sha)) evidenceError("验证 SHA 必须是完整 SHA 或 null");
  if (!iso(raw.completed_at) || (raw.started_at !== null && !iso(raw.started_at))) evidenceError("验证时间必须是 ISO UTC 时间");
  if (raw.started_at && Date.parse(raw.completed_at) < Date.parse(raw.started_at as string)) evidenceError("验证完成时间早于开始时间");
  if (!Array.isArray(raw.checks) || raw.checks.length > LIMITS.VERIFICATION_COMMANDS) evidenceError("检查条数必须为 0–8");
  const ids = new Set<string>();
  for (const check of raw.checks) {
    if (!object(check)) evidenceError("检查必须是对象");
    fields(check, ["id", "label", "command", "required", "status", "exit_code", "duration_ms", "output_excerpt"]);
    if (typeof check.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(check.id) || ids.has(check.id)) evidenceError("检查 ID 非法或重复");
    ids.add(check.id);
    if (typeof check.label !== "string" || !check.label.length || typeof check.command !== "string" || !check.command.length || check.command.length > LIMITS.VERIFICATION_COMMAND_CHARS) evidenceError("检查文案或命令非法");
    if (typeof check.required !== "boolean" || !Number.isSafeInteger(check.duration_ms) || (check.duration_ms as number) < 0) evidenceError("required 或 duration_ms 非法");
    if (!(VERIFICATION_CHECK_STATUSES as readonly unknown[]).includes(check.status)) evidenceError("未知检查状态", "invalid_schema");
    if (check.exit_code !== null && !Number.isSafeInteger(check.exit_code)) evidenceError("退出码必须为整数或 null");
    if (typeof check.output_excerpt !== "string") evidenceError("输出必须是文本");
    if (Buffer.byteLength(check.output_excerpt) > LIMITS.CHECK_EXCERPT_BYTES) evidenceError("单条输出超过 8KB", "payload_too_large");
    if (check.status === "passed" && check.exit_code !== 0 || check.status === "failed" && check.exit_code === 0 || (check.status === "timed_out" || check.status === "skipped") && check.exit_code !== null) evidenceError("检查状态与退出码矛盾");
    if (check.status === "skipped" && (check.duration_ms !== 0 || check.output_excerpt !== "")) evidenceError("跳过的检查不能有执行证据");
  }
  const run = raw as unknown as VerificationRun;
  const checks = run.checks;
  if (checks.some(c => c.status !== "skipped") && (!run.started_at || !run.verification_sha || !run.policy_hash)) evidenceError("已执行检查缺少开始时间、验证 SHA 或策略 hash");
  if (run.error_code) {
    if (run.status !== "failed" || run.policy_source !== "ANVIL.verify.json") evidenceError("验证异常必须标为 failed");
    if (run.error_code === "invalid_policy" && (!run.policy_hash || checks.length || run.verification_sha !== null || run.started_at !== null)) evidenceError("非法策略不能带已执行检查");
  } else if (run.status === "not_configured") {
    // 空 commands 也属未配置，但原文件存在时保留其 hash。
    if (checks.length || run.started_at !== null || run.verification_sha !== null || (run.policy_source === "none" ? run.policy_hash !== null : !run.policy_hash)) evidenceError("未配置状态与策略事实矛盾");
  } else {
    if (run.policy_source !== "ANVIL.verify.json" || !run.policy_hash || !run.verification_sha || !checks.length) evidenceError("已验证状态缺少策略、SHA 或检查");
    if (run.started_at === null) {
      if (run.status !== "dirty" || body.worktree_clean !== false || checks.some(c => c.status !== "skipped")) evidenceError("未启动验证只能是 dirty 且全部跳过");
    } else {
      const derived = deriveVerificationStatus({ policyPresent: true, headUnchanged: run.verification_sha.toLowerCase() === (body.head_commit as string).toLowerCase(), worktreeClean: body.worktree_clean as boolean,
        checks: checks.map(c => ({ id: c.id, required: c.required, exit_code: c.exit_code, timed_out: c.status === "timed_out" })) });
      if (run.status !== derived) evidenceError("验证总状态与检查、SHA 或 clean 事实矛盾");
    }
  }
  return run;
}

/** 只由 complete 事务调用；Run、Checks 与 tasks.verification_run_id 一起提交。 */
export function persistVerification(db: Db, task: Task, run: VerificationRun, now: string): string {
  const id = newId();
  db.$client.prepare(`INSERT INTO verification_runs (id,task_id,schema_version,policy_source,policy_hash,base_commit,verification_sha,status,started_at,completed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, task.id, run.schema_version, run.policy_source, run.policy_hash, task.base_commit, run.verification_sha, run.status, run.started_at, run.completed_at, now);
  const insert = db.$client.prepare(`INSERT INTO verification_checks (id,verification_run_id,seq,check_id,label,command,required,status,exit_code,duration_ms,output_excerpt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  run.checks.forEach((c, seq) => insert.run(newId(), id, seq, c.id, c.label, c.command, c.required ? 1 : 0, c.status, c.exit_code, c.duration_ms, c.output_excerpt));
  return id;
}

/** 完成时的证据快照状态；B01 再叠加实时 Git 核验与人类 Decision。 */
export function deriveCompletedPacketStatus(task: Task, reportHead: string | null, run: VerificationRun | null): ReviewPacketStatus {
  if (task.delivery_contract_version !== 2) return "legacy";
  if (!task.delivered_at || !reportHead || !task.task_branch || !task.target_branch || !task.base_commit || !task.head_commit || !run) return "incomplete";
  if (reportHead.toLowerCase() !== task.head_commit.toLowerCase() || task.worktree_clean === false || run.status === "dirty" || run.status === "stale" || run.verification_sha && run.verification_sha.toLowerCase() !== task.head_commit.toLowerCase()) return "integrity_blocked";
  return run.status === "passed" ? "ready" : "verification_blocked";
}

/** A05 · Delivery Report 错误码(本服务本地稳定字符串,未进 @anvil/core)。 */
export const DELIVERY_ERROR_CODES = {
  TASK_NOT_ACTIVE: "task_not_active",
  INVALID_TRANSITION: "invalid_transition",
  RUNNER_EVIDENCE_REQUIRED: "runner_evidence_required",
  HUMAN_DECISION_REQUIRED: "human_decision_required",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  INVALID_SCHEMA: "invalid_schema",
} as const;

export type DeliveryErrorCode = (typeof DELIVERY_ERROR_CODES)[keyof typeof DELIVERY_ERROR_CODES];

/** 结构化错误,由 route 层捕获并返回 HTTP 响应。 */
export interface DeliveryError extends Error {
  code: DeliveryErrorCode;
  http: number;
  details?: Record<string, unknown>;
}

function makeDeliveryError(
  http: number,
  code: DeliveryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DeliveryError {
  const e = new Error(message) as DeliveryError;
  e.code = code;
  e.http = http;
  e.details = details;
  return e;
}

// ----------------------------------------------------------------------------
// 工具
// ----------------------------------------------------------------------------

/** 把任意字符串的 UTF-8 字节数算出来。
 *  Node.js 的 Buffer 在不指定 encoding 时按 UTF-8 计算多字节字符的字节长度。 */
export function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** 把已校验的 Report 递归脱敏所有字符串字段,返回新对象(不修改原对象)。
 *  包含顶层 problem_understanding / solution_summary / report_head_commit 与
 *  嵌套的 changed_areas[*].path / summary、risks[*].summary / mitigation、
 *  unresolved[*].description。 */
export function redactValidatedReport(report: ValidatedDeliveryReport): ValidatedDeliveryReport {
  return {
    schema_version: report.schema_version,
    report_head_commit: redactTokens(report.report_head_commit),
    problem_understanding: redactTokens(report.problem_understanding),
    solution_summary: redactTokens(report.solution_summary),
    changed_areas: report.changed_areas.map((c) => ({
      path: redactTokens(c.path),
      summary: redactTokens(c.summary),
    })),
    risks: report.risks.map((r) => ({
      level: r.level,
      summary: redactTokens(r.summary),
      mitigation: redactTokens(r.mitigation),
    })),
    unresolved: report.unresolved.map((u) => ({
      description: redactTokens(u.description),
    })),
  };
}

/** SHA-256 哈希归一化 Report,用于同内容 replay 检测。 */
function reportHashHex(report: ValidatedDeliveryReport): string {
  return crypto.createHash("sha256").update(normalizeReportForHash(report), "utf8").digest("hex");
}

// ----------------------------------------------------------------------------
// 读取已持久化 Report 行
// ----------------------------------------------------------------------------

interface PersistedReportRow {
  task_id: string;
  schema_version: number;
  report_head_commit: string;
  problem_understanding: string;
  solution_summary: string;
  changed_areas_json: string;
  risks_json: string;
  unresolved_json: string;
  submitted_at: string;
  updated_at: string;
}

export function getDeliveryReport(db: Db, taskId: string): PersistedReportRow | null {
  const row = db.$client
    .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
    .get(taskId) as PersistedReportRow | undefined;
  return row ?? null;
}

// ----------------------------------------------------------------------------
// 核心:提交 Delivery Report
// ----------------------------------------------------------------------------

export interface SubmitDeliveryReportResult {
  /** 响应体(receipt 或 replay)。 */
  response: DeliveryReportReceipt | DeliveryReportReplay;
  /** true = replay 命中(同规范化内容);false = 新写入或替换。 */
  replay: boolean;
}

/**
 * 提交 Delivery Report:
 *  1. 读 task,守卫 contract_version=2 且状态在 active 区间(dispatched/running);
 *     否则抛 409 task_not_active。
 *  2. 校验请求体(struct + 64KB UTF-8 字节限制),失败抛 400。
 *  3. 脱敏所有字符串字段(任务 token 同样从 payload 里抹掉,再算 hash 与落库)。
 *  4. 在事务内:读幂等哈希,首次写一行 + delivered_at,同 hash → replay 返回原
 *     submitted_at;不同内容 → 更新同一行(delivered_at 保持首次,submitted_at
 *     保持首次,updated_at 更新);任一 INSERT/UPDATE 失败回滚整条 transaction。
 *  5. 返回 receipt 或 replay。
 */
export function submitDeliveryReport(
  db: Db,
  taskId: string,
  body: unknown,
): SubmitDeliveryReportResult {
  // 1. 任务存在 + 状态守卫 + contract_version 守卫
  const taskRow = db.$client
    .prepare(`SELECT id, status, delivery_contract_version, delivered_at FROM tasks WHERE id = ?`)
    .get(taskId) as
    | { id: string; status: string; delivery_contract_version: number; delivered_at: string | null }
    | undefined;
  if (!taskRow) {
    throw makeDeliveryError(409, DELIVERY_ERROR_CODES.TASK_NOT_ACTIVE, "Task 不存在", { task_id: taskId });
  }
  if (taskRow.status !== "dispatched" && taskRow.status !== "running") {
    throw makeDeliveryError(409, DELIVERY_ERROR_CODES.TASK_NOT_ACTIVE, "Task 已终态,不可提交 Delivery Report", {
      task_id: taskId,
      status: taskRow.status,
    });
  }
  if (taskRow.delivery_contract_version !== 2) {
    // v1 Task 提交 Delivery Report 是 409 invalid_transition,
    // 不得让 v1 借助 Delivery Report 路径写入 delivered_at。
    throw makeDeliveryError(
      409,
      DELIVERY_ERROR_CODES.INVALID_TRANSITION,
      "v1 Task 不支持 Delivery Report,请走 issue-status 回调",
      { task_id: taskId, delivery_contract_version: taskRow.delivery_contract_version },
    );
  }

  // 2. 校验 body + UTF-8 字节数
  // core 的 validateDeliveryReport 已限制 64KB,但它用 bodyBytes 字段由调用方
  // 提供 UTF-8 真实字节数(不只算 JS 字符数)。我们用 Buffer 重算。
  const bodyBytes = utf8ByteLength(JSON.stringify(body ?? null));
  const v = validateDeliveryReport({ body, bodyBytes });
  if (!v.ok || !v.value) {
    // 第一个错误决定错误码
    const first = v.errors[0];
    if (!first) {
      throw makeDeliveryError(400, DELIVERY_ERROR_CODES.INVALID_SCHEMA, "Delivery Report 校验失败");
    }
    if (first.code === "report_too_large") {
      // 区分"整体请求体超过 64KB"和"数组数量超过上限":
      // 任务说明:超过 64KB → payload_too_large;其他结构错误 → invalid_schema。
      // core 的 report_too_large 同时用于两种情况,我们用 details.bytes 判定。
      if (first.details && typeof (first.details as { bytes?: unknown }).bytes === "number") {
        throw makeDeliveryError(
          400,
          DELIVERY_ERROR_CODES.PAYLOAD_TOO_LARGE,
          first.message,
          first.details,
        );
      }
      throw makeDeliveryError(
        400,
        DELIVERY_ERROR_CODES.INVALID_SCHEMA,
        first.message,
        first.details,
      );
    }
    throw makeDeliveryError(
      400,
      DELIVERY_ERROR_CODES.INVALID_SCHEMA,
      first.message,
      first.details,
    );
  }
  const validated: ValidatedDeliveryReport = v.value;

  // 3. 脱敏 + 计算规范化 hash
  const redacted = redactValidatedReport(validated);
  const hash = reportHashHex(redacted);

  // 4. 事务内:幂等键 / 首次写 / 替换写
  let outcome: SubmitDeliveryReportResult = {
    response: {
      ok: true,
      task_id: taskId,
      report_version: redacted.schema_version,
      report_head_commit: redacted.report_head_commit,
      submitted_at: new Date().toISOString(),
    },
    replay: false,
  };
  const now = new Date().toISOString();
  db.$client.transaction(() => {
    // 4.1 事务内 recheck 任务状态(防 TOCTOU)
    const cur = db.$client
      .prepare(`SELECT id, status, delivery_contract_version, delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as
      | { id: string; status: string; delivery_contract_version: number; delivered_at: string | null }
      | undefined;
    if (!cur) {
      throw makeDeliveryError(409, DELIVERY_ERROR_CODES.TASK_NOT_ACTIVE, "Task 不存在", { task_id: taskId });
    }
    if (cur.status !== "dispatched" && cur.status !== "running") {
      throw makeDeliveryError(409, DELIVERY_ERROR_CODES.TASK_NOT_ACTIVE, "Task 已终态,不可提交 Delivery Report", {
        task_id: taskId,
        status: cur.status,
      });
    }
    if (cur.delivery_contract_version !== 2) {
      throw makeDeliveryError(
        409,
        DELIVERY_ERROR_CODES.INVALID_TRANSITION,
        "v1 Task 不支持 Delivery Report",
        { task_id: taskId, delivery_contract_version: cur.delivery_contract_version },
      );
    }

    // 4.2 已有 Report 行:按 hash 决定 replay / replace / 拒绝
    const existing = getDeliveryReport(db, taskId);
    if (existing) {
      // 计算已存行的规范化 hash:用已存的 JSON 字段回放 normalize。
      // 现有 schema 字段与 ValidatedDeliveryReport 一致,直接还原。
      const existingValidated: ValidatedDeliveryReport = {
        schema_version: existing.schema_version as ValidatedDeliveryReport["schema_version"],
        report_head_commit: existing.report_head_commit,
        problem_understanding: existing.problem_understanding,
        solution_summary: existing.solution_summary,
        changed_areas: JSON.parse(existing.changed_areas_json) as ValidatedDeliveryReport["changed_areas"],
        risks: JSON.parse(existing.risks_json) as ValidatedDeliveryReport["risks"],
        unresolved: JSON.parse(existing.unresolved_json) as ValidatedDeliveryReport["unresolved"],
      };
      const existingHash = reportHashHex(existingValidated);
      if (existingHash === hash) {
        // Replay:不写新行,不刷新任何时间戳
        outcome = {
          response: {
            ok: true,
            task_id: taskId,
            report_version: existing.schema_version as ValidatedDeliveryReport["schema_version"],
            report_head_commit: existing.report_head_commit,
            submitted_at: existing.submitted_at,
            replay: true,
          },
          replay: true,
        };
        return;
      }
      // 不同内容:active Task 允许替换同一行(用于追问后绑定新 HEAD)
      db.$client
        .prepare(
          `UPDATE task_delivery_reports SET
              schema_version = ?,
              report_head_commit = ?,
              problem_understanding = ?,
              solution_summary = ?,
              changed_areas_json = ?,
              risks_json = ?,
              unresolved_json = ?,
              updated_at = ?
            WHERE task_id = ?`,
        )
        .run(
          redacted.schema_version,
          redacted.report_head_commit,
          redacted.problem_understanding,
          redacted.solution_summary,
          JSON.stringify(redacted.changed_areas),
          JSON.stringify(redacted.risks),
          JSON.stringify(redacted.unresolved),
          now,
          taskId,
        );
      // 不刷新 delivered_at,不刷新 submitted_at
      outcome = {
        response: {
          ok: true,
          task_id: taskId,
          report_version: redacted.schema_version,
          report_head_commit: redacted.report_head_commit,
          submitted_at: existing.submitted_at,
        },
        replay: false,
      };
      return;
    }

    // 4.3 首次:插入 Report + 写 delivered_at。两条写在同一事务,任一失败回滚。
    db.$client
      .prepare(
        `INSERT INTO task_delivery_reports
            (task_id, schema_version, report_head_commit, problem_understanding, solution_summary,
             changed_areas_json, risks_json, unresolved_json, submitted_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        redacted.schema_version,
        redacted.report_head_commit,
        redacted.problem_understanding,
        redacted.solution_summary,
        JSON.stringify(redacted.changed_areas),
        JSON.stringify(redacted.risks),
        JSON.stringify(redacted.unresolved),
        now,
        now,
      );
    db.$client
      .prepare(`UPDATE tasks SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`)
      .run(now, taskId);
    outcome = {
      response: {
        ok: true,
        task_id: taskId,
        report_version: redacted.schema_version,
        report_head_commit: redacted.report_head_commit,
        submitted_at: now,
      },
      replay: false,
    };
  })();
  return outcome;
}

// ----------------------------------------------------------------------------
// Delivery Query(GET /api/daemon/tasks/:id/delivery)
// ----------------------------------------------------------------------------

/**
 * 读取 Delivery 状态:返回完整 DeliveryQueryResponse。
 *  - delivered = tasks.delivered_at != null
 *  - report_submitted = task_delivery_reports 行存在
 *  - report_schema_version / report_head_commit:有 Report 时返回真实值,无则 null
 *  - issue_status_requested:从 issues.status 派生(in_review / done / blocked 三态之一
 *    且 delivered 路径走 issue-status 回调时,这里反映对应状态;v2 仅 Report 不调 callback
 *    时为 null)
 *
 * 简化:issue_status_requested 仍按 PRD §9 DeliveryQueryResponse 语义派生——
 *   - issues.status 是 in_review / done / blocked 时返回该状态
 *   - 否则 null
 * 但 v2 走 Report 路径时,通常 issue 不会被动到 in_review / done,
 * issue_status_requested 主要为 v1 兼容。
 */
export function getDeliveryQuery(db: Db, taskId: string): DeliveryQueryResponse {
  const taskRow = db.$client
    .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
    .get(taskId) as { delivered_at: string | null } | undefined;
  const reportRow = getDeliveryReport(db, taskId);
  const issueRow = db.$client
    .prepare(
      `SELECT i.status FROM issues i
       INNER JOIN tasks t ON t.issue_id = i.id
       WHERE t.id = ?`,
    )
    .get(taskId) as { status: string } | undefined;

  const issueStatusRequested: DeliveryQueryResponse["issue_status_requested"] =
    issueRow && (issueRow.status === "in_review" || issueRow.status === "done" || issueRow.status === "blocked")
      ? issueRow.status
      : null;

  return {
    delivered: taskRow?.delivered_at != null,
    report_submitted: reportRow != null,
    report_schema_version: reportRow ? (reportRow.schema_version as DeliveryQueryResponse["report_schema_version"]) : null,
    report_head_commit: reportRow?.report_head_commit ?? null,
    issue_status_requested: issueStatusRequested,
  };
}
