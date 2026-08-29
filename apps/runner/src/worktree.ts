import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRepoUrl, type Issue } from "@anvil/core";
import { ensureRepoCache } from "./repocache.js";

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd, windowsHide: true, timeout: 30_000,
      // 无凭据时立即失败而非挂到超时:禁终端密码提示与 GCM 交互弹窗
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
  throw new Error("git 不可用：PATH 中找不到,已知安装路径也探测失败(可设 GIT_EXE 指定)");
}

// =============================================================================
// A04 · Git 锚点:workDir + 任务分支 + 目标分支 + 完整 40 位 baseCommit + resumed
//
// 关键不变量(PRD FR-001,AGENTS.md 不变量):
//  1. Git 仓库任务的 baseCommit 必须是完整 40 位 hex SHA-1,绝不允许短 SHA 或 "HEAD"。
//  2. detached HEAD 必须明确失败,不得把 "HEAD" 当作 targetBranch。
//  3. worktree 必须从已固化的 baseCommit 创建,不能在多个命令之间重新读取浮动的 HEAD。
//  4. Resume 必须使用 Task 已保存的锚点,不得用当前目标分支 HEAD 覆盖已保存 baseCommit。
//  5. 无 repo_path 的普通目录任务:taskBranch/targetBranch/baseCommit 一律为 null,
//     后续 Start 继续走当前无 anchors 兼容路径(daemon_id + work_dir),不伪造 Git 事实。
// =============================================================================

const SHA1_40 = /^[0-9a-f]{40}$/i;

/** 读当前分支(简写)。detached HEAD 返回 "HEAD";调用方必须把 "HEAD" 视为失败。 */
export async function readAbbrevBranch(repoDir: string): Promise<string> {
  const out = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}

/** 把 SHA 字符串严格校验为完整 40 位 hex,非 40 位一律抛错(防短 SHA / 缩写)。 */
export function assertFullSha1(field: string, value: string): string {
  if (!SHA1_40.test(value)) {
    throw new Error(`${field} 不是完整 40 位 hex SHA-1: ${value}`);
  }
  return value.toLowerCase();
}

/** 读取某 ref 的完整 40 位 SHA-1(用 `git rev-parse <ref>`),失败或非 40 位 → 抛错。 */
export async function readFullShaOfRef(repoDir: string, ref: string): Promise<string> {
  const out = await git(repoDir, ["rev-parse", "--verify", ref]);
  return assertFullSha1(`ref ${ref}`, out);
}

/** 读取当前 worktree HEAD 的完整 40 位 SHA-1。detached/非 SHA-1 都会失败。 */
export async function readWorktreeHead(workDir: string): Promise<string> {
  const out = await git(workDir, ["rev-parse", "HEAD"]);
  return assertFullSha1("worktree HEAD", out);
}

export interface PreparedWorkdir {
  workDir: string;
  /** 任务分支(形如 task/<shortId>);无 repo_path 时为 null。 */
  taskBranch: string | null;
  /** 目标分支(本地或缓存仓库当前明确分支);无 repo_path 或 detached 时为 null。 */
  targetBranch: string | null;
  /** 完整 40 位 hex baseCommit;无 repo_path 时为 null。 */
  baseCommit: string | null;
  /** true = 复用 priorWorkDir(续跑);false = 新建 worktree。 */
  resumed: boolean;
}

/** 已保存锚点(从 pkg.task 派生):用于 resume 校验。targetBranch/baseCommit 必须存在
 *  才能合法 resume;若缺失,prepareWorkdir 不得猜测,会明确失败。 */
export interface SavedAnchors {
  taskBranch: string | null;
  targetBranch: string | null;
  baseCommit: string | null;
}

async function resolveLocalRepoAnchors(repoPath: string): Promise<{ targetBranch: string; baseCommit: string }> {
  // 1. 明确读出当前分支,detached HEAD 立即失败(不能把 "HEAD" 当 targetBranch)
  const abbrev = await readAbbrevBranch(repoPath);
  if (!abbrev || abbrev === "HEAD") {
    throw new Error(`本地仓库 detached HEAD,无法固化目标分支(${repoPath})`);
  }
  // 2. 读出该分支的完整 40 位 SHA;非 40 位(短 SHA)立即失败
  const sha = await readFullShaOfRef(repoPath, abbrev);
  return { targetBranch: abbrev, baseCommit: sha };
}

async function resolveUrlRepoAnchors(cacheDir: string): Promise<{ targetBranch: string; baseCommit: string }> {
  // 缓存仓库的默认分支 = clone 下来后的当前分支。detached 同样失败。
  const abbrev = await readAbbrevBranch(cacheDir);
  if (!abbrev || abbrev === "HEAD") {
    throw new Error(`URL 缓存仓库 detached HEAD,无法固化目标分支(${cacheDir})`);
  }
  const sha = await readFullShaOfRef(cacheDir, abbrev);
  return { targetBranch: abbrev, baseCommit: sha };
}

