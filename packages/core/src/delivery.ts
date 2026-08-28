// packages/core/src/delivery.ts
//
// A01 · 可信交付 v2 协议校验与归一化纯函数(Codex review 修订版)。
//
// 本文件只放纯函数与最小数据结构;不依赖任何运行时副作用(server/runner/web 都能用)。
// 所有限额与 SHA/timeout 边界与 PRD §6 FR-001/FR-002 对齐。
//
// 错误码:校验函数返回的 `ValidationError.code` 是内部原因码(`ValidationErrorCode`),
// 公开 API 错误码 `AnvilErrorCode`(protocol.ts)只包含 PRD §9 稳定机器码;
// route 层在内部失败时把原因放进 `details`,本模块不冒充公开 API 错误码。

import crypto from "node:crypto";
import {
  DELIVERY_REPORT_SCHEMA_VERSION,
  LIMITS,
  RISK_LEVELS,
  VERIFICATION_POLICY_SCHEMA_VERSION,
  type DeliveryReportSchemaVersion,
  type RiskLevel,
  type VerificationStatus,
} from "./models.js";

// ----------------------------------------------------------------------------
// 常量与正则
// ----------------------------------------------------------------------------

/** 完整 40 位 hex SHA-1(Git `rev-parse` 输出与 PR/计划锁定值)。 */
export const SHA1_40_PATTERN = /^[0-9a-f]{40}$/i;

/** Verification Policy 命令 id 允许字符(避免路径/换行注入与 JSON 嵌入风险)。 */
export const POLICY_ID_PATTERN = /^[A-Za-z0-9_\-]{1,64}$/;

// ----------------------------------------------------------------------------
// 错误结构与基础类型
// ----------------------------------------------------------------------------

/**
 * 校验阶段返回的内部原因码 —— 详细分级,仅供 server 映射到公开 `AnvilErrorCode`
 * 与 `details` 字段;不暴露给公开 API 响应。
 */
export type ValidationErrorCode =
  | "report_invalid"
  | "report_schema_unknown"
  | "report_too_large"
  | "report_duplicate_path"
  | "report_invalid_risk"
  | "report_invalid_sha"
  | "report_missing_field"
  | "report_text_too_long"
  | "policy_version_unknown"
  | "policy_version_missing"
  | "policy_invalid_command_count"
  | "policy_duplicate_id"
  | "policy_timeout_out_of_range"
  | "policy_required_missing"
  | "policy_invalid_command"
  | "policy_invalid_id"
  | "sha_missing"
  | "sha_malformed"
  | "sha_mismatch"
  | "result_json_invalid"
  | "result_json_unsupported"
  | "result_json_legacy";

/** 校验阶段返回的结构化错误项。`code` 是内部原因码;route 层映射到公开机器码。 */
export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: ValidationError[];
}

function err(code: ValidationErrorCode, message: string, details?: Record<string, unknown>): ValidationError {
  return { code, message, details };
}

// ----------------------------------------------------------------------------
// 内部帮助
// ----------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** 递归生成稳定 JSON 字符串:对象 key 按字典序排序,数组保留原顺序,原始值原样。 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // 与 JSON.stringify(null) 行为对齐,避免 NaN/Infinity 破坏稳定哈希
      return "null";
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
  }
  // bigint / symbol / function 等不应进入 hash
  return "null";
}

// ----------------------------------------------------------------------------
// SHA 工具
// ----------------------------------------------------------------------------

/** 计算 UTF-8 字符串的 SHA-256(hex 编码)。用于 `policy_hash` 与 `payload_hash`。 */
export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** 完整 40 位 hex SHA-1。 */
export function isValidSha1Hex40(s: unknown): s is string {
  return typeof s === "string" && SHA1_40_PATTERN.test(s);
}

/** 把任意已校验 payload 归一化为稳定 JSON 并计算 SHA-256,用于 D-003 幂等键。 */
export function canonicalJsonHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

// ----------------------------------------------------------------------------
// Delivery Report 校验
// ----------------------------------------------------------------------------

/** 校验后的 Delivery Report(`schema_version` 归一为字面量,`report_head_commit` 归一为小写)。 */
export interface ValidatedDeliveryReport {
  schema_version: DeliveryReportSchemaVersion;
  problem_understanding: string;
  solution_summary: string;
  changed_areas: { path: string; summary: string }[];
  risks: { level: RiskLevel; summary: string; mitigation: string }[];
  unresolved: { description: string }[];
  report_head_commit: string;
}

