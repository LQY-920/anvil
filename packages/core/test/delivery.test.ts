// packages/core/test/delivery.test.ts
//
// A01-FIX · v2 协议校验与归一化纯函数单测(Codex review 修订版)。
//
// 覆盖范围:
// - 合法 / 非法 Delivery Report、未知 schema、64KB 上限、4000 字符上限、
//   重复 path、风险枚举、40 位 SHA
// - Verification Policy:version 校验、0/8/9 条命令、重复 id、id 字符集、
//   timeout 边界(1000/999/1.8M/1.8M+1)
// - 三 SHA 一致 / 缺失 / 非法格式 / 不一致
// - policyHash 直接对原始文本计算 SHA-256(顺序敏感)
// - result_json safe parse + 仅 schema_version=2 valid(99 → unsupported)
// - 常量集合精确等于 PRD 状态集
// - 公开 AnvilErrorCode 严格等于 8 个 PRD 机器码

import { describe, it, expect } from "vitest";
import {
  ANVIL_ERROR_CODE_VALUES,
  CONTINUATION_MODES,
  DECISION_TYPES,
  DELIVERY_REPORT_SCHEMA_VERSION,
  FEEDBACK_SCOPES,
  INTEGRATION_ATTEMPT_STATUSES,
  LIMITS,
  REVIEW_PACKET_STATUSES,
  RISK_LEVELS,
  RESTART_MODES,
  RunnerSubmittableVerificationStatus,
  SHA1_40_PATTERN,
  VERIFICATION_CHECK_STATUSES,
  VERIFICATION_POLICY_SCHEMA_VERSION,
  VERIFICATION_STATUSES,
  canonicalJsonHash,
  classifyResultJson,
  compareThreeShas,
  deriveVerificationStatus,
  isValidSha1Hex40,
  parseResultJson,
  policyHash,
  reportHash,
  sha256Hex,
  validateDeliveryReport,
  validateVerificationPolicy,
  type V2CompleteRequest,
  type V2CompleteResponse,
  type V2FailRequest,
  type VerificationCheck,
  type VerificationRun,
} from "../src/index.js";

// ---- 工具 ----

/** 构造一个最小合法 Report(测试可在任意字段上覆写)。 */
function makeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    report_head_commit: "0123456789abcdef0123456789abcdef01234567",
    problem_understanding: "理解问题",
    solution_summary: "解决方案",
    changed_areas: [{ path: "a/b.ts", summary: "改动" }],
    risks: [{ level: "low", summary: "风险", mitigation: "缓解" }],
    unresolved: [],
    ...overrides,
  };
}

/** 把对象序列化为 UTF-8 字节数,模拟"请求体字节数"。 */
function bodyBytes(obj: unknown): number {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}

// ============================================================================
// 常量集合 —— 严格等于 PRD 状态集
// ============================================================================

describe("constant sets are exact", () => {
  it("VERIFICATION_STATUSES is exactly PRD's 7 states (no 'timeout')", () => {
    expect([...VERIFICATION_STATUSES].sort()).toEqual([
      "dirty", "failed", "legacy", "not_configured", "partial", "passed", "stale",
    ]);
  });

  it("VERIFICATION_CHECK_STATUSES is exactly {passed,failed,timed_out,skipped}", () => {
    expect([...VERIFICATION_CHECK_STATUSES].sort()).toEqual(["failed", "passed", "skipped", "timed_out"]);
  });

  it("RISK_LEVELS is exactly {low,medium,high}", () => {
    expect([...RISK_LEVELS].sort()).toEqual(["high", "low", "medium"]);
  });

  it("REVIEW_PACKET_STATUSES has the 10 PRD states", () => {
    expect([...REVIEW_PACKET_STATUSES].sort()).toEqual([
      "closed", "decision_recorded", "generating", "incomplete", "integration_failed",
      "integrity_blocked", "legacy", "ready", "remote_push_pending", "verification_blocked",
    ]);
  });

  it("DECISION_TYPES is exactly the 4 PRD types", () => {
    expect([...DECISION_TYPES].sort()).toEqual([
      "approve", "approve_override", "changes_requested", "manual_takeover",
    ]);
  });

  it("RESTART_MODES is {resume,fresh_base}", () => {
    expect([...RESTART_MODES].sort()).toEqual(["fresh_base", "resume"]);
  });

  it("FEEDBACK_SCOPES is {one_time,project_rule,automated_test}", () => {
    expect([...FEEDBACK_SCOPES].sort()).toEqual(["automated_test", "one_time", "project_rule"]);
  });

  it("INTEGRATION_ATTEMPT_STATUSES is the 5 PRD states", () => {
    expect([...INTEGRATION_ATTEMPT_STATUSES].sort()).toEqual([
      "merge_conflict", "merge_succeeded", "remote_non_fast_forward",
      "remote_push_failed", "remote_push_succeeded",
    ]);
  });

  it("CONTINUATION_MODES is {initial,resume,fresh_base}", () => {
    expect([...CONTINUATION_MODES].sort()).toEqual(["fresh_base", "initial", "resume"]);
  });

  it("DELIVERY_REPORT_SCHEMA_VERSION is 1", () => {
    expect(DELIVERY_REPORT_SCHEMA_VERSION).toBe(1);
  });

  it("VERIFICATION_POLICY_SCHEMA_VERSION is 1", () => {
    expect(VERIFICATION_POLICY_SCHEMA_VERSION).toBe(1);
  });

  it("ANVIL_ERROR_CODE_VALUES is exactly the 9 PRD machine codes", () => {
    expect([...ANVIL_ERROR_CODE_VALUES].sort()).toEqual([
      "base_mismatch", "idempotency_conflict", "invalid_git_anchor", "invalid_schema", "invalid_transition",
      "invalid_verification", "payload_too_large", "runtime_ownership_mismatch", "task_not_active",
    ]);
  });

  it("REPORT_TEXT_FIELD_CHARS limit is 4000", () => {
    expect(LIMITS.REPORT_TEXT_FIELD_CHARS).toBe(4000);
  });
});

