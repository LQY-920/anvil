import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { V2CompleteRequest, VerificationRun } from "@anvil/core";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { ensureGitAvailable } from "../src/lib/git.js";

let app: FastifyInstance;
let temporaryRoot: string;

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFile(repo: string, file: string, contents: string, message: string): string {
  fs.writeFileSync(path.join(repo, file), contents);
  git(repo, ["add", "--", file]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** 以真实工作树和 daemon/Agent API 建立完整 v2 交付，损坏场景只在交付后修改对应事实。 */
async function deliveredTask(contents = "基础内容\n交付内容\n", options: { reportHead?: "base" } = {}) {
  const repo = path.join(temporaryRoot, "repo");
  const workDir = path.join(temporaryRoot, "worktree");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@anvil.local"]);
  git(repo, ["config", "user.name", "Anvil 测试"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  git(repo, ["config", "gc.auto", "0"]);
  const policy = JSON.stringify({
    version: 1,
    commands: [{ id: "diff-check", label: "检查交付空白", command: "git diff --check HEAD~1 HEAD", required: true, timeout_ms: 5000 }],
  });
  fs.writeFileSync(path.join(repo, "ANVIL.verify.json"), policy);
  fs.writeFileSync(path.join(repo, ".gitattributes"), "file.txt diff=reviewProbe\n");
  fs.writeFileSync(path.join(repo, "file.txt"), "基础内容\n");
  git(repo, ["add", "ANVIL.verify.json", ".gitattributes", "file.txt"]);
  git(repo, ["commit", "-m", "建立测试基线"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const branch = "task/fixed-diff";
  git(repo, ["worktree", "add", "-b", branch, workDir, base]);

  const token = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const daemonHeaders = { authorization: `Bearer ${token}` };
  const agent = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "固定版本测试", provider: "kimi" } })).json();
  const issueResponse = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "固定版本审查", repo_path: repo, assignee_type: "agent", assignee_id: agent.id },
  });
  expect(issueResponse.statusCode).toBe(201);
  const issueId: string = issueResponse.json().id;
  const registered = await app.inject({
    method: "POST", url: "/api/daemon/register", headers: daemonHeaders,
    payload: { daemon_id: "fixed-diff-daemon", runtimes: [{ provider: "kimi", version: "test" }] },
  });
  expect(registered.statusCode).toBe(200);
  const claimed = await app.inject({
    method: "POST", url: "/api/daemon/claim", headers: daemonHeaders, payload: { daemon_id: "fixed-diff-daemon" },
  });
  expect(claimed.statusCode).toBe(200);
  const pkg = claimed.json().tasks[0];
  const taskId: string = pkg.task.id;
  const started = await app.inject({
    method: "POST", url: `/api/daemon/tasks/${taskId}/start`, headers: daemonHeaders,
    payload: { daemon_id: "fixed-diff-daemon", work_dir: workDir, task_branch: branch, target_branch: "main", base_commit: base, delivery_contract_version: 2 },
  });
  expect(started.statusCode).toBe(200);
  const head = commitFile(workDir, "file.txt", contents, "保存待审查交付");
  const reportHead = options.reportHead === "base" ? base : head;
  const reported = await app.inject({
    method: "PUT", url: `/api/daemon/tasks/${taskId}/delivery-report`, headers: { authorization: `Bearer ${pkg.task_token}` },
    payload: {
      schema_version: 1, report_head_commit: reportHead, problem_understanding: "检查固定版本比较", solution_summary: "提交可审查文本",
      changed_areas: [{ path: "file.txt", summary: "新增交付内容" }], risks: [], unresolved: [],
    },
  });
  expect(reported.statusCode).toBe(200);
  const startedAt = new Date();
  const check = spawnSync("git", ["diff", "--check", "HEAD~1", "HEAD"], { cwd: workDir, encoding: "utf8", windowsHide: true });
  if (check.error) throw check.error;
  if (check.status === null) throw new Error("验证进程未返回退出码");
  const verificationStatus = check.status === 0 ? "passed" : "failed";
  const output = `${check.stdout}${check.stderr}`.trim();
  const completedAt = new Date();
  expect(git(workDir, ["status", "--porcelain"])).toBe("");
  const verification: VerificationRun = {
    schema_version: 1, policy_source: "ANVIL.verify.json", policy_hash: createHash("sha256").update(policy).digest("hex"),
    verification_sha: head, status: verificationStatus, started_at: startedAt.toISOString(), completed_at: completedAt.toISOString(),
    checks: [{ id: "diff-check", label: "检查交付空白", command: "git diff --check HEAD~1 HEAD", required: true, status: verificationStatus, exit_code: check.status, duration_ms: completedAt.getTime() - startedAt.getTime(), output_excerpt: output }],
  };
  const completion: V2CompleteRequest = {
    daemon_id: "fixed-diff-daemon", branch, work_dir: workDir, base_commit: base, head_commit: head, worktree_clean: true, verification,
  };
  const completed = await app.inject({ method: "POST", url: `/api/daemon/tasks/${taskId}/complete`, headers: daemonHeaders, payload: completion });
  expect(completed.statusCode).toBe(200);
  const packet = reportHead !== head ? "integrity_blocked" : verificationStatus === "passed" ? "ready" : "verification_blocked";
  expect(completed.json()).toMatchObject({ status: "completed", review_packet_status: packet });
  return { repo, workDir, base, head, branch, taskId, issueId };
}