/**
 * 校验 Agent Delivery Report 请求体:
 * - 顶层必须是对象
 * - 总字节数 ≤ 64KB
 * - schema_version 必须是当前支持的版本(1)
 * - problem_understanding / solution_summary 必须是非空字符串,且各自 ≤ 4000 字符
 * - report_head_commit 必须是 40 位 hex SHA-1
 * - changed_areas / risks / unresolved 必须是数组,且不超过各自上限
 * - changed_areas 的 path 不可重复
 * - risks[].level 必须在 `RISK_LEVELS` 内
 */
export function validateDeliveryReport(input: {
  body: unknown;
  bodyBytes: number;
}): ValidationResult<ValidatedDeliveryReport> {
  const errors: ValidationError[] = [];
  if (!isRecord(input.body)) {
    return { ok: false, errors: [err("report_invalid", "report body must be a JSON object")] };
  }
  if (input.bodyBytes > LIMITS.REPORT_BODY_BYTES) {
    return {
      ok: false,
      errors: [err("report_too_large", `report body exceeds ${LIMITS.REPORT_BODY_BYTES} bytes`, { bytes: input.bodyBytes })],
    };
  }
  const b = input.body;

  if (b.schema_version !== DELIVERY_REPORT_SCHEMA_VERSION) {
    errors.push(err("report_schema_unknown", `schema_version must be ${DELIVERY_REPORT_SCHEMA_VERSION}`));
  }
  if (!isString(b.problem_understanding) || b.problem_understanding.length === 0) {
    errors.push(err("report_missing_field", "problem_understanding is required"));
  } else if (b.problem_understanding.length > LIMITS.REPORT_TEXT_FIELD_CHARS) {
    errors.push(err("report_text_too_long",
      `problem_understanding exceeds ${LIMITS.REPORT_TEXT_FIELD_CHARS} characters`,
      { field: "problem_understanding", length: b.problem_understanding.length, limit: LIMITS.REPORT_TEXT_FIELD_CHARS }
    ));
  }
  if (!isString(b.solution_summary) || b.solution_summary.length === 0) {
    errors.push(err("report_missing_field", "solution_summary is required"));
  } else if (b.solution_summary.length > LIMITS.REPORT_TEXT_FIELD_CHARS) {
    errors.push(err("report_text_too_long",
      `solution_summary exceeds ${LIMITS.REPORT_TEXT_FIELD_CHARS} characters`,
      { field: "solution_summary", length: b.solution_summary.length, limit: LIMITS.REPORT_TEXT_FIELD_CHARS }
    ));
  }
  if (!isString(b.report_head_commit) || !isValidSha1Hex40(b.report_head_commit)) {
    errors.push(err("report_invalid_sha", "report_head_commit must be a 40-character hex SHA-1"));
  }
  if (!Array.isArray(b.changed_areas)) {
    errors.push(err("report_missing_field", "changed_areas must be an array"));
  }
  if (!Array.isArray(b.risks)) {
    errors.push(err("report_missing_field", "risks must be an array"));
  }
  if (!Array.isArray(b.unresolved)) {
    errors.push(err("report_missing_field", "unresolved must be an array"));
  }
  if (errors.length > 0) return { ok: false, errors };

  // 把数组固化到局部变量,避免后续 for 循环 narrowing 丢失
  const changedAreasRaw: unknown[] = b.changed_areas as unknown[];
  const risksRaw: unknown[] = b.risks as unknown[];
  const unresolvedRaw: unknown[] = b.unresolved as unknown[];

  // 上限
  if (changedAreasRaw.length > LIMITS.CHANGED_AREAS) {
    errors.push(err("report_too_large", `changed_areas exceeds ${LIMITS.CHANGED_AREAS}`, { count: changedAreasRaw.length }));
  }
  if (risksRaw.length > LIMITS.RISKS) {
    errors.push(err("report_too_large", `risks exceeds ${LIMITS.RISKS}`, { count: risksRaw.length }));
  }
  if (unresolvedRaw.length > LIMITS.UNRESOLVED) {
    errors.push(err("report_too_large", `unresolved exceeds ${LIMITS.UNRESOLVED}`, { count: unresolvedRaw.length }));
  }

  // changed_areas 项校验 + 重复 path
  const changedAreas: { path: string; summary: string }[] = [];
  const seenPaths = new Set<string>();
  const dupPaths: string[] = [];
  for (let i = 0; i < changedAreasRaw.length; i++) {
    const c = changedAreasRaw[i];
    if (!isRecord(c)) {
      errors.push(err("report_invalid", `changed_areas[${i}] must be an object`));
      continue;
    }
    if (!isString(c.path) || c.path.length === 0) {
      errors.push(err("report_missing_field", `changed_areas[${i}].path is required`));
      continue;
    }
    if (!isString(c.summary)) {
      errors.push(err("report_missing_field", `changed_areas[${i}].summary is required`));
      continue;
    }
    if (seenPaths.has(c.path)) {
      dupPaths.push(c.path);
      continue;
    }
    seenPaths.add(c.path);
    changedAreas.push({ path: c.path, summary: c.summary });
  }
  if (dupPaths.length > 0) {
    errors.push(err("report_duplicate_path", "changed_areas contains duplicate path(s)", { paths: [...new Set(dupPaths)] }));
  }

  // risks 项校验
  const risks: { level: RiskLevel; summary: string; mitigation: string }[] = [];
  for (let i = 0; i < risksRaw.length; i++) {
    const r = risksRaw[i];
    if (!isRecord(r)) {
      errors.push(err("report_invalid", `risks[${i}] must be an object`));
      continue;
    }
    if (!isString(r.level) || !(RISK_LEVELS as readonly string[]).includes(r.level)) {
      errors.push(err("report_invalid_risk", `risks[${i}].level must be one of ${RISK_LEVELS.join("|")}`, { level: r.level }));
      continue;
    }
    if (!isString(r.summary) || r.summary.length === 0) {
      errors.push(err("report_missing_field", `risks[${i}].summary is required`));
      continue;
    }
    if (!isString(r.mitigation) || r.mitigation.length === 0) {
      errors.push(err("report_missing_field", `risks[${i}].mitigation is required`));
      continue;
    }
    risks.push({ level: r.level as RiskLevel, summary: r.summary, mitigation: r.mitigation });
  }

  // unresolved 项校验
  const unresolved: { description: string }[] = [];
  for (let i = 0; i < unresolvedRaw.length; i++) {
    const u = unresolvedRaw[i];
    if (!isRecord(u)) {
      errors.push(err("report_invalid", `unresolved[${i}] must be an object`));
      continue;
    }
    if (!isString(u.description) || u.description.length === 0) {
      errors.push(err("report_missing_field", `unresolved[${i}].description is required`));
      continue;
    }
    unresolved.push({ description: u.description });
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      schema_version: DELIVERY_REPORT_SCHEMA_VERSION,
      problem_understanding: b.problem_understanding as string,
      solution_summary: b.solution_summary as string,
      changed_areas: changedAreas,
      risks,
      unresolved,
      report_head_commit: (b.report_head_commit as string).toLowerCase(),
    },
    errors: [],
  };
}