/** A04 · 备工作区:Git 任务返回 taskBranch/targetBranch/baseCommit + resumed;
 *  普通目录任务三锚点全 null。detached HEAD、缺失锚点、非法 SHA 一律明确失败。 */
export async function prepareWorkdir(
  issue: Issue,
  taskId: string,
  runnerRoot: string,
  priorWorkDir: string | null,
  savedAnchors: SavedAnchors | null = null,
): Promise<PreparedWorkdir> {
  await ensureGitAvailable();
  if (priorWorkDir && fs.existsSync(priorWorkDir)) {
    // Resume:worktree 已存在,读实际分支(不能是 HEAD)+ Task 已保存锚点。
    return await resumeWorkdir(priorWorkDir, savedAnchors);
  }
  // 首次准备:先确保有 workDir,再视 repo_path 决定是否建 worktree。
  const short = taskId.slice(0, 8);
  const base = path.join(runnerRoot, "worktrees");
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, short);
  if (!issue.repo_path) {
    // 普通目录任务:不得伪造 Git 锚点
    fs.mkdirSync(dir, { recursive: true });
    return { workDir: dir, taskBranch: null, targetBranch: null, baseCommit: null, resumed: false };
  }
  const taskBranch = `task/${short}`;
  if (isRepoUrl(issue.repo_path)) {
    const cacheDir = await ensureRepoCache(issue.repo_path, runnerRoot);
    const { targetBranch, baseCommit } = await resolveUrlRepoAnchors(cacheDir);
    // worktree 必须从已固化的 baseCommit 创建,不在多个命令之间重新读取浮动的 HEAD
    await git(cacheDir, ["worktree", "add", "-b", taskBranch, dir, baseCommit]);
    return { workDir: dir, taskBranch, targetBranch, baseCommit, resumed: false };
  }
  const { targetBranch, baseCommit } = await resolveLocalRepoAnchors(issue.repo_path);
  await git(issue.repo_path, ["worktree", "add", "-b", taskBranch, dir, baseCommit]);
  return { workDir: dir, taskBranch, targetBranch, baseCommit, resumed: false };
}

async function resumeWorkdir(priorWorkDir: string, savedAnchors: SavedAnchors | null): Promise<PreparedWorkdir> {
  // A04 · resume 必传 Task 已保存锚点,缺失则明确失败(不得猜测)
  if (!savedAnchors
      || !savedAnchors.targetBranch
      || !savedAnchors.baseCommit) {
    throw new Error("Resume 缺少 Task 已保存的 target_branch / base_commit 锚点,不得从最新目标分支重新计算");
  }
  // 严格校验 Task 已存 SHA 是 40 位 hex,不是 "HEAD" / 短 SHA
  assertFullSha1("saved baseCommit", savedAnchors.baseCommit);

  // 读 worktree 实际分支;detached HEAD 必须失败
  let actualBranch: string;
  try {
    actualBranch = await readAbbrevBranch(priorWorkDir);
  } catch {
    throw new Error(`Resume 读取 worktree 分支失败(${priorWorkDir})`);
  }
  if (!actualBranch || actualBranch === "HEAD") {
    throw new Error(`Resume worktree 处于 detached HEAD,无法继续(${priorWorkDir})`);
  }

  // Task 已保存 task_branch:实际分支必须一致;不一致 → 明确失败。
  if (savedAnchors.taskBranch && savedAnchors.taskBranch !== actualBranch) {
    throw new Error(`Resume worktree 实际分支 ${actualBranch} 与 Task 已存 task_branch ${savedAnchors.taskBranch} 不一致`);
  }

  // target/base 始终使用 Task 已存值(不得重新读取当前目标分支 HEAD)
  return {
    workDir: priorWorkDir,
    taskBranch: actualBranch,
    targetBranch: savedAnchors.targetBranch,
    baseCommit: savedAnchors.baseCommit,
    resumed: true,
  };
}

/** A04 · 固定 base..head diff 范围。
 *  baseCommit / headCommit 必须为完整 40 位 hex;命令失败 / 非 40 位 SHA → 直接抛错,
 *  由 executeTask 异常收敛路径处理(不伪装成合法空 diff)。无 repo_path 任务不应调用本函数。 */
export async function gitDiffStat(workDir: string, baseCommit: string, headCommit: string): Promise<string> {
  assertFullSha1("baseCommit", baseCommit);
  assertFullSha1("headCommit", headCommit);
  return await git(workDir, ["diff", "--stat", `${baseCommit}..${headCommit}`]);
}
