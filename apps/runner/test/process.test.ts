import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
  it("强制终止会结束真实子孙进程，不能留下验证工作进程", async () => {
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},100)";
    const child = spawn(process.execPath, ["-e", script], { detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let descendant: number | undefined;
    try {
      descendant = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("子进程未就绪")), 3000);
        child.stdout.once("data", data => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
      });
      expect(Number.isInteger(descendant)).toBe(true);
      killProcessTree(child.pid!, true);
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (let i = 0; i < 60 && (alive(child.pid!) || alive(descendant)); i++) await new Promise(r => setTimeout(r, 50));
      expect(alive(child.pid!)).toBe(false);
      expect(alive(descendant)).toBe(false);
    } finally {
      if (child.pid) killProcessTree(child.pid, true);
      if (descendant) killProcessTree(descendant, true);
    }
  }, 15000);
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

  it("spawn failure → failed with spawn_failed error", async () => {
    const p = runCliProcess({
      command: "definitely-not-a-real-command-xyz",
      args: [],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      parseLine: parseAgentLine,
      idleTimeoutMs: 5000,
    });
    const result = await p.result;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("spawn_failed");
  });
});