// ----------------------------------------------------------------------------
// Verification Policy 校验
// ----------------------------------------------------------------------------

/** 校验后的策略命令(原始 JSON 不再被引用,所有字段已类型化)。 */
export interface ValidatedVerificationCommand {
  id: string;
  label: string;
  command: string;
  required: boolean;
  timeout_ms: number;
}
export interface ValidatedVerificationPolicy {
  version: 1;
  commands: ValidatedVerificationCommand[];
}

/**
 * 校验 `ANVIL.verify.json` 文档:
 * - 顶层对象,`version` 必须为 1(缺失或非 1 拒绝)
 * - `commands` 数组;0 条允许(= not_configured),1..8 条允许,9+ 拒绝
 * - 每条 id 必须匹配 `[A-Za-z0-9_-]{1,64}` 且在策略内唯一
 * - 每条 label / command 必须为非空字符串
 * - 每条 required 必须是 boolean
 * - 每条 timeout_ms 必须在 [1_000, 1_800_000] 内
 *
 * 注意:`policy_hash` 不在此函数中计算,Runner 读取 `base_commit:ANVIL.verify.json`
 * 的原始字节并直接 SHA-256(见 `policyHash`)以保证不同命令顺序产生不同 hash。
 */
export function validateVerificationPolicy(policy: unknown): ValidationResult<ValidatedVerificationPolicy> {
  const errors: ValidationError[] = [];
  if (!isRecord(policy)) {
    return { ok: false, errors: [err("policy_invalid_command", "policy must be a JSON object")] };
  }
  // version 必须为字面量 1
  if (policy.version === undefined || policy.version === null) {
    return { ok: false, errors: [err("policy_version_missing", `policy.version is required and must be ${VERIFICATION_POLICY_SCHEMA_VERSION}`)] };
  }
  if (policy.version !== VERIFICATION_POLICY_SCHEMA_VERSION) {
    return { ok: false, errors: [err("policy_version_unknown", `policy.version must be ${VERIFICATION_POLICY_SCHEMA_VERSION}`, { version: policy.version })] };
  }
  if (!Array.isArray(policy.commands)) {
    return { ok: false, errors: [err("policy_invalid_command", "policy.commands must be an array")] };
  }
  if (policy.commands.length > LIMITS.VERIFICATION_COMMANDS) {
    return {
      ok: false,
      errors: [err(
        "policy_invalid_command_count",
        `policy has ${policy.commands.length} commands, max ${LIMITS.VERIFICATION_COMMANDS}`,
        { count: policy.commands.length }
      )],
    };
  }

  const commands: ValidatedVerificationCommand[] = [];
  const seen = new Set<string>();
  const dupIds: string[] = [];

  for (let i = 0; i < policy.commands.length; i++) {
    const raw = policy.commands[i];
    if (!isRecord(raw)) {
      errors.push(err("policy_invalid_command", `commands[${i}] must be an object`));
      continue;
    }
    if (!isString(raw.id) || !POLICY_ID_PATTERN.test(raw.id)) {
      errors.push(err("policy_invalid_id", `commands[${i}].id must match [A-Za-z0-9_-]{1,64}`, { id: raw.id }));
      continue;
    }
    if (seen.has(raw.id)) {
      dupIds.push(raw.id);
      continue;
    }
    seen.add(raw.id);
    if (!isString(raw.label) || raw.label.length === 0) {
      errors.push(err("policy_invalid_command", `commands[${i}].label is required`, { id: raw.id }));
      continue;
    }
    if (!isString(raw.command) || raw.command.length === 0) {
      errors.push(err("policy_invalid_command", `commands[${i}].command is required`, { id: raw.id }));
      continue;
    }
    if (typeof raw.required !== "boolean") {
      errors.push(err("policy_required_missing", `commands[${i}].required must be boolean`, { id: raw.id }));
      continue;
    }
    if (
      typeof raw.timeout_ms !== "number" ||
      !Number.isFinite(raw.timeout_ms) ||
      raw.timeout_ms < LIMITS.MIN_VERIFICATION_TIMEOUT_MS ||
      raw.timeout_ms > LIMITS.MAX_VERIFICATION_TIMEOUT_MS
    ) {
      errors.push(err(
        "policy_timeout_out_of_range",
        `commands[${i}].timeout_ms must be in [${LIMITS.MIN_VERIFICATION_TIMEOUT_MS}, ${LIMITS.MAX_VERIFICATION_TIMEOUT_MS}]`,
        { id: raw.id, timeout_ms: raw.timeout_ms }
      ));
      continue;
    }
    commands.push({
      id: raw.id,
      label: raw.label,
      command: raw.command,
      required: raw.required,
      timeout_ms: raw.timeout_ms,
    });
  }
  if (dupIds.length > 0) {
    errors.push(err("policy_duplicate_id", "policy.commands contains duplicate id(s)", { ids: [...new Set(dupIds)] }));
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { version: VERIFICATION_POLICY_SCHEMA_VERSION, commands }, errors: [] };
}

