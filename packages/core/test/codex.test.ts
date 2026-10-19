import { describe, expect, it } from "vitest";
import {
  capabilitiesFromCodexHelp,
  classifyCodexResult,
  emptyCodexParseState,
  parseCodexLine,
  rejectReservedProfileFields,
} from "../src/codex.js";

describe("codex jsonl", () => {
  it("reads thread id and does not treat an unknown event as success", () => {
    const state = emptyCodexParseState();
    expect(parseCodexLine('{"type":"thread.started","thread_id":"thread-1"}\r', state)?.type).toBe("status");
    expect(state.sessionRef).toBe("thread-1");
    expect(parseCodexLine('{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}', state)?.content).toBe("pong");
    expect(parseCodexLine('{"type":"mystery"}', state)?.content).toContain("unknown");
    expect(parseCodexLine('{"type":"turn.completed"}', state)?.content).toBe("turn.completed");
    expect(classifyCodexResult(state, 0).status).toBe("completed");
  });

  it("fails closed when exit 0 has no completed turn", () => {
    const state = emptyCodexParseState();
    parseCodexLine('{"type":"turn.started"}', state);
    expect(classifyCodexResult(state, 0)).toMatchObject({ status: "failed", error: "protocol_error" });
  });

  it("maps the captured 0.147.0 failure stream to protocol_error", () => {
    const state = emptyCodexParseState();
    const lines = [
      '{"type":"thread.started","thread_id":"thread-probe"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"model metadata missing"}}',
      '{"type":"turn.started"}',
      '{"type":"error","message":"model is not supported"}',
      '{"type":"turn.failed","error":{"message":"model is not supported"}}',
    ];
    for (const line of lines) parseCodexLine(line, state);
    expect(state.sessionRef).toBe("thread-probe");
    expect(classifyCodexResult(state, 1)).toMatchObject({ status: "failed", error: "protocol_error" });
  });

  it("rejects broken json and approval errors", () => {
    const broken = emptyCodexParseState();
    expect(parseCodexLine("not-json", broken)?.type).toBe("error");
    expect(classifyCodexResult(broken, 0).error).toBe("protocol_error");
    const approval = emptyCodexParseState();
    parseCodexLine('{"type":"error","message":"approval required"}', approval);
    expect(classifyCodexResult(approval, 1).error).toBe("approval_blocked");
  });

  it("does not treat version success as full capability", () => {
    expect(capabilitiesFromCodexHelp("usage only", "usage only")).toEqual({
      stream: false, resume: false, structured_report: false, cancel: false,
    });
    expect(capabilitiesFromCodexHelp("use --json and --output-schema", "resume SESSION_ID")).toMatchObject({
      stream: true, resume: true, structured_report: true, cancel: true,
    });
  });

  it("rejects profile fields that belong to the platform", () => {
    expect(rejectReservedProfileFields({ executable: "codex" })).toBeNull();
    expect(rejectReservedProfileFields({ "--last": true })).toMatch(/保留参数/);
  });
});
