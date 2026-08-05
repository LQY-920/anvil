import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** server 版 git 调用（移植自 runner worktree.ts；server 不 import runner）。 */
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // git 的冲突/失败详情常打在 stdout（如 merge CONFLICT），stderr 为空时 err.message 只有 "Command failed"——把 stdout 也带上
      if (err) return reject(new Error([stderr, stdout, err?.message].filter(Boolean).join("\n").trim()));
      resolve(stdout);
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