// ----------------------------------------------------------------------------
// Verification status 派生
// ----------------------------------------------------------------------------

/** `deriveVerificationStatus` 输入:Runner 把每条 check 折叠为最小事实。 */
export interface VerificationCheckFact {
  id: string;
  required: boolean;
  exit_code: number | null;
  timed_out: boolean;
}

export interface VerificationDeriveInput {
  /** 仓库根是否包含 `ANVIL.verify.json`;false → not_configured。 */
  policyPresent: boolean;
  /** 实际执行后的检查结果。`exit_code === null` 表示 spawn 失败(spawn 本身
   *  不暴露为公开 Check 状态,而是直接派生为 failed,与"required 失败"等价)。 */
  checks: VerificationCheckFact[];
  /** 验证前后 head_commit 是否一致(由 Runner 读取并填充)。 */
  headUnchanged: boolean;
  /** 验证结束后 worktree 是否干净。 */
  worktreeClean: boolean;
}

/**
 * 派生 Verification Run 终态(FR-001 验收 criteria,严格对齐 PRD §8 state taxonomy):
 * 1. `policyPresent=false` → `not_configured`
 * 2. 任一 required 退出码非 0、超时或 spawn 失败(`exit_code === null`)→ `failed`
 * 3. 全部 required 通过,但 `!worktreeClean` → `dirty`
 * 4. 全部 required 通过,但 `!headUnchanged` → `stale`
 * 5. 全部 required 通过,但存在 optional 失败 / 超时 / spawn 失败 → `partial`
 * 6. 全部 required 通过、optional 全通过、head unchanged、worktree clean → `passed`
 *
 * 注意:`legacy` 不在派生函数中处理,只对迁移前 v1 Task 显式写入。
 */
