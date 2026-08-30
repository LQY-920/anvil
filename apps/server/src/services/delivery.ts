// apps/server/src/services/delivery.ts
//
// A05 · Delivery Report 服务
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
import type { Db } from "../db/client.js";
import {
  DELIVERY_CONTRACT_CURRENT_VERSION,
  type DeliveryReportReceipt,
  type DeliveryReportReplay,
  type DeliveryQueryResponse,
  type ValidatedDeliveryReport,
  validateDeliveryReport,
  normalizeReportForHash,
} from "@anvil/core";
import { redactTokens } from "./tasks.js";

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
