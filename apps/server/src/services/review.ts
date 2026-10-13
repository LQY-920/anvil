import type { Db } from "../db/client.js";
import type { MergeResponse, TaskDiffResponse, Task } from "@anvil/core";
import { isRepoUrl, repoCachePath } from "@anvil/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGitAvailable, git, gitLimited } from "../lib/git.js";
import { gitRepositoryKey, readGitRepositoryIdentity, sameGitRepository } from "../lib/git-repository.js";
import { addComment, getIssue } from "./issues.js";
import { getTask } from "./tasks.js";
import { getDeliveryReport } from "./delivery.js";
import { findIntegrationAttempt, reserveIntegrationAttempt, setIntegrationLocalMerged,
  requireIntegrationRecovery, completeIntegrationAttempt, integrationDiagnostic } from "./integration-attempts.js";
import type { IntegrationIntent } from "./integration-attempts.js";

/** diff_text 超过 50KB 截断（看板展示用，完整 diff 可去仓库看）。 */
const MAX_DIFF_TEXT = 50 * 1024;

/** server 侧 anvilRoot：单机版假设 server 与 runner 同机，共享 runner 的仓库缓存目录（与 runner config 的 runnerRoot 同源）。 */
export function serverAnvilRoot(): string {
  return process.env.ANVIL_RUNNER_ROOT ?? path.join(os.homedir(), ".anvil");
}

/** 把 issue.repo_path 解析成本地仓库路径：URL → runner 缓存路径；本地路径原样返回。 */
function resolveRepo(repoPath: string): { repo: string; isUrl: boolean } {
  if (isRepoUrl(repoPath)) return { repo: repoCachePath(repoPath, serverAnvilRoot()), isUrl: true };
  return { repo: repoPath, isUrl: false };
}

type ReviewFailure = { ok: false; error: string; code?: string; http?: number };
export type DiffResult = { ok: true; data: TaskDiffResponse } | ReviewFailure;
export type MergeResult = { ok: true; data: MergeResponse; replayed?: boolean } | ReviewFailure;

function failure(code: string, error: string, http = 409): ReviewFailure { return { ok: false, code, error, http }; }
function diagnostic(error: unknown): string {
  return integrationDiagnostic(error instanceof Error ? error.message : String(error));
}
function validSha(value: string | null): value is string { return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value); }

/** 从 task.result_json 解析 branch；空 JSON、无 branch 字段、非法 JSON 都返回 null。 */
function parseBranch(resultJson: string | null): string | null {
  if (!resultJson) return null;
  try {
    const r = JSON.parse(resultJson);
    return typeof r?.branch === "string" && r.branch ? r.branch : null;
  } catch {
    return null;
  }
}

