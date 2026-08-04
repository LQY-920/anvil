import type { Db } from "../db/client.js";
import type { MergeResponse, TaskDiffResponse } from "@anvil/core";
import { ensureGitAvailable, git } from "../lib/git.js";
import { addComment, getIssue } from "./issues.js";
import { getTask } from "./tasks.js";

/** diff_text 超过 50KB 截断（看板展示用，完整 diff 可去仓库看）。 */
const MAX_DIFF_TEXT = 50 * 1024;

export type DiffResult = { ok: true; data: TaskDiffResponse } | { ok: false; error: string };
export type MergeResult = { ok: true; data: MergeResponse } | { ok: false; error: string };

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

/** 任务分支相对 merge-base 的 diff（base = 仓库当前分支）。 */
export async function getTaskDiff(db: Db, taskId: string): Promise<DiffResult> {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "task not found" };
  const branch = parseBranch(task.result_json);
  if (!branch) return { ok: false, error: "no branch" };
  const issue = getIssue(db, task.issue_id);
  if (!issue?.repo_path) return { ok: false, error: "no repo" };
  await ensureGitAvailable();
  const repo = issue.repo_path;
  const base = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const mergeBase = (await git(repo, ["merge-base", base, branch])).trim();
  const diffStat = await git(repo, ["diff", "--stat", `${mergeBase}..${branch}`]);
  let diffText = await git(repo, ["diff", `${mergeBase}..${branch}`]);
  let truncated = false;
  if (diffText.length > MAX_DIFF_TEXT) {
    diffText = diffText.slice(0, MAX_DIFF_TEXT);
    truncated = true;
  }
  return { ok: true, data: { branch, base, diff_stat: diffStat, diff_text: diffText, truncated } };
}

/** 验收合并：任务分支 --no-ff 合入仓库当前分支，成功后清理 worktree/分支并把 issue 置 done。 */
export async function mergeTaskBranch(db: Db, taskId: string): Promise<MergeResult> {
  const task = getTask(db, taskId);
  if (!task) return { ok: false, error: "task not found" };
  if (task.status !== "completed") return { ok: false, error: `task status is ${task.status}, not completed` };
  const branch = parseBranch(task.result_json);
  if (!branch) return { ok: false, error: "no branch" };
  const issue = getIssue(db, task.issue_id);
  if (!issue?.repo_path) return { ok: false, error: "no repo" };
  await ensureGitAvailable();
  const repo = issue.repo_path;
  const target = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  try {
    await git(repo, ["merge", "--no-ff", branch, "-m", `merge: anvil task ${task.id.slice(0, 8)}`]);
  } catch (e: any) {
    // 冲突等合并失败：返回 stderr，DB 状态不动
    return { ok: false, error: e?.message ?? String(e) };
  }
  // 清理失败仅记录，不阻断合并结果
  if (task.work_dir) {
    try { await git(repo, ["worktree", "remove", "--force", task.work_dir]); }
    catch (e) { console.warn(`worktree remove failed: ${task.work_dir}`, e); }
  }
  try { await git(repo, ["branch", "-d", branch]); }
  catch (e) { console.warn(`branch -d failed: ${branch}`, e); }
  const now = new Date().toISOString();
  db.$client.prepare(`UPDATE issues SET status='done', updated_at=? WHERE id=?`).run(now, issue.id);
  addComment(db, issue.id, {
    author_type: "system", author_id: "system", type: "status_change",
    body: `${issue.status} → done（合并 ${branch} → ${target}）`,
  });
  return { ok: true, data: { ok: true, merged_branch: branch, target } };
}
