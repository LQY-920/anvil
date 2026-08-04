import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Issue } from "@anvil/core";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

export interface PreparedWorkdir { workDir: string; branch: string | null; resumed: boolean; }

/** 有 repo_path 则建 git worktree（分支 task/<shortId>）；否则用普通目录。prior_work_dir 存在则复用以恢复会话。 */
export async function prepareWorkdir(issue: Issue, taskId: string, runnerRoot: string, priorWorkDir: string | null): Promise<PreparedWorkdir> {
  if (priorWorkDir && fs.existsSync(priorWorkDir)) {
    return { workDir: priorWorkDir, branch: null, resumed: true };
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
  await git(issue.repo_path, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { workDir: dir, branch, resumed: false };
}

export async function gitDiffStat(workDir: string): Promise<string> {
  try { return await git(workDir, ["diff", "--stat", "HEAD"]); } catch { return ""; }
}