/** v2 只查看保存的提交，不依赖当前 HEAD；v1 明确保留历史浮动比较。 */
export async function getTaskDiff(db: Db, taskId: string): Promise<DiffResult> {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "task not found" };
  const legacy = task.delivery_contract_version === 1;
  if (!legacy && (task.delivery_contract_version !== 2 || !validSha(task.base_commit) || !validSha(task.head_commit)
    || !task.task_branch || !task.target_branch || !task.work_dir)) {
    return failure("diff_anchors_missing", "任务缺少完整 Git 锚点，无法读取固定版本 Diff");
  }
  const branch = legacy ? parseBranch(task.result_json) : task.task_branch;
  if (!branch) return { ok: false, error: "no branch" };
  const issue = getIssue(db, task.issue_id);
  if (!issue?.repo_path) return legacy ? { ok: false, error: "no repo" }
    : failure("repository_mismatch", "任务当前未关联仓库，无法确认固定 Diff 的仓库身份");
  const { repo, isUrl } = resolveRepo(issue.repo_path);
  if (isUrl && !fs.existsSync(repo)) return legacy ? { ok: false, error: "repo cache not found" }
    : failure("diff_unavailable", "本地仓库缓存不存在，无法读取固定版本 Diff", 404);
  try {
    await ensureGitAvailable();
    if (!legacy) {
      try {
        const actual = await readGitRepositoryIdentity(task.work_dir!);
        const expected = await readGitRepositoryIdentity(repo);
        if (!sameGitRepository(actual, expected)) return failure("repository_mismatch", "任务工作区与当前仓库身份不一致");
      } catch { return failure("repository_mismatch", "无法确认任务工作区所属仓库，请保留现场并检查仓库绑定"); }
    }
    const base = legacy ? (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim() : task.target_branch!;
    const baseCommit = legacy ? (await git(repo, ["merge-base", `refs/heads/${base}`, `refs/heads/${branch}`])).trim() : task.base_commit!;
    const headCommit = legacy ? (await git(repo, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`])).trim() : task.head_commit!;
    if (!legacy) {
      try {
        for (const sha of [baseCommit, headCommit]) {
          if ((await git(repo, ["cat-file", "-t", sha])).trim() !== "commit") throw new Error("不是提交对象");
        }
      } catch { return failure("diff_object_missing", "保存的基线或交付提交对象不存在，不能改用当前分支", 404); }
    }
    const args = ["diff", "--no-ext-diff", "--no-textconv"];
    const range = `${baseCommit}..${headCommit}`;
    const diffStat = await gitLimited(repo, [...args, "--stat", range, "--"], MAX_DIFF_TEXT);
    const diffText = await gitLimited(repo, [...args, range, "--"], MAX_DIFF_TEXT);
    return { ok: true, data: { branch, base, diff_stat: diffStat.text, diff_text: diffText.text,
      truncated: diffStat.truncated || diffText.truncated, delivery_contract_version: legacy ? 1 : 2,
      base_commit: legacy ? null : baseCommit, head_commit: legacy ? null : headCommit } };
  } catch (error) {
    return failure("diff_unavailable", `读取 Diff 失败：${diagnostic(error)}`, 503);
  }
}

async function commitAt(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

async function hasGitOperation(repo: string): Promise<boolean> {
  const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
  return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "index.lock"]
    .some((name) => fs.existsSync(path.join(gitDir, name)));
}

/** S1 临界检查。完整持久仓库绑定、裁决与 Server/Runner 共用锁在后续阶段补齐。 */
async function checkMergeState(db: Db, task: Task, intent: IntegrationIntent): Promise<ReviewFailure | null> {
  const repo = intent.repo_path;
  const identity = await readGitRepositoryIdentity(repo);
  if (!sameGitRepository(identity, { real_path: intent.repo_common_dir, dev: intent.repo_dev, ino: intent.repo_ino })) {
    return failure("git_state_changed", "合入目标的仓库身份发生变化");
  }
  if (await hasGitOperation(repo) || (task.work_dir && await hasGitOperation(task.work_dir))) {
    return failure("git_state_changed", "仓库存在未结束的 Git 操作，请先处理已有现场");
  }
  const branch = (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim();
  if (branch !== intent.target_branch || await commitAt(repo, "HEAD") !== intent.target_head) {
    return failure("git_state_changed", "目标分支或提交已变化，请重新执行任务后审查");
  }
  if (await commitAt(repo, `refs/heads/${intent.task_branch}`) !== intent.task_head) {
    return failure("git_state_changed", "任务分支已前进，不能合入旧交付之外的改动");
  }
  if ((await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()) {
    return failure("git_state_changed", "目标工作区不干净，不能合入");
  }
  if (task.work_dir) {
    if (!sameGitRepository(identity, await readGitRepositoryIdentity(task.work_dir))) {
      return failure("git_state_changed", "任务工作区与合入目标不属于同一仓库");
    }
    if ((await git(task.work_dir, ["symbolic-ref", "--short", "HEAD"])).trim() !== intent.task_branch
      || await commitAt(task.work_dir, "HEAD") !== intent.task_head
      || (await git(task.work_dir, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()) {
      return failure("git_state_changed", "任务工作区的分支、HEAD 或 clean 状态已变化");
    }
  }
  if (task.delivery_contract_version === 2) {
    if (!task.work_dir || task.base_commit !== intent.target_head) return failure("base_advanced", "目标分支已偏离任务基线，请显式重新执行任务");
    const report = getDeliveryReport(db, task.id);
    const run = db.$client.prepare("SELECT * FROM verification_runs WHERE id=? AND task_id=?").get(task.verification_run_id, task.id) as any;
    if (!task.delivered_at || !report || report.report_head_commit !== intent.task_head || task.worktree_clean !== true) {
      return failure("evidence_incomplete", "交付报告、HEAD 或 clean 证据不完整，不能合入");
    }
    if (!run || run.base_commit !== task.base_commit || run.verification_sha !== intent.task_head
      || run.status !== "passed" || task.verification_status !== "passed") {
      return failure("verification_blocked", "当前交付没有同一提交上的通过验证记录，不能普通合入");
    }
  }
  return null;
}

/** 副作用前保存固定意图；失败/未知保留现场，普通重试不再次 merge 或 push。 */
export async function mergeTaskBranch(db: Db, taskId: string): Promise<MergeResult> {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "task not found" };
  const existing = findIntegrationAttempt(db, taskId);
  if (existing) {
    if (existing.status === "completed") return { ok: true, replayed: true,
      data: { ok: true, merged_branch: existing.task_branch, target: existing.target_branch } };
    return failure("recovery_required", existing.error || "已有未确认的合入操作。现场已保留，请先核对操作结果；普通重试不会再次执行。");
  }
  if (task.status !== "completed") return { ok: false, error: `task status is ${task.status}, not completed` };
  const legacy = task.delivery_contract_version === 1;
  if (!legacy && (!validSha(task.head_commit) || !validSha(task.base_commit) || !task.target_branch || !task.work_dir)) {
    return failure("evidence_incomplete", "任务缺少 Git 锚点，不能合入");
  }
  const branch = legacy ? parseBranch(task.result_json) : task.task_branch;
  if (!branch) return { ok: false, error: "no branch" };
  const issue = getIssue(db, task.issue_id);
  if (!issue?.repo_path) return { ok: false, error: "no repo" };
  const { repo, isUrl } = resolveRepo(issue.repo_path);
  if (isUrl && !fs.existsSync(repo)) return { ok: false, error: "repo cache not found" };
  let attemptId: string | null = null;
  let localMerged = false;
  try {
    await ensureGitAvailable();
    if (isUrl && (await git(repo, ["remote", "get-url", "--push", "--all", "origin"])).trim() !== issue.repo_path) {
      return failure("git_state_changed", "缓存的推送地址与仓库配置不一致，不能推送");
    }
    await git(repo, ["check-ref-format", `refs/heads/${branch}`]);
    const target = legacy ? (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim() : task.target_branch!;
    await git(repo, ["check-ref-format", `refs/heads/${target}`]);
    if (branch === target) return failure("git_state_changed", "任务分支不能与合入目标相同");
    const identity = await readGitRepositoryIdentity(repo);
    const intent: IntegrationIntent = { task_id: task.id, repo_key: gitRepositoryKey(identity),
      repo_path: repo, repo_common_dir: identity.real_path, repo_dev: identity.dev, repo_ino: identity.ino,
      task_branch: branch, target_branch: target,
      task_head: legacy ? await commitAt(repo, `refs/heads/${branch}`) : task.head_commit!, target_head: await commitAt(repo, "HEAD") };
    const blocked = await checkMergeState(db, task, intent);
    if (blocked) return blocked;
    const reserved = reserveIntegrationAttempt(db, intent);
    if (!reserved.acquired) return failure(reserved.conflict === "repository" ? "integration_busy" : "recovery_required",
      "仓库或任务已有持久合入操作，请先核对该操作结果");
    attemptId = reserved.attempt.id;
    const changed = await checkMergeState(db, task, intent);
    if (changed || getIssue(db, task.issue_id)?.repo_path !== issue.repo_path) {
      const message = changed?.error ?? "仓库配置已变化";
      requireIntegrationRecovery(db, attemptId, message);
      return failure("recovery_required", message);
    }
    // 分支只用于校验；执行始终使用已经持久化的完整 SHA。
    // 失败时不自动 abort：跨进程锁尚未接通，无法证明当前冲突一定属于本次操作。
    await git(repo, ["merge", "--no-ff", intent.task_head, "-m", `合入 Anvil 任务 ${task.id.slice(0, 8)}`]);
    localMerged = true;
    const mergeCommit = await commitAt(repo, "HEAD");
    const parents = (await git(repo, ["rev-list", "--parents", "-n", "1", mergeCommit, "--"])).trim().split(/\s+/);
    if ((await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim() !== target
      || (mergeCommit !== intent.target_head && (parents.length !== 3 || parents[1] !== intent.target_head || parents[2] !== intent.task_head))) {
      throw new Error("Git 返回后的目标或合入提交与持久意图不一致，结果需核对");
    }
    await git(repo, ["merge-base", "--is-ancestor", intent.task_head, mergeCommit]);
    setIntegrationLocalMerged(db, attemptId, mergeCommit);
    if (isUrl) {
      if ((await git(repo, ["remote", "get-url", "--push", "--all", "origin"])).trim() !== issue.repo_path) throw new Error("推送地址已变化，停止远端写入");
      try { await git(repo, ["push", "origin", `${mergeCommit}:refs/heads/${target}`]); }
      catch (error) { throw new Error(`推送远程失败：${diagnostic(error)}`); }
    }
    if (await commitAt(repo, "HEAD") !== mergeCommit || (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim() !== target) {
      throw new Error("合入后的目标现场已变化，完成结果需核对");
    }
    completeIntegrationAttempt(db, attemptId, () => {
      const now = new Date().toISOString();
      db.$client.prepare("UPDATE issues SET status='done', updated_at=? WHERE id=?").run(now, issue.id);
      addComment(db, issue.id, { author_type: "system", author_id: "system", type: "status_change",
        body: `${issue.status} → done（${isUrl ? "远端交付" : "本地交付"}：${branch} → ${target}，${mergeCommit}）` });
    });
    // 保留交付 worktree/分支以便审查与追溯，避免清理期间删除后来出现的改动。
    return { ok: true, data: { ok: true, merged_branch: branch, target } };
  } catch (error) {
    const message = `${localMerged ? "已合入本地，" : ""}${diagnostic(error)}`;
    if (attemptId) {
      // 此处若数据库也不可写，prepared/local_merged 原记录仍会阻止下一次普通重试。
      try { requireIntegrationRecovery(db, attemptId, message); } catch { /* 保留先前持久状态 */ }
      return failure("recovery_required", `${message}。现场已保留，请先核对结果。`);
    }
    return failure("git_state_changed", `合入前检查失败：${message}`);
  }
}