function evidenceSnapshot() {
  return Object.fromEntries([
    "tasks", "issues", "comments", "task_delivery_reports", "verification_runs", "verification_checks", "review_measurements",
  ].map(table => [table, app.db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

beforeEach(async () => {
  await ensureGitAvailable();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-review-v2-"));
  app = await buildApp({ dbPath: ":memory:", logger: false });
});

afterEach(async () => {
  await app?.close();
  if (!temporaryRoot) return;
  const root = path.resolve(temporaryRoot);
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("anvil-review-v2-")) {
    throw new Error("拒绝清理非本用例创建的临时目录");
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("T01 v2 固定版本 Diff", () => {
  it("任务与目标分支均推进后仍比较保存的 SHA，忽略 result_json 分支且 GET 不修改证据或 refs", async () => {
    const fixture = await deliveredTask();
    const advancedTask = commitFile(fixture.workDir, "later-task.txt", "任务后来推进\n", "任务分支后续提交");
    const advancedTarget = commitFile(fixture.repo, "later-main.txt", "目标后来推进\n", "目标分支后续提交");
    app.db.$client.prepare("UPDATE tasks SET result_json=json_set(result_json, '$.branch', '不存在的旧结果分支') WHERE id=?").run(fixture.taskId);
    const before = evidenceSnapshot();
    const refs = git(fixture.repo, ["show-ref"]);
    const response = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      branch: fixture.branch, base: "main", delivery_contract_version: 2, base_commit: fixture.base, head_commit: fixture.head, truncated: false,
    });
    expect(response.json().diff_stat).toContain("file.txt");
    expect(response.json().diff_text).toContain("+交付内容");
    expect(response.json().diff_text).not.toMatch(/later-task|later-main|后来推进/);
    expect(evidenceSnapshot()).toEqual(before);
    expect(git(fixture.repo, ["show-ref"])).toBe(refs);
    expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(advancedTarget);
    expect(git(fixture.workDir, ["rev-parse", "HEAD"])).toBe(advancedTask);
    expect(git(fixture.repo, ["status", "--porcelain"])).toBe("");
    expect(git(fixture.workDir, ["status", "--porcelain"])).toBe("");
  }, 15_000);

  it("v2 锚点缺失时返回明确冲突，不用仍然存在的 result_json.branch 回退历史比较", async () => {
    const fixture = await deliveredTask();
    app.db.$client.prepare("UPDATE tasks SET base_commit=NULL WHERE id=?").run(fixture.taskId);
    const response = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "diff_anchors_missing", error: expect.any(String) });
    expect(response.json()).not.toHaveProperty("diff_text");
  }, 15_000);

  it("已交付的真实提交对象丢失时返回 404，不重新选择其他 HEAD", async () => {
    const fixture = await deliveredTask();
    const objectPath = path.join(fixture.repo, ".git", "objects", fixture.head.slice(0, 2), fixture.head.slice(2));
    expect(fs.existsSync(objectPath)).toBe(true);
    fs.unlinkSync(objectPath);
    const response = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "diff_object_missing", error: expect.any(String) });
  }, 15_000);

  it("另一个仓库即使包含同一提交也被拒绝，工作目录丢失同样明确阻塞", async () => {
    const fixture = await deliveredTask();
    const otherRepo = path.join(temporaryRoot, "other-repo");
    git(temporaryRoot, ["clone", "--no-local", fixture.repo, otherRepo]);
    expect(git(otherRepo, ["cat-file", "-t", fixture.head])).toBe("commit");
    app.db.$client.prepare("UPDATE issues SET repo_path=? WHERE id=?").run(otherRepo, fixture.issueId);
    const mismatch = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: "repository_mismatch", error: expect.any(String) });
    app.db.$client.prepare("UPDATE issues SET repo_path=? WHERE id=?").run(fixture.repo, fixture.issueId);
    app.db.$client.prepare("UPDATE tasks SET work_dir=? WHERE id=?").run(path.join(temporaryRoot, "missing-worktree"), fixture.taskId);
    const missing = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: "repository_mismatch", error: expect.any(String) });
  }, 15_000);

  it("中文大 Diff 按 UTF-8 字节截断，并且不执行仓库配置的 external diff 或 textconv", async () => {
    const contents = "基础内容\n" + Array.from({ length: 6000 }, (_, index) => `交付内容第 ${index} 行\n`).join("");
    const fixture = await deliveredTask(contents);
    const probe = path.join(temporaryRoot, "diff-probe.cjs");
    const externalMarker = path.join(temporaryRoot, "external-ran");
    const textconvMarker = path.join(temporaryRoot, "textconv-ran");
    fs.writeFileSync(probe, 'require("node:fs").writeFileSync(process.argv[2], "执行过"); process.stdout.write("转换后文本\\n");');
    // Git 的自定义 diff 命令使用 shell；只引用本用例创建的脚本和标记文件。
    const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    const command = (marker: string) => [process.execPath, probe, marker].map(quote).join(" ");
    git(fixture.repo, ["config", "diff.external", command(externalMarker)]);
    git(fixture.repo, ["config", "diff.reviewProbe.textconv", command(textconvMarker)]);
    const response = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.truncated).toBe(true);
    expect(body.diff_text).toContain("+交付内容第 0 行");
    expect(Buffer.byteLength(body.diff_text, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(body.diff_text).not.toContain("\uFFFD");
    expect(fs.existsSync(externalMarker)).toBe(false);
    expect(fs.existsSync(textconvMarker)).toBe(false);
  }, 15_000);
});

