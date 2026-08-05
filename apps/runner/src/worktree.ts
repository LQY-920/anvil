import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRepoUrl, type Issue } from "@anvil/core";
import { ensureRepoCache } from "./repocache.js";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd, windowsHide: true, timeout: 30_000,
      // 无凭据时立即失败而非挂到超时：禁终端密码提示与 GCM 交互弹窗
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

function probe(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["--version"], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
  });
}

let gitChecked = false;

/** 确保 git 可用：不在 PATH 时探测常见安装路径并注入 process.env.PATH（子进程含 Agent CLI 一并继承）。 */
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
  throw new Error("git 不可用：PATH 中找不到，已知安装路径也探测失败（可设 GIT_EXE 指定）");
}

export interface PreparedWorkdir { workDir: string; branch: string | null; resumed: boolean; }

/** 有 repo_path 则建 git worktree（分支 task/<shortId>）；URL 引用先落到本地缓存再从缓存建 worktree；否则用普通目录。prior_work_dir 存在则复用以恢复会话。 */
export async function prepareWorkdir(issue: Issue, taskId: string, runnerRoot: string, priorWorkDir: string | null): Promise<PreparedWorkdir> {
  await ensureGitAvailable();
  if (priorWorkDir && fs.existsSync(priorWorkDir)) {
    // 续跑：worktree 已在既有任务分支上，读回当前分支，否则 result_json 丢分支、验收区（diff/合入）不显示
    let branch: string | null = null;
    try {
      const current = (await git(priorWorkDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      branch = current && current !== "HEAD" ? current : null;
    } catch { /* 普通目录无分支 */ }
    return { workDir: priorWorkDir, branch, resumed: true };
  }
  const short = taskId.slice(0, 8);
  const base = path.join(runnerRoot, "worktrees");
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, short);
  if (!issue.repo_path) {
    fs.mkdirSync(dir, { recursive: true });
    return { workDir: dir, branch: null, resumed: false };
  }
  const branch = `task/${short}`;
  if (isRepoUrl(issue.repo_path)) {
    const cacheDir = await ensureRepoCache(issue.repo_path, runnerRoot);
    // clone 下来的默认分支（rev-parse 在缓存上是本地分支名）
    const defaultBranch = await git(cacheDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    await git(cacheDir, ["worktree", "add", "-b", branch, dir, defaultBranch]);
    return { workDir: dir, branch, resumed: false };
  }
  await git(issue.repo_path, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { workDir: dir, branch, resumed: false };
}

export async function gitDiffStat(workDir: string): Promise<string> {
  try { return await git(workDir, ["diff", "--stat", "HEAD"]); } catch { return ""; }
}