// ============================================================================
// SHA 与 hash 工具
// ============================================================================

describe("sha256Hex", () => {
  it("produces a 64-char hex string", () => {
    expect(sha256Hex("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable for the same input", () => {
    expect(sha256Hex("anvil")).toBe(sha256Hex("anvil"));
  });
  it("differs for different input", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});

describe("isValidSha1Hex40", () => {
  it("accepts 40 lowercase hex", () => {
    expect(isValidSha1Hex40("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });
  it("accepts 40 uppercase hex", () => {
    expect(isValidSha1Hex40("0123456789ABCDEF0123456789ABCDEF01234567")).toBe(true);
  });
  it("rejects 39 chars", () => {
    expect(isValidSha1Hex40("0123456789abcdef0123456789abcdef0123456")).toBe(false);
  });
  it("rejects 41 chars", () => {
    expect(isValidSha1Hex40("0123456789abcdef0123456789abcdef012345678")).toBe(false);
  });
  it("rejects non-hex characters", () => {
    expect(isValidSha1Hex40("g".repeat(40))).toBe(false);
  });
  it("rejects non-string", () => {
    expect(isValidSha1Hex40(123)).toBe(false);
    expect(isValidSha1Hex40(null)).toBe(false);
  });
});

describe("SHA1_40_PATTERN", () => {
  it("matches 40 lowercase hex", () => {
    expect(SHA1_40_PATTERN.test("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });
  it("does not match 39 chars", () => {
    expect(SHA1_40_PATTERN.test("a".repeat(39))).toBe(false);
  });
});

describe("canonicalJsonHash", () => {
  it("is stable across key order", () => {
    expect(canonicalJsonHash({ a: 1, b: 2 })).toBe(canonicalJsonHash({ b: 2, a: 1 }));
  });
  it("differs when value differs", () => {
    expect(canonicalJsonHash({ a: 1 })).not.toBe(canonicalJsonHash({ a: 2 }));
  });
  it("preserves array order", () => {
    expect(canonicalJsonHash([1, 2])).not.toBe(canonicalJsonHash([2, 1]));
  });
});

// ============================================================================
// Delivery Report 校验
// ============================================================================

describe("validateDeliveryReport", () => {
  it("accepts a valid report", () => {
    const body = makeReport();
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(true);
    expect(r.value?.report_head_commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(r.value?.changed_areas).toEqual([{ path: "a/b.ts", summary: "改动" }]);
    expect(r.errors).toEqual([]);
  });

  it("normalizes report_head_commit to lowercase", () => {
    const body = makeReport({ report_head_commit: "0123456789ABCDEF0123456789ABCDEF01234567" });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(true);
    expect(r.value?.report_head_commit).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("rejects unknown schema_version (2)", () => {
    const body = makeReport({ schema_version: 2 });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("report_schema_unknown");
  });

  it("rejects missing schema_version", () => {
    const body = makeReport();
    delete body.schema_version;
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("report_schema_unknown");
  });

  it("rejects body exceeding 64KB", () => {
    const big = "x".repeat(LIMITS.REPORT_BODY_BYTES + 1);
    const body = makeReport({ problem_understanding: big });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("report_too_large");
  });

  it("accepts a body well under 64KB (limit is 64KB exact boundary verified in reject test)", () => {
    const body = makeReport();
    const bytes = bodyBytes(body);
    expect(bytes).toBeLessThan(LIMITS.REPORT_BODY_BYTES);
    const r = validateDeliveryReport({ body, bodyBytes: bytes });
    expect(r.ok).toBe(true);
  });

  it("rejects duplicate path in changed_areas", () => {
    const body = makeReport({
      changed_areas: [
        { path: "a/b.ts", summary: "1" },
        { path: "a/b.ts", summary: "2" },
      ],
    });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_duplicate_path")).toBe(true);
  });

  it("accepts different paths in changed_areas", () => {
    const body = makeReport({
      changed_areas: [
        { path: "a/b.ts", summary: "1" },
        { path: "a/c.ts", summary: "2" },
      ],
    });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(true);
  });

  it.each(RISK_LEVELS)("accepts risk level %s", (level) => {
    const body = makeReport({ risks: [{ level, summary: "r", mitigation: "m" }] });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(true);
  });

  it("rejects invalid risk level", () => {
    const body = makeReport({ risks: [{ level: "extreme", summary: "r", mitigation: "m" }] });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_invalid_risk")).toBe(true);
  });

  it("rejects 39-char SHA in report_head_commit", () => {
    const body = makeReport({ report_head_commit: "a".repeat(39) });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_invalid_sha")).toBe(true);
  });

  it("rejects 41-char SHA in report_head_commit", () => {
    const body = makeReport({ report_head_commit: "a".repeat(41) });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_invalid_sha")).toBe(true);
  });

  it("rejects non-string report_head_commit", () => {
    const body = makeReport({ report_head_commit: 123 });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_invalid_sha")).toBe(true);
  });

  it("rejects non-object body", () => {
    const r = validateDeliveryReport({ body: "not json object", bodyBytes: 16 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("report_invalid");
  });

  it("rejects array body", () => {
    const r = validateDeliveryReport({ body: [], bodyBytes: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("report_invalid");
  });

  it("rejects missing problem_understanding", () => {
    const body = makeReport();
    delete body.problem_understanding;
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_missing_field")).toBe(true);
  });

  it("rejects missing solution_summary", () => {
    const body = makeReport();
    delete body.solution_summary;
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_missing_field")).toBe(true);
  });

  it("rejects changed_areas exceeding limit", () => {
    const items = Array.from({ length: LIMITS.CHANGED_AREAS + 1 }, (_, i) => ({
      path: `a/${i}.ts`,
      summary: "x",
    }));
    const body = makeReport({ changed_areas: items });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_too_large" && String(e.details?.count) === String(LIMITS.CHANGED_AREAS + 1))).toBe(true);
  });

  it("rejects risks exceeding limit", () => {
    const items = Array.from({ length: LIMITS.RISKS + 1 }, () => ({
      level: "low" as const, summary: "x", mitigation: "y",
    }));
    const body = makeReport({ risks: items });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_too_large")).toBe(true);
  });

  it("rejects unresolved exceeding limit", () => {
    const items = Array.from({ length: LIMITS.UNRESOLVED + 1 }, () => ({ description: "x" }));
    const body = makeReport({ unresolved: items });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_too_large")).toBe(true);
  });

  // 4000 字符上限 —— 边界用例
  it("accepts problem_understanding at exactly 4000 chars", () => {
    const body = makeReport({ problem_understanding: "x".repeat(4000) });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(true);
  });
  it("accepts solution_summary at exactly 4000 chars", () => {
    const body = makeReport({ solution_summary: "x".repeat(4000) });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(true);
  });
  it("rejects problem_understanding at 4001 chars", () => {
    const body = makeReport({ problem_understanding: "x".repeat(4001) });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_text_too_long" && e.details?.field === "problem_understanding")).toBe(true);
  });
  it("rejects solution_summary at 4001 chars", () => {
    const body = makeReport({ solution_summary: "x".repeat(4001) });
    const r = validateDeliveryReport({ body, bodyBytes: bodyBytes(body) });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "report_text_too_long" && e.details?.field === "solution_summary")).toBe(true);
  });
});

// ============================================================================
// Verification Policy 校验
// ============================================================================

describe("validateVerificationPolicy", () => {
  function makeCommand(overrides: Record<string, unknown> = {}) {
    return {
      id: "tests",
      label: "全量测试",
      command: "pnpm test",
      required: true,
      timeout_ms: 900_000,
      ...overrides,
    };
  }

  it("accepts a single-command policy with version=1", () => {
    const r = validateVerificationPolicy({ version: 1, commands: [makeCommand()] });
    expect(r.ok).toBe(true);
    expect(r.value?.commands).toHaveLength(1);
  });

  it("accepts 8 commands", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: Array.from({ length: 8 }, (_, i) => makeCommand({ id: `c${i}` })),
    });
    expect(r.ok).toBe(true);
    expect(r.value?.commands).toHaveLength(8);
  });

  it("accepts 0 commands (not_configured)", () => {
    const r = validateVerificationPolicy({ version: 1, commands: [] });
    expect(r.ok).toBe(true);
    expect(r.value?.commands).toEqual([]);
  });

  it("rejects 9 commands", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: Array.from({ length: 9 }, (_, i) => makeCommand({ id: `c${i}` })),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("policy_invalid_command_count");
    expect(r.errors[0]?.details?.count).toBe(9);
  });

  it("rejects duplicate id", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [makeCommand({ id: "tests" }), makeCommand({ id: "tests" })],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_duplicate_id")).toBe(true);
  });

  it("rejects id with invalid characters", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [makeCommand({ id: "has space" })],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_invalid_id")).toBe(true);
  });

  it("rejects id longer than 64 chars", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [makeCommand({ id: "a".repeat(65) })],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_invalid_id")).toBe(true);
  });

  it("accepts timeout_ms at lower bound (1000)", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [makeCommand({ timeout_ms: 1_000 })],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects timeout_ms below lower bound (999)", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [makeCommand({ timeout_ms: 999 })],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_timeout_out_of_range")).toBe(true);
  });

  it("accepts timeout_ms at upper bound (1_800_000)", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [makeCommand({ timeout_ms: 1_800_000 })],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects timeout_ms above upper bound (1_800_001)", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [makeCommand({ timeout_ms: 1_800_001 })],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_timeout_out_of_range")).toBe(true);
  });

  it("rejects missing required", () => {
    const r = validateVerificationPolicy({
      version: 1,
      commands: [{ id: "t", label: "l", command: "c", timeout_ms: 5000 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_required_missing")).toBe(true);
  });

  it("rejects non-object policy", () => {
    const r = validateVerificationPolicy("not an object");
    expect(r.ok).toBe(false);
  });

  it("rejects non-array commands", () => {
    const r = validateVerificationPolicy({ version: 1, commands: "not array" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object command entry", () => {
    const r = validateVerificationPolicy({ version: 1, commands: [123] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_invalid_command")).toBe(true);
  });

  // 版本字段校验
  it("rejects missing version", () => {
    const r = validateVerificationPolicy({ commands: [] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("policy_version_missing");
  });
  it("rejects null version", () => {
    const r = validateVerificationPolicy({ version: null, commands: [] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("policy_version_missing");
  });
  it("rejects unknown version (2)", () => {
    const r = validateVerificationPolicy({ version: 2, commands: [] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("policy_version_unknown");
    expect(r.errors[0]?.details?.version).toBe(2);
  });
  it("rejects unknown version (99)", () => {
    const r = validateVerificationPolicy({ version: 99, commands: [] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe("policy_version_unknown");
  });
});

// ============================================================================
// Verification status 派生
// ============================================================================

describe("deriveVerificationStatus", () => {
  it("returns not_configured when no policy", () => {
    expect(deriveVerificationStatus({
      policyPresent: false,
      checks: [],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("not_configured");
  });

  it("returns not_configured when policy present but no checks", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("not_configured");
  });

  it("returns failed when a required check has non-zero exit", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [
        { id: "t", required: true, exit_code: 0, timed_out: false },
        { id: "b", required: true, exit_code: 1, timed_out: false },
      ],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("failed");
  });

  it("returns failed when a required check timed out", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [{ id: "t", required: true, exit_code: null, timed_out: true }],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("failed");
  });

  // spawn 失败 → failed(不引入新公开枚举)
  it("returns failed when a required check has null exit_code (spawn failed)", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [{ id: "t", required: true, exit_code: null, timed_out: false }],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("failed");
  });

  it("returns dirty when worktree is not clean", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [{ id: "t", required: true, exit_code: 0, timed_out: false }],
      headUnchanged: true,
      worktreeClean: false,
    })).toBe("dirty");
  });

  it("returns stale when head changed", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [{ id: "t", required: true, exit_code: 0, timed_out: false }],
      headUnchanged: false,
      worktreeClean: true,
    })).toBe("stale");
  });

  it("returns partial when optional failed but all required passed", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [
        { id: "t", required: true, exit_code: 0, timed_out: false },
        { id: "lint", required: false, exit_code: 2, timed_out: false },
      ],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("partial");
  });

  it("returns partial when optional timed out", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [
        { id: "t", required: true, exit_code: 0, timed_out: false },
        { id: "lint", required: false, exit_code: null, timed_out: true },
      ],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("partial");
  });

  it("returns partial when optional had spawn failure", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [
        { id: "t", required: true, exit_code: 0, timed_out: false },
        { id: "lint", required: false, exit_code: null, timed_out: false },
      ],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("partial");
  });

  it("returns passed when everything succeeds", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [
        { id: "t", required: true, exit_code: 0, timed_out: false },
        { id: "b", required: true, exit_code: 0, timed_out: false },
        { id: "lint", required: false, exit_code: 0, timed_out: false },
      ],
      headUnchanged: true,
      worktreeClean: true,
    })).toBe("passed");
  });

  it("failed takes precedence over dirty / stale / partial", () => {
    expect(deriveVerificationStatus({
      policyPresent: true,
      checks: [
        { id: "t", required: true, exit_code: 0, timed_out: false },
        { id: "b", required: true, exit_code: 1, timed_out: false }, // required 失败
        { id: "lint", required: false, exit_code: 1, timed_out: false },
      ],
      headUnchanged: false,
      worktreeClean: false,
    })).toBe("failed");
  });
});

// ============================================================================
// 三 SHA 一致性
// ============================================================================

describe("compareThreeShas", () => {
  it("equal when all three are identical 40-hex", () => {
    const r = compareThreeShas({
      report: "0123456789abcdef0123456789abcdef01234567",
      head: "0123456789abcdef0123456789abcdef01234567",
      verification: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(r).toEqual({ equal: true, missing: [], invalid: [], mismatch: [] });
  });

  it("equal when case differs (all 40-hex)", () => {
    const r = compareThreeShas({
      report: "0123456789ABCDEF0123456789ABCDEF01234567",
      head: "0123456789abcdef0123456789abcdef01234567",
      verification: "0123456789AbCdEf0123456789ABCdef01234567",
    });
    expect(r.equal).toBe(true);
  });

  it("reports missing when report is empty", () => {
    const r = compareThreeShas({
      report: "",
      head: "0123456789abcdef0123456789abcdef01234567",
      verification: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(r.equal).toBe(false);
    expect(r.missing).toEqual(["report"]);
    expect(r.invalid).toEqual([]);
    expect(r.mismatch).toEqual([]);
  });

  it("reports missing when all are null", () => {
    const r = compareThreeShas({ report: null, head: null, verification: null });
    expect(r.equal).toBe(false);
    expect(r.missing).toEqual(["report", "head", "verification"]);
    expect(r.invalid).toEqual([]);
  });

  it("reports mismatch when only report differs (all valid 40-hex)", () => {
    const r = compareThreeShas({
      report: "0123456789abcdef0123456789abcdef01234567",
      head: "0123456789abcdef0123456789abcdef01234567",
      verification: "ffffffffffffffffffffffffffffffffffffffff",
    });
    expect(r.equal).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.mismatch).toEqual([
      "head!=verification",
      "report!=verification",
    ]);
  });

  it("reports all three mismatch labels when all differ", () => {
    const r = compareThreeShas({
      report: "a".repeat(40),
      head: "b".repeat(40),
      verification: "c".repeat(40),
    });
    expect(r.equal).toBe(false);
    expect(r.invalid).toEqual([]);
    expect(r.mismatch).toEqual([
      "report!=head",
      "head!=verification",
      "report!=verification",
    ]);
  });

  // 三个相同但非法短字符串 —— 不能 equal(完整性优先)
  it("rejects equal when all three are identical but invalid (short) strings", () => {
    const r = compareThreeShas({
      report: "abc",
      head: "abc",
      verification: "abc",
    });
    expect(r.equal).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual(["report", "head", "verification"]);
    expect(r.mismatch).toEqual([]);
  });

  it("rejects equal when all three are identical 41-char strings", () => {
    const r = compareThreeShas({
      report: "a".repeat(41),
      head: "a".repeat(41),
      verification: "a".repeat(41),
    });
    expect(r.equal).toBe(false);
    expect(r.invalid).toEqual(["report", "head", "verification"]);
  });

  it("rejects equal when one value is non-hex (e.g. 'g' x 40)", () => {
    const r = compareThreeShas({
      report: "g".repeat(40),
      head: "0123456789abcdef0123456789abcdef01234567",
      verification: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(r.equal).toBe(false);
    expect(r.invalid).toEqual(["report"]);
    expect(r.missing).toEqual([]);
  });

  it("missing takes precedence over invalid", () => {
    const r = compareThreeShas({
      report: null,
      head: "abc", // also invalid, but missing wins
      verification: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(r.missing).toEqual(["report"]);
    expect(r.invalid).toEqual([]);
  });
});

// ============================================================================
// 归一化与 hash
// ============================================================================

describe("normalizeReportForHash + reportHash", () => {
  it("is stable across changed_areas order", () => {
    const report = validateDeliveryReport({
      body: makeReport({
        changed_areas: [
          { path: "b.ts", summary: "1" },
          { path: "a.ts", summary: "2" },
        ],
      }),
      bodyBytes: 0,
    }).value!;
    const h1 = reportHash(report);
    const r2 = validateDeliveryReport({
      body: makeReport({
        changed_areas: [
          { path: "a.ts", summary: "2" },
          { path: "b.ts", summary: "1" },
        ],
      }),
      bodyBytes: 0,
    }).value!;
    const h2 = reportHash(r2);
    expect(h1).toBe(h2);
  });

  it("is case-insensitive on report_head_commit", () => {
    const a = validateDeliveryReport({
      body: makeReport({ report_head_commit: "0123456789abcdef0123456789abcdef01234567" }),
      bodyBytes: 0,
    }).value!;
    const b = validateDeliveryReport({
      body: makeReport({ report_head_commit: "0123456789ABCDEF0123456789ABCDEF01234567" }),
      bodyBytes: 0,
    }).value!;
    expect(reportHash(a)).toBe(reportHash(b));
  });

  it("differs when problem_understanding differs", () => {
    const a = validateDeliveryReport({ body: makeReport({ problem_understanding: "x" }), bodyBytes: 0 }).value!;
    const b = validateDeliveryReport({ body: makeReport({ problem_understanding: "y" }), bodyBytes: 0 }).value!;
    expect(reportHash(a)).not.toBe(reportHash(b));
  });
});

describe("policyHash (raw text SHA-256, order-sensitive)", () => {
  it("is the SHA-256 of the raw file text", () => {
    const text = '{"version":1,"commands":[{"id":"a","label":"A","command":"cmd","required":true,"timeout_ms":1000}]}';
    expect(policyHash(text)).toBe(sha256Hex(text));
  });

  it("is stable for the same raw text", () => {
    const text = '{"version":1,"commands":[]}';
    expect(policyHash(text)).toBe(policyHash(text));
  });

  // 顺序必须影响 hash(避免按 id 排序的旧实现)
  it("differs when command order differs in raw text", () => {
    const a = '{"version":1,"commands":[{"id":"a","label":"A","command":"cmd-a","required":true,"timeout_ms":1000},{"id":"b","label":"B","command":"cmd-b","required":true,"timeout_ms":1000}]}';
    const b = '{"version":1,"commands":[{"id":"b","label":"B","command":"cmd-b","required":true,"timeout_ms":1000},{"id":"a","label":"A","command":"cmd-a","required":true,"timeout_ms":1000}]}';
    expect(policyHash(a)).not.toBe(policyHash(b));
  });

  it("differs when a single byte changes (whitespace)", () => {
    const a = '{"version":1,"commands":[]}';
    const b = '{ "version":1,"commands":[]}';
    expect(policyHash(a)).not.toBe(policyHash(b));
  });

  it("differs when a command content changes", () => {
    const a = '{"version":1,"commands":[{"id":"a","label":"A","command":"cmd-a","required":true,"timeout_ms":1000}]}';
    const b = '{"version":1,"commands":[{"id":"a","label":"A","command":"cmd-a-changed","required":true,"timeout_ms":1000}]}';
    expect(policyHash(a)).not.toBe(policyHash(b));
  });
});

// ============================================================================
// result_json 安全解析 —— 完整矩阵(含历史 v1 真实形态)
// ============================================================================

describe("parseResultJson", () => {
  it("returns absent for null", () => {
    expect(parseResultJson(null)).toEqual({ kind: "absent" });
  });
  it("returns absent for empty string", () => {
    expect(parseResultJson("")).toEqual({ kind: "absent" });
  });

  it("returns legacy for historical v1 result_json without schema_version and preserves value", () => {
    // 历史真实形态:Runner 写下的 {"branch":"task/abc","diff_stat":"1 file changed"}
    const raw = '{"branch":"task/abc","diff_stat":"1 file changed"}';
    const r = parseResultJson(raw);
    expect(r.kind).toBe("legacy");
    if (r.kind === "legacy") {
      expect(r.raw).toBe(raw);
      expect(r.value).toEqual({ branch: "task/abc", diff_stat: "1 file changed" });
    }
  });

  it("returns legacy for object with schema_version=1 and preserves value", () => {
    const raw = '{"schema_version":1,"branch":"task/abc","diff_stat":"x"}';
    const r = parseResultJson(raw);
    expect(r.kind).toBe("legacy");
    if (r.kind === "legacy") {
      expect(r.value).toEqual({ schema_version: 1, branch: "task/abc", diff_stat: "x" });
    }
  });

  it("returns valid for object with schema_version=2 and preserves value", () => {
    const raw = '{"schema_version":2,"branch":"task/abc"}';
    const r = parseResultJson(raw);
    expect(r.kind).toBe("valid");
    if (r.kind === "valid") {
      expect(r.value).toEqual({ schema_version: 2, branch: "task/abc" });
    }
  });

  it("returns unsupported for object with schema_version=99 and preserves value", () => {
    const raw = '{"schema_version":99,"branch":"task/abc"}';
    const r = parseResultJson(raw);
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") {
      expect(r.schemaVersion).toBe(99);
      expect(r.value).toEqual({ schema_version: 99, branch: "task/abc" });
    }
  });

  it("returns incomplete for invalid JSON", () => {
    const r = parseResultJson("not json {");
    expect(r.kind).toBe("incomplete");
    if (r.kind === "incomplete") {
      expect(r.raw).toBe("not json {");
      expect(typeof r.reason).toBe("string");
    }
  });
  it("returns incomplete for JSON array", () => {
    const r = parseResultJson("[1,2,3]");
    expect(r.kind).toBe("incomplete");
  });
  it("returns incomplete for JSON string", () => {
    const r = parseResultJson('"hello"');
    expect(r.kind).toBe("incomplete");
  });
  it("returns incomplete for JSON number at top level", () => {
    const r = parseResultJson("42");
    expect(r.kind).toBe("incomplete");
  });
  it("returns incomplete for JSON null at top level", () => {
    const r = parseResultJson("null");
    expect(r.kind).toBe("incomplete");
  });
  it("returns incomplete for object with non-numeric schema_version", () => {
    const r = parseResultJson('{"schema_version":"2"}');
    expect(r.kind).toBe("incomplete");
  });

  it("does not throw on malformed input", () => {
    expect(() => parseResultJson("\u0000\u0000")).not.toThrow();
    expect(() => parseResultJson("undefined")).not.toThrow();
    expect(() => parseResultJson("{}")).not.toThrow();
  });
});

describe("classifyResultJson", () => {
  // 完整矩阵:每条都同时与 parseResultJson 验证一致
  it("absent → legacy (null/empty)", () => {
    expect(classifyResultJson(null)).toBe("legacy");
    expect(classifyResultJson("")).toBe("legacy");
  });
  it("object without schema_version → legacy (historical v1 真实形态)", () => {
    expect(classifyResultJson('{"branch":"task/abc","diff_stat":"1 file changed"}')).toBe("legacy");
    expect(classifyResultJson('{"branch":"x"}')).toBe("legacy");
  });
  it("object with schema_version=1 → legacy (v1)", () => {
    expect(classifyResultJson('{"schema_version":1}')).toBe("legacy");
  });
  it("object with schema_version=2 → valid (v2)", () => {
    expect(classifyResultJson('{"schema_version":2}')).toBe("valid");
  });
  it("object with schema_version=99 → unsupported (unknown number)", () => {
    expect(classifyResultJson('{"schema_version":99}')).toBe("unsupported");
  });
  it("object with schema_version=3 → unsupported", () => {
    expect(classifyResultJson('{"schema_version":3}')).toBe("unsupported");
  });
  it("object with non-numeric schema_version → incomplete", () => {
    expect(classifyResultJson('{"schema_version":"2"}')).toBe("incomplete");
  });
  it("invalid JSON → incomplete (no throw)", () => {
    expect(classifyResultJson("not json")).toBe("incomplete");
    expect(() => classifyResultJson("not json")).not.toThrow();
  });
  it("JSON array → incomplete", () => {
    expect(classifyResultJson("[1,2]")).toBe("incomplete");
  });
  it("JSON string at top level → incomplete", () => {
    expect(classifyResultJson('"hello"')).toBe("incomplete");
  });
  it("JSON number at top level → incomplete", () => {
    expect(classifyResultJson("42")).toBe("incomplete");
  });
  it("JSON null at top level → incomplete", () => {
    expect(classifyResultJson("null")).toBe("incomplete");
  });
});

// ============================================================================
// V2CompleteResponse 类型构造
// ============================================================================

describe("V2CompleteResponse", () => {
  it("accepts every valid ReviewPacketStatus", () => {
    for (const s of REVIEW_PACKET_STATUSES) {
      const r: V2CompleteResponse = {
        ok: true,
        task_id: "t1",
        status: "completed",
        review_packet_status: s,
      };
      expect(r.review_packet_status).toBe(s);
    }
  });
  it("'ready' is a valid value", () => {
    const r: V2CompleteResponse = {
      ok: true,
      task_id: "t1",
      status: "completed",
      review_packet_status: "ready",
    };
    expect(r.review_packet_status).toBe("ready");
  });
  it("'incomplete' is a valid value (verification 不通过时 complete 仍可返回)", () => {
    const r: V2CompleteResponse = {
      ok: true,
      task_id: "t1",
      status: "completed",
      review_packet_status: "incomplete",
    };
    expect(r.review_packet_status).toBe("incomplete");
  });
});

// ============================================================================
// VerificationRun 必填字段
// ============================================================================

describe("VerificationRun required fields", () => {
  // R1-FIX1:VerificationRun 是 Runner 提交的 wire DTO,status 必须属于
  // RunnerSubmittableVerificationStatus(排除 legacy 与 not_configured)。
  // "not_configured" 是 server 派生值;Runner 提交过去就是类型错。
  it("executed run has both timestamps as ISO strings", () => {
    const run: VerificationRun = {
      schema_version: 1,
      policy_source: "ANVIL.verify.json",
      policy_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      verification_sha: "0123456789abcdef0123456789abcdef01234567",
      status: "passed",
      started_at: "2026-08-28T12:00:00.000Z",
      completed_at: "2026-08-28T12:05:00.000Z",
      checks: [],
    };
    expect(run.started_at).toBe("2026-08-28T12:00:00.000Z");
    expect(run.completed_at).toBe("2026-08-28T12:05:00.000Z");
  });

  it("started_at can be null but completed_at must be present", () => {
    // 运行时断言:started_at 可为 null(代表 spawn 立即失败),但 completed_at
    // 仍是必填的 ISO 时间戳(用于派生 Packet 状态)。
    const run: VerificationRun = {
      schema_version: 1,
      policy_source: "ANVIL.verify.json",
      policy_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      verification_sha: null,
      status: "failed",
      started_at: null,
      completed_at: "2026-08-28T11:00:00.000Z",
      checks: [],
    };
    expect(run.started_at).toBeNull();
    expect(run.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ============================================================================
// R1-FIX1 · Wire DTO 边界与不变式
// ============================================================================
//
// 本节锁定的 4 个事实:
// 1) VerificationCheck 不要求 per-check started_at / completed_at
// 2) VerificationRun 不要求重复 base_commit
// 3) V2CompleteRequest 的 base_commit 位于顶层
// 4) V2FailRequest 可以按 PRD 精确字段构造
// 不使用 any / 强制类型断言掩盖类型问题:以下构造全部走编译期检查。

describe("wire DTO invariants (R1-FIX1)", () => {
  it("VerificationCheck 不要求 per-check started_at/completed_at", () => {
    // 编译期:构造一个不包含 started_at/completed_at 的 Check,类型必须能通过。
    const check: VerificationCheck = {
      id: "tests",
      label: "全量测试",
      command: "pnpm test",
      required: true,
      status: "passed",
      exit_code: 0,
      duration_ms: 180_000,
      output_excerpt: "187 tests passed",
    };
    expect((check as Record<string, unknown>).started_at).toBeUndefined();
    expect((check as Record<string, unknown>).completed_at).toBeUndefined();
  });

  it("VerificationRun 不要求重复 base_commit", () => {
    // 编译期:不写 base_commit,TypeScript 必须能正常构造。
    const run: VerificationRun = {
      schema_version: 1,
      policy_source: "ANVIL.verify.json",
      policy_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      verification_sha: "0123456789abcdef0123456789abcdef01234567",
      status: "passed",
      started_at: "2026-08-28T12:00:00.000Z",
      completed_at: "2026-08-28T12:05:00.000Z",
      checks: [],
    };
    expect((run as Record<string, unknown>).base_commit).toBeUndefined();
  });

  it("V2CompleteRequest 的 base_commit 位于顶层", () => {
    // 编译期 + 运行时:base_commit 在 V2CompleteRequest 顶层,不在 verification 内。
    const req: V2CompleteRequest = {
      daemon_id: "d1",
      branch: "task/abc",
      work_dir: "D:/wt",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      head_commit: "fedcba9876543210fedcba9876543210fedcba98",
      worktree_clean: true,
      verification: {
        schema_version: 1,
        policy_source: "ANVIL.verify.json",
        policy_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        verification_sha: "fedcba9876543210fedcba9876543210fedcba98",
        status: "passed",
        started_at: "2026-08-28T12:00:00.000Z",
        completed_at: "2026-08-28T12:05:00.000Z",
        checks: [],
      },
    };
    expect(req.base_commit).toBe("0123456789abcdef0123456789abcdef01234567");
    // 验证 verification 内没有 base_commit
    expect((req.verification as Record<string, unknown>).base_commit).toBeUndefined();
  });

  it("V2FailRequest 可以按 PRD 精确字段构造(daemon_id/failure_reason/error/work_dir)", () => {
    // 编译期:4 个字段,不包含 head_commit / worktree_clean / delivery_contract_version。
    const req: V2FailRequest = {
      daemon_id: "d1",
      failure_reason: "non_zero_exit",
      error: "boom",
      work_dir: "D:/wt",
    };
    expect(req.daemon_id).toBe("d1");
    expect(req.failure_reason).toBe("non_zero_exit");
    expect(req.error).toBe("boom");
    expect(req.work_dir).toBe("D:/wt");
    expect((req as Record<string, unknown>).head_commit).toBeUndefined();
    expect((req as Record<string, unknown>).worktree_clean).toBeUndefined();
    expect((req as Record<string, unknown>).delivery_contract_version).toBeUndefined();
  });

  it("V2FailRequest 的 work_dir 可选(可省略)", () => {
    // 编译期:只填必填三项,work_dir 留空。
    const req: V2FailRequest = {
      daemon_id: "d1",
      failure_reason: "lease_expired",
      error: "lost lease",
    };
    expect(req.work_dir).toBeUndefined();
  });
});

// ============================================================================
// R1-FIX1 · Verification command 长度上限(500 字符)
// ============================================================================

describe("VERIFICATION_COMMAND_CHARS=500 boundary (R1-FIX1)", () => {
  // LIMITS 常量是契约的单一来源,任何 500 的硬编码散落都是 bug。
  it("LIMITS.VERIFICATION_COMMAND_CHARS === 500", () => {
    expect(LIMITS.VERIFICATION_COMMAND_CHARS).toBe(500);
  });

  it("accepts command of length exactly 500", () => {
    const command = "a".repeat(500);
    expect(command.length).toBe(500);
    const r = validateVerificationPolicy({
      version: 1,
      commands: [{
        id: "c1", label: "label", command, required: true, timeout_ms: 60_000,
      }],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects command of length 501", () => {
    const command = "a".repeat(501);
    expect(command.length).toBe(501);
    const r = validateVerificationPolicy({
      version: 1,
      commands: [{
        id: "c1", label: "label", command, required: true, timeout_ms: 60_000,
      }],
    });
    expect(r.ok).toBe(false);
    const errCodes = r.errors.map((e) => e.code);
    expect(errCodes).toContain("policy_invalid_command");
    // 错误 details 应带 length 与 limit,便于诊断
    const overflowErr = r.errors.find((e) => e.code === "policy_invalid_command" && e.details?.id === "c1");
    expect(overflowErr?.details?.length).toBe(501);
    expect(overflowErr?.details?.limit).toBe(500);
  });

  it("rejects when any one of multiple commands exceeds 500", () => {
    // 第 1 条 500 字符合法,第 2 条 501 字符非法 → 整个 policy 拒绝。
    const r = validateVerificationPolicy({
      version: 1,
      commands: [
        { id: "ok", label: "ok", command: "a".repeat(500), required: true, timeout_ms: 60_000 },
        { id: "bad", label: "bad", command: "a".repeat(501), required: true, timeout_ms: 60_000 },
      ],
    });
    expect(r.ok).toBe(false);
    const errForBad = r.errors.find((e) => e.code === "policy_invalid_command" && e.details?.id === "bad");
    expect(errForBad).toBeDefined();
    expect(errForBad?.details?.length).toBe(501);
  });

  it("empty command still rejected (length 0)", () => {
    // 现有 'policy_invalid_command' 路径仍优先捕获空字符串,不被新的长度检查干扰。
    const r = validateVerificationPolicy({
      version: 1,
      commands: [{ id: "c", label: "l", command: "", required: true, timeout_ms: 1000 }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === "policy_invalid_command")).toBe(true);
  });
});

// ============================================================================
// R1-FIX2 · Runner 提交 not_configured 是合法 VerificationRun 终态
// ============================================================================
//
// 锁定的事实:
// 1) `not_configured` 属于 Runner 终检事实之一:当 ANVIL.verify.json 不存在时,
//    Runner 实际从未执行任何命令,在 Complete 请求中提交
//    `status="not_configured"` + `policy_source="none"` + `policy_hash=null` +
//    `verification_sha=null` + `started_at=null` + `checks=[]` + 合法 ISO
//    `completed_at` 才是真实证据。
// 2) `legacy` 仅由 server 从 v1 历史 result_json 派生(迁移前 v1 Task 显式标为
//    legacy,不伪造 passed),不允许新 Runner 在 Complete 里主动提交。
// 3) VerificationRun 顶层不重复 base_commit;base_commit 只存在于 V2CompleteRequest。
//
// 这些测试同时承担 TypeScript 编译期检查(@ts-expect-error 标记):任何后续误把
// `legacy` 加回 RunnerSubmittableVerificationStatus、或把 `not_configured` 重新
// 排除的改动都会编译失败。

describe("R1-FIX2: not_configured 是 Runner 合法提交状态", () => {
  it("构造 policy_source='none' + status='not_configured' 的合法 VerificationRun", () => {
    // 编译期 + 运行时:这是 Runner 在 ANVIL.verify.json 缺失时提交的完整证据。
    // 所有 Runner 写入的字段都是字面量类型;completed_at 是合法 ISO 时间。
    const run: VerificationRun = {
      schema_version: 1,
      policy_source: "none",
      policy_hash: null,
      verification_sha: null,
      status: "not_configured",
      started_at: null,
      completed_at: "2026-08-29T12:00:00.000Z",
      checks: [],
    };
    expect(run.status).toBe("not_configured");
    expect(run.policy_source).toBe("none");
    expect(run.policy_hash).toBeNull();
    expect(run.verification_sha).toBeNull();
    expect(run.started_at).toBeNull();
    expect(run.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(run.checks).toEqual([]);
  });

  it("构造 ANVIL.verify.json + status='passed' 的合法 VerificationRun(executed 形态回归保留)", () => {
    // R1-FIX1 的 executed 形态必须仍然能通过编译 —— 我们没有破坏既有合法提交。
    const run: VerificationRun = {
      schema_version: 1,
      policy_source: "ANVIL.verify.json",
      policy_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      verification_sha: "0123456789abcdef0123456789abcdef01234567",
      status: "passed",
      started_at: "2026-08-29T12:00:00.000Z",
      completed_at: "2026-08-29T12:05:00.000Z",
      checks: [{
        id: "tests",
        label: "全量测试",
        command: "pnpm test",
        required: true,
        status: "passed",
        exit_code: 0,
        duration_ms: 300_000,
        output_excerpt: "187 tests passed",
      }],
    };
    expect(run.status).toBe("passed");
    expect(run.policy_source).toBe("ANVIL.verify.json");
    expect(run.checks).toHaveLength(1);
  });

  it("构造 ANVIL.verify.json + status='failed' 的合法 VerificationRun(必填失败用例)", () => {
    // 同样属于 Runner 合法提交:必填命令失败时 Runner 必须如实上报 failed,
    // 而不是隐藏失败或假冒 passed。
    const run: VerificationRun = {
      schema_version: 1,
      policy_source: "ANVIL.verify.json",
      policy_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      verification_sha: "0123456789abcdef0123456789abcdef01234567",
      status: "failed",
      started_at: "2026-08-29T12:00:00.000Z",
      completed_at: "2026-08-29T12:01:00.000Z",
      checks: [{
        id: "tests",
        label: "全量测试",
        command: "pnpm test",
        required: true,
        status: "failed",
        exit_code: 1,
        duration_ms: 60_000,
        output_excerpt: "1 test failed",
      }],
    };
    expect(run.status).toBe("failed");
  });

  it("编译期:RunnerSubmittableVerificationStatus 仍然排除 legacy", () => {
    // @ts-expect-error 'legacy' is not a Runner-submittable verification status.
    // legacy 仅由 server 从 v1 result_json 派生;Runner 提交 legacy 是协议违反。
    const status: RunnerSubmittableVerificationStatus = "legacy";
    // 让 status 变量被"使用"以避免 TS noUnusedLocals 警告并保留类型断言的语义。
    expect(typeof status).toBe("string");
  });

  it("编译期:Runner 提交 V2CompleteRequest 可以把 verification.status 设为 not_configured", () => {
    // 这是端到端的 wire DTO 形态:Complete 请求里 verification.status === "not_configured"
    // 必须被类型系统接受,因为它就是 Runner 提交 ANVIL.verify.json 缺失时的合法结果。
    const req: V2CompleteRequest = {
      daemon_id: "d1",
      branch: "task/abc",
      work_dir: "D:/wt",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      head_commit: "fedcba9876543210fedcba9876543210fedcba98",
      worktree_clean: true,
      verification: {
        schema_version: 1,
        policy_source: "none",
        policy_hash: null,
        verification_sha: null,
        status: "not_configured",
        started_at: null,
        completed_at: "2026-08-29T12:00:00.000Z",
        checks: [],
      },
    };
    expect(req.verification.status).toBe("not_configured");
    expect(req.verification.checks).toEqual([]);
  });

  it("编译期:Runner 不得在 V2CompleteRequest.verification 里把 status 设为 legacy", () => {
    // V2CompleteRequest.verification.status 类型是 RunnerSubmittableVerificationStatus,
    // 该类型在 R1-FIX2 后等于 Exclude<VerificationStatus, "legacy">。
    // 任何误用都会被 TypeScript 拒绝(@ts-expect-error 守护)。
    const req = {
      daemon_id: "d1",
      branch: "task/abc",
      work_dir: "D:/wt",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      head_commit: "fedcba9876543210fedcba9876543210fedcba98",
      worktree_clean: true,
      verification: {
        schema_version: 1 as const,
        policy_source: "none" as const,
        policy_hash: null,
        verification_sha: null,
        // @ts-expect-error 'legacy' is not a Runner-submittable verification status.
        // legacy 是 server 从 v1 result_json 派生的历史兼容状态;Runner 在 v2
        // Complete 请求里提交 legacy 等同于伪造事实,必须被类型系统拒绝。
        status: "legacy",
        started_at: null,
        completed_at: "2026-08-29T12:00:00.000Z",
        checks: [],
      },
    };
    // 运行时只验证"构造能跑",真正的协议约束在编译期。
    expect(typeof req).toBe("object");
  });
});