describe("T01 v2 合入检查与持久操作", () => {
  it("完整交付按保存的 base/head 合入，保留旧 Diff，重复请求不增加提交或数据库副作用", async () => {
    const fixture = await deliveredTask();
    const beforeTask = app.db.$client.prepare("SELECT * FROM tasks WHERE id=?").get(fixture.taskId);
    const response = await app.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/merge` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, merged_branch: fixture.branch, target: "main" });
    const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
    expect(git(fixture.repo, ["rev-list", "--parents", "-n", "1", mergeCommit]).split(/\s+/)).toEqual([mergeCommit, fixture.base, fixture.head]);
    const attempts = app.db.$client.prepare("SELECT * FROM integration_attempts WHERE task_id=?").all(fixture.taskId);
    expect(attempts).toEqual([expect.objectContaining({
      task_id: fixture.taskId, task_branch: fixture.branch, target_branch: "main", task_head: fixture.head,
      target_head: fixture.base, merge_commit: mergeCommit, status: "completed", error: null,
    })]);
    expect(app.db.$client.prepare("SELECT status FROM issues WHERE id=?").get(fixture.issueId)).toEqual({ status: "done" });
    expect(app.db.$client.prepare("SELECT * FROM tasks WHERE id=?").get(fixture.taskId)).toEqual(beforeTask);
    expect(fs.existsSync(fixture.workDir)).toBe(true);
    expect(git(fixture.workDir, ["rev-parse", "HEAD"])).toBe(fixture.head);
    const beforeReplay = evidenceSnapshot();
    const refs = git(fixture.repo, ["show-ref"]);
    const archivedDiff = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(archivedDiff.statusCode).toBe(200);
    expect(archivedDiff.json()).toMatchObject({ base_commit: fixture.base, head_commit: fixture.head });
    expect(archivedDiff.json().diff_text).toContain("+交付内容");
    const replay = await app.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/merge` });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(response.json());
    expect(evidenceSnapshot()).toEqual(beforeReplay);
    expect(app.db.$client.prepare("SELECT * FROM integration_attempts WHERE task_id=?").all(fixture.taskId)).toEqual(attempts);
    expect(git(fixture.repo, ["show-ref"])).toBe(refs);
    expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(mergeCommit);
  }, 15_000);

  it.each([
    ["任务分支", "git_state_changed"],
    ["目标分支", "base_advanced"],
  ] as const)("交付后%s前进时返回 %s，持久操作和 Git 均无新副作用", async (kind, code) => {
    const fixture = await deliveredTask();
    const changedRepo = kind === "任务分支" ? fixture.workDir : fixture.repo;
    commitFile(changedRepo, "later.txt", "交付后的新修改\n", "推进待检查分支");
    const before = evidenceSnapshot();
    const refs = git(fixture.repo, ["show-ref"]);
    const response = await app.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/merge` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code, error: expect.any(String) });
    expect(app.db.$client.prepare("SELECT * FROM integration_attempts").all()).toEqual([]);
    expect(evidenceSnapshot()).toEqual(before);
    expect(git(fixture.repo, ["show-ref"])).toBe(refs);
    expect(git(fixture.repo, ["status", "--porcelain"])).toBe("");
    expect(git(fixture.workDir, ["status", "--porcelain"])).toBe("");
    expect(fs.existsSync(path.join(fixture.repo, ".git", "MERGE_HEAD"))).toBe(false);
  }, 15_000);

  it.each([
    ["旧 Report", "evidence_incomplete"],
    ["失败 Verification", "verification_blocked"],
  ] as const)("真实完成接口保存%s后拒绝普通合入并保持未完成", async (kind, code) => {
    const fixture = kind === "旧 Report"
      ? await deliveredTask(undefined, { reportHead: "base" })
      : await deliveredTask("基础内容\n交付内容带尾随空格 \n");
    const before = evidenceSnapshot();
    const refs = git(fixture.repo, ["show-ref"]);
    const response = await app.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/merge` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code, error: expect.any(String) });
    expect(app.db.$client.prepare("SELECT status FROM issues WHERE id=?").get(fixture.issueId)).toEqual({ status: "in_review" });
    expect(app.db.$client.prepare("SELECT * FROM integration_attempts").all()).toEqual([]);
    expect(evidenceSnapshot()).toEqual(before);
    expect(git(fixture.repo, ["show-ref"])).toBe(refs);
    expect(git(fixture.repo, ["rev-parse", "HEAD"])).toBe(fixture.base);
    expect(git(fixture.workDir, ["rev-parse", "HEAD"])).toBe(fixture.head);
  }, 15_000);

  it("refs/replace 不改变存档 Diff 或合入内容，固定 SHA 始终指向原始提交对象", async () => {
    const fixture = await deliveredTask();
    git(fixture.workDir, ["switch", "--detach", fixture.base]);
    const replacement = commitFile(fixture.workDir, "file.txt", "基础内容\n替代提交内容\n", "构造替换对象");
    git(fixture.workDir, ["switch", fixture.branch]);
    git(fixture.repo, ["replace", fixture.head, replacement]);
    const diff = await app.inject({ method: "GET", url: `/api/tasks/${fixture.taskId}/diff` });
    expect(diff.statusCode).toBe(200);
    expect(diff.json()).toMatchObject({ base_commit: fixture.base, head_commit: fixture.head });
    expect(diff.json().diff_text).toContain("+交付内容");
    expect(diff.json().diff_text).not.toContain("替代提交内容");
    const merged = await app.inject({ method: "POST", url: `/api/tasks/${fixture.taskId}/merge` });
    expect(merged.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(fixture.repo, "file.txt"), "utf8")).toBe("基础内容\n交付内容\n");
    const mergeCommit = git(fixture.repo, ["rev-parse", "HEAD"]);
    expect(git(fixture.repo, ["--no-replace-objects", "rev-list", "--parents", "-n", "1", mergeCommit]).split(/\s+/)).toEqual([mergeCommit, fixture.base, fixture.head]);
    expect(git(fixture.repo, ["replace", "-l"])).toBe(fixture.head);
  }, 15_000);
});
