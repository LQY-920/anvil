import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadVerificationPolicy, runVerification, verificationShell, verificationEnvironment, runVerificationCommand } from "../src/verification.js";
import type { VerificationCommandSpec } from "@anvil/core";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // 只清理本测试显式创建的临时根目录。
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("anvil-verify-")) throw new Error("测试目录越界");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function command(code: string, extra: Partial<VerificationCommandSpec> = {}): VerificationCommandSpec {
  return { id: "test", label: "验证", command: `"${process.execPath}" -e "${code}"`, required: true, timeout_ms: 3000, ...extra };
}
function repo(commands: VerificationCommandSpec[] | string | null = [command("console.log('通过')")]) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-verify-")); roots.push(workDir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workDir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git("init", "-b", "main"); git("config", "user.name", "测试"); git("config", "user.email", "test@example.invalid"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(workDir, "base.txt"), "base");
  const raw = typeof commands === "string" ? commands : commands === null ? null : JSON.stringify({ version: 1, commands }, null, 2) + "\n";
  if (raw !== null) fs.writeFileSync(path.join(workDir, "ANVIL.verify.json"), raw);
  git("add", "."); git("commit", "-m", "测试基线");
  return { workDir, baseCommit: git("rev-parse", "HEAD"), taskBranch: "main", git, raw };
}

