import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexArgs, createCodexBackend } from "../src/agents/codex.js";
import type { AgentMessage } from "@anvil/core";

const fakeCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "testing", "fake-cli.mjs");

describe("codex adapter", () => {
  it("uses an explicit session id and never resume --last", () => {
    const fresh = buildCodexArgs({ prompt: "do it", sandbox: "workspace-write" });
    expect(fresh).toEqual(["exec", "--json", "--color", "never", "--sandbox", "workspace-write", "do it"]);
    expect(fresh).not.toContain("--last");
    const resumed = buildCodexArgs({ prompt: "continue", sessionRef: "thread-9", outputLastMessagePath: "last.json", outputSchemaPath: "schema.json" });
    expect(resumed).toContain("resume");
    expect(resumed).toContain("thread-9");
    expect(resumed).not.toContain("--last");
    expect(resumed).not.toContain("--all");
    const resumeAt = resumed.indexOf("resume");
    expect(resumed[resumeAt + 1]).toBe("thread-9");
  });

  it("does not treat exit 0 without a completed turn as success", async () => {
    const backend = createCodexBackend({ command: process.execPath, argsPrefix: [fakeCli] });
    const lines = JSON.stringify([
      { delay_ms: 1, line: JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) },
      { delay_ms: 1, line: JSON.stringify({ type: "turn.started" }) },
    ]);
    const session = backend.execute({
      workDir: process.cwd(),
      env: { ...process.env, FAKE_CLI_LINES: lines, FAKE_CLI_EXIT: "0" } as Record<string, string>,
      prompt: "test",
      resume: false,
      idleTimeoutMs: 5000,
    });
    const msgs: AgentMessage[] = [];
    for await (const message of session.messages) msgs.push(message);
    const result = await session.result;
    expect(msgs.some((message) => message.content === "thread.started")).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("protocol_error");
    expect(result.sessionRef).toBe("thread-1");
  });
});
