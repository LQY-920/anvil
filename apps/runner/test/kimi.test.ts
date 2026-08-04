import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildKimiArgs, createKimiBackend } from "../src/agents/kimi.js";
import type { AgentMessage } from "@anvil/core";

const fakeCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "testing", "fake-cli.mjs");

describe("kimi adapter", () => {
  it("builds args per kimi headless protocol", () => {
    const args = buildKimiArgs({ prompt: "do it", resume: false });
    expect(args).toEqual(["-p", "do it", "--output-format", "stream-json"]);
    const resumed = buildKimiArgs({ prompt: "do it", resume: true });
    expect(resumed).toContain("-c");
  });

  it("streams kimi-shaped stream-json lines via fake cli", async () => {
    const backend = createKimiBackend({ command: process.execPath, argsPrefix: [fakeCli] });
    const lines = JSON.stringify([
      { delay_ms: 10, line: JSON.stringify({ role: "assistant", tool_calls: [{ name: "Bash", input: { command: "ls" } }] }) },
      { delay_ms: 10, line: JSON.stringify({ role: "tool", name: "Bash", content: "a.txt" }) },
      { delay_ms: 10, line: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "done" }] }) },
    ]);
    const session = backend.execute({
      workDir: process.cwd(),
      env: { ...process.env, FAKE_CLI_LINES: lines, FAKE_CLI_EXIT: "0" } as Record<string, string>,
      prompt: "test",
      resume: false,
      idleTimeoutMs: 5000,
    });
    const msgs: AgentMessage[] = [];
    for await (const m of session.messages) msgs.push(m);
    const result = await session.result;
    expect(msgs.map((m) => m.type)).toEqual(["tool_use", "tool_result", "text"]);
    expect(msgs[0].tool).toBe("Bash");
    expect(result.status).toBe("completed");
  });

  it("session.kill() cancels the run", async () => {
    const backend = createKimiBackend({ command: process.execPath, argsPrefix: [fakeCli] });
    const lines = JSON.stringify([{ delay_ms: 10000, line: "{}" }]);
    const session = backend.execute({
      workDir: process.cwd(),
      env: { ...process.env, FAKE_CLI_LINES: lines } as Record<string, string>,
      prompt: "test",
      resume: false,
      idleTimeoutMs: 60000,
    });
    setTimeout(() => session.kill(), 100);
    for await (const _ of session.messages) { /* drain */ }
    const result = await session.result;
    expect(result.status).toBe("cancelled");
  }, 15000);
});
