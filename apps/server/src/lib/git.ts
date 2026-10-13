import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import path from "node:path";

/** server 版 git 调用（移植自 runner worktree.ts；server 不 import runner）。 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-replace-objects", ...args], { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // git 的冲突/失败详情常打在 stdout（如 merge CONFLICT），stderr 为空时 err.message 只有 "Command failed"——把 stdout 也带上
      if (err) return reject(new Error([stderr, stdout, err?.message].filter(Boolean).join("\n").trim()));
      resolve(stdout);
    });
  });
}

/** 持续排空 stdout，只保留指定字节数；大 Diff 不因 execFile 缓冲区溢出而失败。 */
export function gitLimited(cwd: string, args: string[], limit: number): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-replace-objects", ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0, truncated = false, stderr = "", timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const take = Math.min(chunk.length, Math.max(0, limit - bytes));
      if (take > 0) chunks.push(chunk.subarray(0, take));
      bytes += take;
      if (take < chunk.length) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut || code !== 0) { reject(new Error(timedOut ? "Git 输出超时" : stderr || `Git 退出码 ${code}`)); return; }
      const decoder = new StringDecoder("utf8");
      // 截断时不输出末尾不完整的 UTF-8 字符。
      const text = decoder.write(Buffer.concat(chunks)) + (truncated ? "" : decoder.end());
      resolve({ text, truncated });
    });
  });
}

function probe(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

let gitChecked = false;

/** 确保 git 可用：PATH 探测失败时尝试已知安装路径并注入 process.env.PATH。 */
export async function ensureGitAvailable(): Promise<void> {
  if (gitChecked) return;
  if (await probe("git")) { gitChecked = true; return; }
  const candidates = [
    process.env.GIT_EXE,
    "D:\\codingTools\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\cmd\\git.exe",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    if (await probe(c)) {
      process.env.PATH = `${path.dirname(c)}${path.delimiter}${process.env.PATH ?? ""}`;
      gitChecked = true;
      return;
    }
  }
  throw new Error("git unavailable on server host");
}
