import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCliProcess, killProcessTree } from "../src/agents/process.js";
import { parseAgentLine, type AgentMessage } from "@anvil/core";

const fakeCli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "testing", "fake-cli.mjs");

function runFake(env: Record<string, string>, idleTimeoutMs = 5000) {
  return runCliProcess({
    command: process.execPath,
    args: [fakeCli],
    cwd: process.cwd(),
    env: { ...process.env, ...env } as Record<string, string>,
    parseLine: parseAgentLine,
    idleTimeoutMs,
  });
}

async function drain(messages: AsyncIterable<AgentMessage>) {
  const out: AgentMessage[] = [];
  for await (const m of messages) out.push(m);
  return out;
}

describe("runCliProcess", () => {
  it("streams parsed messages then completes with exit code", async () => {
    const lines = JSON.stringify([
      { delay_ms: 10, line: JSON.stringify({ role: "assistant", content: [{ type: "text", text: "hi" }] }) },
      { delay_ms: 10, line: "plain text line" },
    ]);
    const p = runFake({ FAKE_CLI_LINES: lines, FAKE_CLI_EXIT: "0" });
    const msgs = await drain(p.messages);
    const result = await p.result;
    expect(msgs[0]).toEqual({ type: "text", content: "hi" });
    expect(msgs[1]).toEqual({ type: "log", content: "plain text line" });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
  });

  it("non-zero exit → failed", async () => {
    const p = runFake({ FAKE_CLI_LINES: "[]", FAKE_CLI_EXIT: "3" });
    await drain(p.messages);
    const result = await p.result;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("idle watchdog kills silent process", async () => {
    const lines = JSON.stringify([{ delay_ms: 10000, line: "{}" }]);
    const p = runFake({ FAKE_CLI_LINES: lines }, 200);
    await drain(p.messages);
    const result = await p.result;
    expect(result.status).toBe("timeout");
  }, 15000);

  it("kill() terminates the process tree", async () => {
    const lines = JSON.stringify([{ delay_ms: 10000, line: "{}" }]);
    const p = runFake({ FAKE_CLI_LINES: lines });
    await new Promise((r) => setTimeout(r, 100));
    p.kill();
    const result = await p.result;
    expect(result.status).toBe("cancelled");
  }, 15000);
});