export function deriveVerificationStatus(input: VerificationDeriveInput): VerificationStatus {
  if (!input.policyPresent) return "not_configured";
  if (input.checks.length === 0) return "not_configured";
  for (const c of input.checks) {
    if (!c.required) continue;
    if (c.timed_out) return "failed";
    if (c.exit_code === null || c.exit_code !== 0) return "failed";
  }
  if (!input.worktreeClean) return "dirty";
  if (!input.headUnchanged) return "stale";
  for (const c of input.checks) {
    if (c.required) continue;
    if (c.timed_out) return "partial";
    if (c.exit_code === null || c.exit_code !== 0) return "partial";
  }
  return "passed";
}

// ----------------------------------------------------------------------------
// 三 SHA 一致性
// ----------------------------------------------------------------------------

export interface ShaTripleResult {
  /** 三者全部存在(非空)、均为完整 40 位 hex SHA、归一后相等。 */
  equal: boolean;
  /** null / 空字符串 / 非字符串 —— 视为"缺失"。 */
  missing: string[];
  /** 存在但不是完整 40 位 hex SHA —— 视为"格式非法"。 */
  invalid: string[];
  /** 三者均存在且格式合法但归一后不全相等。 */
  mismatch: string[];
}

/**
 * 比较 Report / head / verification 三个 SHA-1:
 * 1. 任一为非字符串 / null / 空字符串 → 计入 missing
 * 2. 存在但不是完整 40 位 hex SHA → 计入 invalid
 * 3. 全部存在、格式合法但归一后不全相等 → 计入 mismatch
 * 4. 全部存在、格式合法、归一后相等 → equal
 *
 * 大小写不敏感:Git SHA-1 通常小写,但允许 runner/agent 大小写不一致。
 * 三个值即使相同,若任一不是 40 位 hex 也**不能**判 equal(完整性优先于表面一致)。
 */
export function compareThreeShas(values: {
  report?: string | null;
  head?: string | null;
  verification?: string | null;
}): ShaTripleResult {
  const present: { report: boolean; head: boolean; verification: boolean } = {
    report: typeof values.report === "string" && values.report.length > 0,
    head: typeof values.head === "string" && values.head.length > 0,
    verification: typeof values.verification === "string" && values.verification.length > 0,
  };
  const missing: string[] = [];
  if (!present.report) missing.push("report");
  if (!present.head) missing.push("head");
  if (!present.verification) missing.push("verification");
  if (missing.length > 0) {
    return { equal: false, missing, invalid: [], mismatch: [] };
  }
  const r = (values.report as string).toLowerCase();
  const h = (values.head as string).toLowerCase();
  const v = (values.verification as string).toLowerCase();
  const invalid: string[] = [];
  if (!SHA1_40_PATTERN.test(r)) invalid.push("report");
  if (!SHA1_40_PATTERN.test(h)) invalid.push("head");
  if (!SHA1_40_PATTERN.test(v)) invalid.push("verification");
  if (invalid.length > 0) {
    return { equal: false, missing: [], invalid, mismatch: [] };
  }
  if (r === h && h === v) return { equal: true, missing: [], invalid: [], mismatch: [] };
  const mismatch: string[] = [];
  if (r !== h) mismatch.push("report!=head");
  if (h !== v) mismatch.push("head!=verification");
  if (r !== v) mismatch.push("report!=verification");
  return { equal: false, missing: [], invalid: [], mismatch };
}

