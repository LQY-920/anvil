import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexArgs, createCodexBackend } from "../src/agents/codex.js";
import { resolveCodexLaunch } from "../src/agents/codex-launch.js";
import { readBoundedUtf8 } from "../src/bounded-read.js";
import { tryVersion } from "../src/probe.js";
import { CODEX_MAX_EVENT_CHARS, type AgentMessage } from "@anvil/core";

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
    const withGit = buildCodexArgs({ prompt: "commit", extraWritableDirs: ["D:\\repo\\.git\\worktrees\\task", "D:\\repo\\.git"] });
    expect(withGit).toContain("--add-dir");
    expect(withGit).toContain("D:\\repo\\.git");
    expect(withGit.indexOf("--add-dir")).toBeLessThan(withGit.indexOf("commit"));
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

  it("spawns the snapshotted executable and keeps spaced arguments intact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil 测试 "));
    const script = path.join(dir, "fake cli.mjs");
    fs.copyFileSync(fakeCli, script);
    const backend = createCodexBackend();
    const lines = JSON.stringify([
      { delay_ms: 1, line: JSON.stringify({ type: "thread.started", thread_id: "thread-path" }) },
      { delay_ms: 1, line: JSON.stringify({ type: "turn.completed" }) },
    ]);
    const session = backend.execute({
      workDir: process.cwd(),
      env: { ...process.env, FAKE_CLI_LINES: lines, FAKE_CLI_EXIT: "0" } as Record<string, string>,
      prompt: "带引号 \"pong\"",
      resume: false,
      command: process.execPath,
      argsPrefix: [script],
      idleTimeoutMs: 5000,
    });
    for await (const _message of session.messages) { /* drain */ }
    const result = await session.result;
    expect(result.status).toBe("completed");
    expect(result.sessionRef).toBe("thread-path");
    const launch = resolveCodexLaunch(path.join(dir, "codex.ps1"));
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.argsPrefix).toContain(path.join(dir, "codex.ps1"));
    expect(launch.command.toLowerCase()).toContain("powershell.exe");
  });

  it("keeps a later turn.completed from washing away an oversized line", async () => {
    const script = path.join(os.tmpdir(), `anvil-overflow-${Date.now()}.mjs`);
    fs.writeFileSync(script, `
      const huge = "x".repeat(${CODEX_MAX_EVENT_CHARS + 20});
      process.stdout.write(huge + "\\n");
      process.stdout.write('{"type":"turn.completed"}\\n');
    `);
    const backend = createCodexBackend({ command: process.execPath, argsPrefix: [script] });
    const session = backend.execute({
      workDir: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      prompt: "overflow",
      resume: false,
      idleTimeoutMs: 5000,
    });
    for await (const _message of session.messages) { /* drain */ }
    const result = await session.result;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("protocol_error");
  });

  it("does not spawn a cmd shim that has no node entry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-cmd-"));
    const cmd = path.join(dir, "codex.cmd");
    fs.writeFileSync(cmd, "@echo off\r\n");
    const launch = resolveCodexLaunch(cmd);
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error).toContain("spawn_failed");
    await expect(tryVersion(cmd, ["--version"], 1000)).resolves.toBeNull();
  });

  it("reports a missing or oversized report without reading past the limit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-report-"));
    expect(readBoundedUtf8(path.join(dir, "missing.json"), 8).ok).toBe(false);
    const big = path.join(dir, "big.json");
    fs.writeFileSync(big, "0123456789");
    const read = readBoundedUtf8(big, 4);
    expect(read).toEqual({ ok: false, reason: "too_large" });
  });
});