describe("Runner 独立终检", () => {
  it("从基线读取原始策略，任务提交无法弱化命令或改变 hash", async () => {
    const r = repo([command("process.exit(7)")]);
    fs.writeFileSync(path.join(r.workDir, "ANVIL.verify.json"), JSON.stringify({ version: 1, commands: [command("process.exit(0)")] }));
    r.git("add", "."); r.git("commit", "-m", "尝试弱化策略");
    const result = await runVerification(r);
    expect(result.verification.status).toBe("failed");
    expect(result.verification.checks[0].exit_code).toBe(7);
    expect(result.verification.policy_hash).toBe(createHash("sha256").update(r.raw!).digest("hex"));
  });
  it("依次执行 required 检查并记录真实输出与耗时", async () => {
    const r = repo([command("console.log('第一条')"), command("console.error('第二条')", { id: "second" })]);
    const result = await runVerification(r);
    expect(result.verification.status).toBe("passed");
    expect(result.verification.verification_sha).toBe(r.baseCommit);
    expect(result.verification.checks.map(c => c.id)).toEqual(["test", "second"]);
    expect(result.verification.checks.map(c => c.exit_code)).toEqual([0, 0]);
    expect(result.verification.checks[1].output_excerpt).toContain("第二条");
    expect(Date.parse(result.verification.completed_at)).toBeGreaterThanOrEqual(Date.parse(result.verification.started_at!));
    expect(result.verification.checks[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
  it("optional 失败为 partial，后续 required 仍执行", async () => {
    const r = repo([command("process.exit(2)", { required: false }), command("console.log('继续')", { id: "next" })]);
    const result = await runVerification(r);
    expect(result.verification.status).toBe("partial");
    expect(result.verification.checks[1].status).toBe("passed");
  });
  it("缺策略为 not_configured，完成时间存在且不伪造验证 SHA", async () => {
    const result = await runVerification(repo(null));
    expect(result.verification).toMatchObject({ status: "not_configured", policy_source: "none", policy_hash: null, verification_sha: null, started_at: null, checks: [] });
    expect(Number.isFinite(Date.parse(result.verification.completed_at))).toBe(true);
  });
  it.each(["{", JSON.stringify({ version: 2, commands: [] }), JSON.stringify({ version: 1, commands: Array(9).fill(command("process.exit(0)")) })])("拒绝无效策略且不执行部分命令：%s", async raw => {
    const result = await runVerification(repo(raw));
    expect(result.verification.status).toBe("failed");
    expect(result.verification.error_code).toBe("invalid_policy");
    expect(result.verification.checks).toEqual([]);
  });
  it("无效基线读取收敛为失败，不能伪装缺策略", async () => {
    const result = await runVerification({ ...repo(), baseCommit: "0".repeat(40) });
    expect(result.verification.status).toBe("failed");
    expect(result.verification.error_code).toBe("verification_error");
  });
  it("验证前 dirty 不执行命令", async () => {
    const r = repo([command("require('fs').writeFileSync('不应创建.txt','x')")]);
    fs.writeFileSync(path.join(r.workDir, "未提交.txt"), "x");
    const result = await runVerification(r);
    expect(result.verification.status).toBe("dirty");
    expect(result.worktreeClean).toBe(false);
    expect(fs.existsSync(path.join(r.workDir, "不应创建.txt"))).toBe(false);
    expect(result.verification.checks[0].status).toBe("skipped");
  });
  it("验证产生未跟踪文件为 dirty", async () => {
    const result = await runVerification(repo([command("require('fs').writeFileSync('生成.txt','x')")]));
    expect(result.verification.status).toBe("dirty");
    expect(result.verification.checks[0].exit_code).toBe(0);
  });
  it("验证提交新 HEAD 为 stale，保留验证开始时的 SHA", async () => {
    const r = repo([command("require('child_process').execFileSync('git',['commit','--allow-empty','-m','验证中提交'])")]);
    const result = await runVerification(r);
    expect(result.verification.status).toBe("stale");
    expect(result.verification.verification_sha).toBe(r.baseCommit);
    expect(result.headCommit).not.toBe(r.baseCommit);
    expect(result.worktreeClean).toBe(true);
  });
  it("超时终止进程树，后续命令不再启动", async () => {
    const r = repo([command("setInterval(()=>{},100)", { timeout_ms: 1000 }), command("require('fs').writeFileSync('不应创建.txt','x')", { id: "next" })]);
    const result = await runVerification(r);
    expect(result.verification.status).toBe("failed");
    expect(result.verification.checks[0].status).toBe("timed_out");
    expect(result.verification.checks[1].status).toBe("skipped");
    expect(fs.existsSync(path.join(r.workDir, "不应创建.txt"))).toBe(false);
  }, 15000);
  it("spawn 失败作为检查失败返回", async () => {
    const r = repo();
    const result = await runVerificationCommand(command("process.exit(0)"), { workDir: path.join(r.workDir, "不存在"), env: {}, secrets: [] });
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBeNull();
    expect(result.output_excerpt).toContain("spawn_failed");
  });
  it("取消验证后不启动检查", async () => {
    const controller = new AbortController(); controller.abort();
    const result = await runVerification({ ...repo(), signal: controller.signal });
    expect(result.verification.status).not.toBe("passed");
    expect(result.verification.checks.every(c => c.status === "skipped")).toBe(true);
  });
  it("脱敏跨块输出和命令，UTF8 摘录限制 8KB", async () => {
    const secret = "test-secret-for-verification";
    const r = repo([command(`process.stdout.write('${secret.slice(0, 10)}');process.stdout.write('${secret.slice(10)}');process.stderr.write('${secret}');console.log('中文'.repeat(10000))`)]);
    const result = await runVerification({ ...r, secrets: [secret] });
    const text = result.verification.checks[0].output_excerpt;
    expect(text).toContain("***"); expect(text).not.toContain(secret);
    expect(text).not.toContain("�"); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8192);
    expect(result.verification.checks[0].command).not.toContain(secret);
  });
  it("剔除凭据变量及包含已知 secret 的普通变量", () => {
    const result = verificationEnvironment({ PATH: "普通路径", KEEP: "保留", ANVIL_DAEMON_TOKEN: "secret", anvil_task_token: "task-secret", OPENAI_API_KEY: "api-secret", CUSTOM: "包含secret", EMPTY: undefined }, ["secret"]);
    expect(result.env).toEqual({ PATH: "普通路径", KEEP: "保留" });
    expect(result.secrets).toEqual(expect.arrayContaining(["secret", "task-secret", "api-secret"]));
  });
  it("真实子进程继承普通环境，但拿不到 task/daemon token 和密钥别名", async () => {
    const r = repo([command("console.log([process.env.KEEP,process.env.ANVIL_TOKEN,process.env.ANVIL_DAEMON_TOKEN,process.env.ALIAS].join('|'))")]);
    const result = await runVerification({ ...r, env: { ...process.env, KEEP: "普通变量", ANVIL_TOKEN: "task-test-secret", ANVIL_DAEMON_TOKEN: "daemon-test-secret", ALIAS: "task-test-secret" } });
    expect(result.verification.status).toBe("passed");
    expect(result.verification.checks[0].output_excerpt.trim()).toBe("普通变量|||");
  });
  it("8 条高转义输出的总 JSON 载荷不超过 64KB", async () => {
    const r = repo(Array.from({ length: 8 }, (_, i) => command("process.stdout.write(String.fromCharCode(1).repeat(20000))", { id: `check${i}` })));
    const result = await runVerification(r);
    expect(result.verification.status).toBe("passed");
    expect(Buffer.byteLength(JSON.stringify(result.verification))).toBeLessThanOrEqual(65536);
    expect(result.verification.checks.every(c => Buffer.byteLength(c.output_excerpt) <= 8192)).toBe(true);
  }, 15000);
  it("输出非法 UTF8 字节用替换字符呈现", async () => {
    const result = await runVerification(repo([command("process.stdout.write(Buffer.from([255,97]))")]));
    expect(result.verification.checks[0].output_excerpt).toContain("�a");
  });
  it("验证进行中取消会终止命令且不执行下一条", async () => {
    const r = repo([command("console.log('ready');setInterval(()=>{},100)", { timeout_ms: 10000 }), command("process.exit(0)", { id: "next" })]);
    const controller = new AbortController();
    const policy = await loadVerificationPolicy(r.workDir, r.baseCommit);
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const result = await runVerification({ ...r, policy, signal: controller.signal });
      expect(result.verification.status).toBe("failed");
      expect(result.verification.checks[0].output_excerpt).toContain("verification_cancelled");
      expect(result.verification.checks[1].status).toBe("skipped");
    } finally { clearTimeout(timer); }
  }, 15000);
  it("平台 shell 保留完整命令且 Windows 不走二次参数转义", () => {
    const win = verificationShell('"C:\\有 空格\\node.exe" -v', "win32", "C:\\Windows");
    expect(win.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(win.args).toEqual(["/d", "/s", "/c", '""C:\\有 空格\\node.exe" -v"']);
    expect(win.windowsVerbatimArguments).toBe(true);
    expect(verificationShell("echo hi", "linux")).toMatchObject({ command: "/bin/sh", args: ["-lc", "echo hi"] });
  });
  it("预先加载的策略不受之后的任务文件修改影响", async () => {
    const r = repo(); const policy = await loadVerificationPolicy(r.workDir, r.baseCommit);
    fs.writeFileSync(path.join(r.workDir, "ANVIL.verify.json"), "{}"); r.git("add", "."); r.git("commit", "-m", "修改策略");
    const result = await runVerification({ ...r, policy });
    expect(result.verification.status).toBe("passed");
  });
});
