import { describe, it, expect } from "vitest";
import {
  ISSUE_STATUSES, TASK_STATUSES, MESSAGE_TYPES, FAILURE_REASONS,
  parseAgentLine, priorityWeight,
} from "../src/index.js";

describe("enums", () => {
  it("has spec-defined values", () => {
    expect(ISSUE_STATUSES).toEqual(["backlog","todo","in_progress","in_review","done","blocked","cancelled"]);
    expect(TASK_STATUSES).toEqual(["queued","dispatched","running","completed","failed","cancelled"]);
    expect(MESSAGE_TYPES).toEqual(["text","thinking","tool_use","tool_result","status","error","log"]);
    expect(FAILURE_REASONS).toEqual(["runtime_offline","idle_timeout","spawn_failed","non_zero_exit","lease_expired","cancelled_by_user"]);
  });
  it("priorityWeight maps each priority to its exact weight", () => {
    expect(priorityWeight("urgent")).toBe(40);
    expect(priorityWeight("high")).toBe(30);
    expect(priorityWeight("medium")).toBe(20);
    expect(priorityWeight("low")).toBe(10);
    expect(priorityWeight("none")).toBe(0);
  });
});

describe("parseAgentLine", () => {
  it("parses assistant text", () => {
    const m = parseAgentLine(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "hi" }] }));
    expect(m).toEqual({ type: "text", content: "hi" });
  });
  it("parses assistant tool_calls", () => {
    const m = parseAgentLine(JSON.stringify({ role: "assistant", tool_calls: [{ name: "Bash", input: { cmd: "ls" } }] }));
    expect(m).toEqual({ type: "tool_use", tool: "Bash", input: { cmd: "ls" } });
  });
  it("parses tool result", () => {
    const m = parseAgentLine(JSON.stringify({ role: "tool", name: "Bash", content: "file.txt" }));
    expect(m).toEqual({ type: "tool_result", tool: "Bash", output: "file.txt" });
  });
  it("wraps unparseable line as log", () => {
    expect(parseAgentLine("not json at all")).toEqual({ type: "log", content: "not json at all" });
  });
  it("returns null for empty line", () => {
    expect(parseAgentLine("   ")).toBeNull();
  });
});
