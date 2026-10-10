import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { LIMITS, deriveVerificationStatus, policyHash, validateVerificationPolicy } from "@anvil/core";
import type { VerificationCheck, VerificationCommandSpec, VerificationRun } from "@anvil/core";
import { killProcessTree } from "./agents/process.js";
import { readWorktreeHead } from "./worktree.js";

const execFileAsync = promisify(execFile);
const POLICY_FILE = "ANVIL.verify.json";
type Policy = { source: VerificationRun["policy_source"]; hash: string | null; commands: VerificationCommandSpec[]; error?: VerificationRun["error_code"] };

/** 保留文件的原始换行与空白；worktree.git() 会 trim，不能用来计算策略 hash。 */
async function gitRaw(workDir: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workDir, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  return stdout;
}

/** 只从 start 固化的 base_commit 读取；Git 读取失败和确实没有策略文件必须分开。 */
export async function loadVerificationPolicy(workDir: string, baseCommit: string): Promise<Policy> {
  let hash: string | null = null;
  try {
    if (!/^[a-f0-9]{40}$/i.test(baseCommit)) throw new Error("invalid_base");
    const entry = await gitRaw(workDir, ["ls-tree", "-z", "--name-only", baseCommit, "--", POLICY_FILE]);
    if (!entry) return { source: "none", hash: null, commands: [] };
    const raw = await gitRaw(workDir, ["show", `${baseCommit}:${POLICY_FILE}`]);
    hash = policyHash(raw);
    try {
      const parsed = validateVerificationPolicy(JSON.parse(raw));
      if (!parsed.ok || !parsed.value) throw new Error("invalid_policy");
      return { source: POLICY_FILE, hash, commands: parsed.value.commands };
    } catch {
      return { source: POLICY_FILE, hash, commands: [], error: "invalid_policy" };
    }
  } catch {
    return { source: POLICY_FILE, hash, commands: [], error: "verification_error" };
  }
}

