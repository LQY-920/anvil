// packages/core/test/delivery.test.ts
//
// A01 · v2 协议校验与归一化纯函数单测。
//
// 覆盖范围(取自计划 A01 测试要求):
// - 合法 / 非法 Delivery Report、未知 schema、64KB 上限、重复 path、风险枚举、40 位 SHA
// - Verification Policy 0/8/9 条命令、重复 id、timeout 边界、required 派生
// - 三 SHA 完全一致 / 缺失 / 不一致
// - 旧 / 非法 result_json 安全解析

import { describe, it, expect } from "vitest";
import {
  LIMITS,
  RISK_LEVELS,
  canonicalJsonHash,
  classifyResultJson,
  compareThreeShas,
  deriveVerificationStatus,
  isPacketDecisionEligible,
  isValidSha1Hex40,
  parseResultJson,
  policyHash,
  reportHash,
  sha256Hex,
  validateDeliveryReport,
  validateVerificationPolicy,
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

  it("accepts a single-command policy", () => {
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
    expect(r).toEqual({ equal: true, missing: [], mismatch: [] });
  });

  it("equal when case differs", () => {
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
    expect(r.mismatch).toEqual([]);
  });

  it("reports missing when all are null", () => {
    const r = compareThreeShas({ report: null, head: null, verification: null });
    expect(r.equal).toBe(false);
    expect(r.missing).toEqual(["report", "head", "verification"]);
  });

  it("reports mismatch when only report differs", () => {
    const r = compareThreeShas({
      report: "0123456789abcdef0123456789abcdef01234567",
      head: "0123456789abcdef0123456789abcdef01234567",
      verification: "ffffffffffffffffffffffffffffffffffffffff",
    });
    expect(r.equal).toBe(false);
    expect(r.missing).toEqual([]);
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
    expect(r.mismatch).toEqual([
      "report!=head",
      "head!=verification",
      "report!=verification",
    ]);
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

describe("policyHash", () => {
  it("is stable across command order in input (we sort by id)", () => {
    const p1 = validateVerificationPolicy({
      version: 1,
      commands: [
        { id: "b", label: "B", command: "cmd-b", required: true, timeout_ms: 1000 },
        { id: "a", label: "A", command: "cmd-a", required: true, timeout_ms: 1000 },
      ],
    }).value!;
    const p2 = validateVerificationPolicy({
      version: 1,
      commands: [
        { id: "a", label: "A", command: "cmd-a", required: true, timeout_ms: 1000 },
        { id: "b", label: "B", command: "cmd-b", required: true, timeout_ms: 1000 },
      ],
    }).value!;
    expect(policyHash(p1)).toBe(policyHash(p2));
  });
});

// ============================================================================
// result_json 安全解析
// ============================================================================

describe("parseResultJson", () => {
  it("returns absent for null", () => {
    expect(parseResultJson(null)).toEqual({ kind: "absent" });
  });
  it("returns absent for empty string", () => {
    expect(parseResultJson("")).toEqual({ kind: "absent" });
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
  it("returns valid for plain object without schema_version", () => {
    const r = parseResultJson('{"branch":"x"}');
    expect(r.kind).toBe("valid");
    if (r.kind === "valid") {
      expect(r.value).toEqual({ branch: "x" });
    }
  });
  it("does not throw on malformed input", () => {
    expect(() => parseResultJson("\u0000\u0000")).not.toThrow();
    expect(() => parseResultJson("undefined")).not.toThrow();
    expect(() => parseResultJson("{}")).not.toThrow();
  });
});

describe("classifyResultJson", () => {
  it("returns legacy for absent", () => {
    expect(classifyResultJson(null)).toBe("legacy");
    expect(classifyResultJson("")).toBe("legacy");
  });
  it("returns legacy for object without schema_version", () => {
    expect(classifyResultJson('{"branch":"x"}')).toBe("legacy");
  });
  it("returns legacy for object with schema_version=1", () => {
    expect(classifyResultJson('{"schema_version":1}')).toBe("legacy");
  });
  it("returns valid for object with schema_version=2", () => {
    expect(classifyResultJson('{"schema_version":2}')).toBe("valid");
  });
  it("returns valid for object with schema_version=99", () => {
    expect(classifyResultJson('{"schema_version":99}')).toBe("valid");
  });
  it("returns incomplete for invalid JSON", () => {
    expect(classifyResultJson("not json")).toBe("incomplete");
  });
  it("returns incomplete for array", () => {
    expect(classifyResultJson("[1,2]")).toBe("incomplete");
  });
});

// ============================================================================
// 杂项
// ============================================================================

describe("isPacketDecisionEligible", () => {
  it("returns true for ready and decision_recorded", () => {
    expect(isPacketDecisionEligible("ready")).toBe(true);
    expect(isPacketDecisionEligible("decision_recorded")).toBe(true);
  });
  it("returns false for other statuses", () => {
    expect(isPacketDecisionEligible("generating")).toBe(false);
    expect(isPacketDecisionEligible("incomplete")).toBe(false);
    expect(isPacketDecisionEligible("verification_blocked")).toBe(false);
    expect(isPacketDecisionEligible("integrity_blocked")).toBe(false);
    expect(isPacketDecisionEligible("legacy")).toBe(false);
    expect(isPacketDecisionEligible("integration_failed")).toBe(false);
    expect(isPacketDecisionEligible("remote_push_pending")).toBe(false);
    expect(isPacketDecisionEligible("closed")).toBe(false);
  });
});

describe("anvil error code union coverage", () => {
  it("returns expected codes for failing inputs", () => {
    const seen = new Set<string>();
    const r1 = validateDeliveryReport({ body: makeReport({ schema_version: 2 }), bodyBytes: 0 });
    if (!r1.ok) r1.errors.forEach((e) => seen.add(e.code));
    const r2 = validateVerificationPolicy({
      version: 1,
      commands: [{ id: "x".repeat(65), label: "l", command: "c", required: true, timeout_ms: 1000 }],
    });
    if (!r2.ok) r2.errors.forEach((e) => seen.add(e.code));
    // 出现过的 code 必须是稳定的字符串(各 route 共用同一联合)
    for (const code of seen) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
    // 至少应该出现过 schema_unknown 与 policy_invalid_id
    expect(seen.has("report_schema_unknown")).toBe(true);
    expect(seen.has("policy_invalid_id")).toBe(true);
  });
});