// ----------------------------------------------------------------------------
// Report payload 归一化与 SHA
// ----------------------------------------------------------------------------

/**
 * 把校验后的 Report 归一化为可重放排序的 JSON 字符串:
 * - changed_areas 按 path 字典序排序
 * - risks 按 summary 字典序排序
 * - unresolved 按 description 字典序排序
 * - report_head_commit 归一为小写
 */
export function normalizeReportForHash(report: ValidatedDeliveryReport): string {
  const sorted: ValidatedDeliveryReport = {
    schema_version: report.schema_version,
    problem_understanding: report.problem_understanding,
    solution_summary: report.solution_summary,
    changed_areas: [...report.changed_areas]
      .map((c) => ({ path: c.path, summary: c.summary }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    risks: [...report.risks]
      .map((r) => ({ level: r.level, summary: r.summary, mitigation: r.mitigation }))
      .sort((a, b) => (a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0)),
    unresolved: [...report.unresolved]
      .map((u) => ({ description: u.description }))
      .sort((a, b) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0)),
    report_head_commit: report.report_head_commit.toLowerCase(),
  };
  return stableStringify(sorted);
}

/** 计算归一化 Report 的 SHA-256;用于 Delivery Report 行的幂等键。 */
export function reportHash(report: ValidatedDeliveryReport): string {
  return sha256Hex(normalizeReportForHash(report));
}

/**
 * 计算 ANVIL.verify.json 原始内容的 SHA-256,作为 `policy_hash` 落库。
 *
 * **必须**对 base_commit 对应版本的文件原始字节直接做 SHA-256;不得先解析、
 * 按 id 排序再哈希 —— 否则不同命令顺序的策略会产生相同 hash,破坏"标识真实内容"
 * 的契约。Runner 通常通过 `git show <base_commit>:ANVIL.verify.json` 拿到原始文本。
 */
export function policyHash(rawFileText: string): string {
  return sha256Hex(rawFileText);
}

// ----------------------------------------------------------------------------
// result_json 安全解析(FR-001 AC 14:迁移前 v1 Task 明确显示 legacy)
// ----------------------------------------------------------------------------

export type ParsedResultJson =
  | { kind: "absent" }
  | { kind: "incomplete"; raw: string; reason: string }
  | { kind: "unsupported"; raw: string; schemaVersion: number }
  | { kind: "valid"; raw: string; value: Record<string, unknown> };

/**
 * 安全解析 `Task.result_json`:
 * - `null` / `undefined` / 空字符串 → absent
 * - JSON.parse 失败或顶层不是对象 → incomplete(不抛)
 * - 顶层是对象但 `schema_version` 不是当前支持的版本(2)→ unsupported
 * - 顶层是对象且 `schema_version === 2` → valid
 */
export function parseResultJson(raw: string | null | undefined): ParsedResultJson {
  if (raw == null || raw.length === 0) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { kind: "incomplete", raw, reason };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "incomplete", raw, reason: "top-level value must be an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const v = obj.schema_version;
  if (typeof v === "number" && v === 2) {
    return { kind: "valid", raw, value: obj };
  }
  if (typeof v === "number") {
    return { kind: "unsupported", raw, schemaVersion: v };
  }
  return { kind: "incomplete", raw, reason: "missing schema_version" };
}

/** 判定 v1 旧 result_json 的可读性。 */
export type ResultJsonClassification = "legacy" | "incomplete" | "unsupported" | "valid";

/**
 * 判定 v1 旧 result_json:
 * - `absent`(空 / null)→ `legacy`(无 v1 数据可读,UI 直接按 legacy 处理)
 * - `incomplete`(解析失败 / 非对象 / 缺 schema_version)→ `incomplete`
 * - `unsupported`(解析成功但 schema_version 不是 2)→ `unsupported`
 * - `valid`(schema_version === 2)→ `valid`
 */
export function classifyResultJson(raw: string | null | undefined): ResultJsonClassification {
  const parsed = parseResultJson(raw);
  switch (parsed.kind) {
    case "absent": return "legacy";
    case "incomplete": return "incomplete";
    case "unsupported": return "unsupported";
    case "valid": return "valid";
  }
}