export function verificationShell(command: string, platform: NodeJS.Platform = process.platform, systemRoot = process.env.SystemRoot ?? "C:\\Windows") {
  return platform === "win32"
    ? { command: path.win32.join(systemRoot, "System32", "cmd.exe"), args: ["/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true }
    : { command: "/bin/sh", args: ["-lc", command], windowsVerbatimArguments: false };
}

/** 清除显式凭据及其别名；这是缩减继承环境，不是隔离本机凭据的沙箱。 */
export function verificationEnvironment(source: NodeJS.ProcessEnv = process.env, knownSecrets: string[] = []) {
  const credential = /(?:ANVIL_.*TOKEN|TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i;
  const secrets = [...new Set([...knownSecrets, ...Object.entries(source).filter(([key]) => credential.test(key)).map(([, value]) => value ?? "")].filter(Boolean))].sort((a, b) => b.length - a.length);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !credential.test(key) && !secrets.some(secret => value.includes(secret))) env[key] = value;
  }
  return { env, secrets };
}

function scrub(text: string, secrets: string[]) {
  for (const secret of secrets) if (secret) text = text.split(secret).join("***");
  return text.replace(/\b(?:anv_|atk_)[A-Za-z0-9_-]+/g, "***").replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***");
}

/** 在完整 UTF-8 字符边界截断，避免把合法中文截成替换字符。 */
function truncate(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function skipped(spec: VerificationCommandSpec, secrets: string[]): VerificationCheck {
  return { id: spec.id, label: truncate(scrub(spec.label, secrets), 512), command: scrub(spec.command, secrets), required: spec.required, status: "skipped", exit_code: null, duration_ms: 0, output_excerpt: "" };
}

interface CommandOptions { workDir: string; env: Record<string, string>; secrets: string[]; signal?: AbortSignal }

/** 有界输出、墙钟超时；异常转为失败证据，不向 daemon 抛出。 */
export async function runVerificationCommand(spec: VerificationCommandSpec, opts: CommandOptions): Promise<VerificationCheck> {
  const check = skipped(spec, opts.secrets);
  if (opts.signal?.aborted) return check;
  const started = performance.now();
  // 多保留一段 secret 的长度，先脱敏再截断，避免在摘录边界泄露 secret 前缀。
  const captureLimit = LIMITS.CHECK_EXCERPT_BYTES + Math.max(256, ...opts.secrets.map(s => s.length));
  let stdout = "", stderr = "";
  return new Promise(resolve => {
    let settled = false, timedOut = false, cancelled = false;
    let deadline: NodeJS.Timeout | undefined, fallback: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (code: number | null, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(fallback);
      opts.signal?.removeEventListener("abort", cancel);
      check.status = timedOut ? "timed_out" : cancelled || error || code !== 0 ? "failed" : "passed";
      check.exit_code = timedOut || cancelled || error ? null : code;
      check.duration_ms = Math.max(0, Math.round(performance.now() - started));
      check.output_excerpt = truncate(scrub([stdout, stderr, error, cancelled ? "verification_cancelled" : ""].filter(Boolean).join("\n"), opts.secrets), LIMITS.CHECK_EXCERPT_BYTES);
      resolve(check);
    };
    const stop = () => {
      clearTimeout(deadline); clearTimeout(fallback);
      if (child?.pid) killProcessTree(child.pid, true);
      // kill 失败或子进程管道没有关闭时也必须收敛；绝不把超时当成功。
      fallback = setTimeout(() => {
        child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
        finish(null);
      }, 2000);
    };
    const cancel = () => { if (!settled && !cancelled) { cancelled = true; stop(); } };
    try {
      const shell = verificationShell(spec.command);
      child = spawn(shell.command, shell.args, {
        cwd: opts.workDir, env: opts.env, stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32", windowsHide: true, windowsVerbatimArguments: shell.windowsVerbatimArguments,
      });
      child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => { if (stdout.length < captureLimit) stdout += chunk.slice(0, captureLimit - stdout.length); });
      child.stderr!.on("data", (chunk: string) => { if (stderr.length < captureLimit) stderr += chunk.slice(0, captureLimit - stderr.length); });
      child.on("error", () => finish(null, "spawn_failed"));
      child.on("close", code => finish(code));
      deadline = setTimeout(() => { timedOut = true; stop(); }, spec.timeout_ms);
      opts.signal?.addEventListener("abort", cancel, { once: true });
      if (opts.signal?.aborted) cancel();
    } catch {
      finish(null, "spawn_failed");
    }
  });
}

export interface VerificationResult { verification: VerificationRun; headCommit: string | null; worktreeClean: boolean }
interface VerificationOptions {
  workDir: string; baseCommit: string; taskBranch: string;
  policy?: Policy; env?: NodeJS.ProcessEnv; secrets?: string[]; signal?: AbortSignal;
}

function boundPayload(run: VerificationRun) {
  // JSON 转义和元数据也占载荷空间；不能仅用 8 × 8KB 计算总大小。
  let excess: number;
  while ((excess = Buffer.byteLength(JSON.stringify(run)) - LIMITS.VERIFICATION_TOTAL_BYTES) > 0) {
    const longest = run.checks.reduce<VerificationCheck | undefined>((max, c) => !max || c.output_excerpt.length > max.output_excerpt.length ? c : max, undefined);
    if (!longest?.output_excerpt) break;
    longest.output_excerpt = truncate(longest.output_excerpt, Math.max(0, Buffer.byteLength(longest.output_excerpt) - excess));
  }
}

export async function runVerification(opts: VerificationOptions): Promise<VerificationResult> {
  const policy = opts.policy ?? await loadVerificationPolicy(opts.workDir, opts.baseCommit);
  const { env, secrets } = verificationEnvironment(opts.env, opts.secrets);
  const verification: VerificationRun = {
    schema_version: 1, policy_source: policy.source, policy_hash: policy.hash, verification_sha: null,
    status: "not_configured", started_at: null, completed_at: new Date().toISOString(), checks: [],
  };
  let headCommit: string | null = null, worktreeClean = false;
  try {
    headCommit = await readWorktreeHead(opts.workDir, opts.taskBranch);
    worktreeClean = !(await gitRaw(opts.workDir, ["status", "--porcelain", "--untracked-files=all"])).trim();
    if (policy.error) {
      verification.status = "failed"; verification.error_code = policy.error;
    } else if (policy.commands.length) {
      verification.verification_sha = headCommit;
      verification.checks = policy.commands.map(c => skipped(c, secrets));
      if (!worktreeClean) {
        verification.status = "dirty";
      } else {
        verification.started_at = new Date().toISOString();
        for (let i = 0; i < policy.commands.length; i++) {
          if (opts.signal?.aborted) break;
          const check = await runVerificationCommand(policy.commands[i], { workDir: opts.workDir, env, secrets, signal: opts.signal });
          verification.checks[i] = check;
          if (check.status === "timed_out" || opts.signal?.aborted) break;
        }
        headCommit = await readWorktreeHead(opts.workDir, opts.taskBranch);
        worktreeClean = !(await gitRaw(opts.workDir, ["status", "--porcelain", "--untracked-files=all"])).trim();
        verification.status = deriveVerificationStatus({
          policyPresent: true, headUnchanged: headCommit === verification.verification_sha, worktreeClean,
          checks: verification.checks.map(c => ({ id: c.id, required: c.required, exit_code: c.exit_code, timed_out: c.status === "timed_out" })),
        }) as VerificationRun["status"];
        if (opts.signal?.aborted) { verification.status = "failed"; verification.error_code = "verification_error"; }
      }
    }
  } catch {
    verification.status = "failed"; verification.error_code = "verification_error";
    // 无法确认最终 Git 事实时不能沿用先前的 clean=true。
    worktreeClean = false;
  }
  verification.completed_at = new Date().toISOString();
  boundPayload(verification);
  return { verification, headCommit, worktreeClean };
}
