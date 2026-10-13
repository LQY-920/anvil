import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { V2CompleteRequest, VerificationRun } from "@anvil/core";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { ensureGitAvailable, git as asyncGit } from "../src/lib/git.js";
import * as gitModule from "../src/lib/git.js";
import { GitHubError, type GitHubClient } from "../src/lib/github.js";

let app: FastifyInstance;
let temporaryRoot: string;
let remoteClient: HttpFakeGitHub;
const cloneUrl = "https://github.com/owner/repo.git";
class HttpFakeGitHub implements GitHubClient {
  pull: any = null;
  loseCreateResponse = false;
  creates = 0;
  async request<T>(_host: string, method: "GET" | "POST", endpoint: string, body?: any) {
    const url = new URL(endpoint, "https://github.com"), route = url.pathname;
    let data: any;
    if (route === "/user") data = { login: "test-owner" };
    else if (route === "/repos/owner/repo") data = { id: 42, full_name: "owner/repo", clone_url: cloneUrl, default_branch: "main", permissions: { push: true } };
    else if (route.includes("/branches/")) data = { name: "main" };
    else if (route.includes("/git/ref/heads/")) {
      try { data = { object: { sha: git(path.join(temporaryRoot, "remote.git"), ["rev-parse", "--verify", `refs/heads/${decodeURIComponent(route.split("/heads/")[1])}`]) } }; }
      catch { throw new GitHubError("分支不存在", 404); }
    } else if (route.endsWith("/pulls") && method === "POST") {
      this.creates++;
      this.pull = { id: 501, number: 1, html_url: "https://github.com/owner/repo/pull/1", body: body.body, state: "open", merged: false, merge_commit_sha: null,
        head: { ref: body.head, sha: git(path.join(temporaryRoot, "remote.git"), ["rev-parse", `refs/heads/${body.head}`]), repo: { id: 42 } }, base: { ref: body.base, repo: { id: 42 } } };
      if (this.loseCreateResponse) { this.loseCreateResponse = false; throw new GitHubError("响应丢失", 503, "github_transport_error", true, 0, true); }
      data = this.pull;
    } else if (route.endsWith("/pulls")) data = this.pull ? [this.pull] : [];
    else if (route.endsWith("/pulls/1")) data = this.pull;
    else if (route.endsWith("/check-runs")) data = { check_runs: [] };
    else if (route.endsWith("/status")) data = { statuses: [] };
    else throw new Error(`未模拟接口 ${endpoint}`);
    return { data: data as T, headers: {} };
  }
}

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
async function deliveredTask(contents = "基础内容\n交付内容\n", options: { reportHead?: "base"; bound?: boolean; github?: boolean } = {}) {
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
  if (options.github) {
    git(repo, ["clone", "--bare", repo, path.join(temporaryRoot, "remote.git")]);
    git(repo, ["remote", "add", "origin", cloneUrl]);
  }
  const branch = "task/fixed-diff";
  git(repo, ["worktree", "add", "-b", branch, workDir, base]);

  const token = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const daemonHeaders = { authorization: `Bearer ${token}` };
  const agent = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "固定版本测试", provider: "kimi" } })).json();
  let repositoryId: string | undefined;
  if (options.bound) {
    const binding = await app.inject({ method: "POST", url: "/api/repositories", payload: { mode: options.github ? "github_pr" : "local_git", repo: options.github ? cloneUrl : repo, checkout_path: repo, target_branch: "main" } });
    expect(binding.statusCode, binding.body).toBe(201);
    repositoryId = binding.json().id;
  }
  const issueResponse = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "固定版本审查", repo_path: repo, repository_id: repositoryId, assignee_type: "agent", assignee_id: agent.id },
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
  return { repo, workDir, base, head, branch, taskId, issueId, repositoryId };
}

function evidenceSnapshot() {
  return Object.fromEntries([
    "tasks", "issues", "comments", "task_delivery_reports", "verification_runs", "verification_checks", "review_measurements",
  ].map(table => [table, app.db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

beforeEach(async () => {
  await ensureGitAvailable();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-review-v2-"));
  remoteClient = new HttpFakeGitHub();
  app = await buildApp({ dbPath: ":memory:", logger: false, github: remoteClient, integrationPolling: false,
    githubOptions: { git: (cwd, args) => asyncGit(cwd, args.includes("fetch") || args.includes("push") ? args.map(value => value === cloneUrl ? path.join(temporaryRoot, "remote.git") : value) : args) } });
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

async function latestGate(taskId: string) {
  const response = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/integration` });
  expect(response.statusCode, response.body).toBe(200);
  const gate = response.json().gate;
  return { gate, request: { expected_head: gate.expected_head, expected_version: gate.evidence_version } };
}
async function approve(taskId: string, extra: Record<string, unknown> = {}) {
  const { request } = await latestGate(taskId);
  const response = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/decisions`, headers: { "idempotency-key": "decision-test-01" }, payload: { ...request, result: "approved", ...extra } });
  return { response, request };
}
async function integrate(taskId: string, request: object, key = "integration-test-01") {
  return app.inject({ method: "POST", url: `/api/tasks/${taskId}/integrate`, headers: { "idempotency-key": key }, payload: request });
}

describe("T01 真实 Gate 与 GitHub HTTP 闭环", () => {
  it("先建 PR 再裁决，压缩合并后同步完成；四种事实各自保存", async () => {
    const f = await deliveredTask(undefined, { bound: true, github: true });
    const { request } = await latestGate(f.taskId);
    const created = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/pull-request`, headers: { "idempotency-key": "http-create-01" }, payload: request });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json(), created.body).toMatchObject({ state: "succeeded", decision_id: null });
    const approval = await approve(f.taskId);
    expect(approval.response.statusCode, approval.response.body).toBe(200);
    git(f.repo, ["merge", "--squash", f.head]); git(f.repo, ["commit", "-m", "压缩合入"]);
    const merge = git(f.repo, ["rev-parse", "HEAD"]);
    git(f.repo, ["push", path.join(temporaryRoot, "remote.git"), "main"]);
    Object.assign(remoteClient.pull, { merged: true, state: "closed", merge_commit_sha: merge });
    const sync = await app.inject({ method: "POST", url: `/api/repositories/${f.repositoryId}/sync` });
    expect(sync.statusCode, sync.body).toBe(200);
    expect((await app.inject(`/api/issues/${f.issueId}`)).json().issue.status).toBe("done");
    expect((await latestGate(f.taskId)).gate.blockers.some((b: any) => b.code === "base_advanced")).toBe(true);
    expect(app.db.prepare("SELECT head_commit FROM review_decisions WHERE task_id=?").get(f.taskId)).toEqual({ head_commit: f.head });
    expect(merge).not.toBe(f.head);
  }, 35_000);

  it("创建响应丢失后 PR 已合并且删除远端分支，真实 Gate 仍可只读恢复关联", async () => {
    const f = await deliveredTask(undefined, { bound: true, github: true });
    const approval = await approve(f.taskId);
    remoteClient.loseCreateResponse = true;
    const created = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/pull-request`, headers: { "idempotency-key": "http-create-02" }, payload: approval.request });
    expect(created.json(), created.body).toMatchObject({ state: "unknown" });
    git(f.repo, ["merge", "--squash", f.head]); git(f.repo, ["commit", "-m", "压缩合入"]);
    git(f.repo, ["push", path.join(temporaryRoot, "remote.git"), "main", `:refs/heads/${f.branch}`]);
    Object.assign(remoteClient.pull, { merged: true, state: "closed", merge_commit_sha: git(f.repo, ["rev-parse", "HEAD"]) });
    const recovered = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/operations/${created.json().id}/recover`, headers: { "idempotency-key": "http-recover-02" }, payload: approval.request });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json(), recovered.body).toMatchObject({ state: "succeeded" });
    expect(remoteClient.creates).toBe(1);
    expect(() => git(path.join(temporaryRoot, "remote.git"), ["rev-parse", "--verify", `refs/heads/${f.branch}`])).toThrow();
    await app.inject({ method: "POST", url: `/api/repositories/${f.repositoryId}/sync` });
    expect((await app.inject(`/api/issues/${f.issueId}`)).json().issue.status).toBe("done");
  }, 35_000);

  it("PR 远端 HEAD 改变后实时刷新阻止旧 Task 批准", async () => {
    const f = await deliveredTask(undefined, { bound: true, github: true });
    const { request } = await latestGate(f.taskId);
    const created = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/pull-request`, headers: { "idempotency-key": "http-create-03" }, payload: request });
    expect(created.json().state, created.body).toBe("succeeded");
    remoteClient.pull.head.sha = "a".repeat(40);
    const { gate } = await latestGate(f.taskId);
    expect(gate.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "pr_head_changed", kind: "integrity" })]));
    expect((await approve(f.taskId)).response.statusCode).toBe(409);
  }, 30_000);
});

describe("T01 实时裁决和本地交付", () => {
  it("本地 merge 期间新增返工任务，旧操作成功但不把新工作项标记 done", async () => {
    const f = await deliveredTask(undefined, { bound: true });
    const approved = await approve(f.taskId), original = gitModule.git;
    let nextId = "";
    const spy = vi.spyOn(gitModule, "git").mockImplementation(async (cwd, args) => {
      const output = await original(cwd, args);
      if (args[0] === "merge") {
        const next = await app.inject({ method: "POST", url: `/api/issues/${f.issueId}/rerun` });
        expect(next.statusCode).toBe(201); nextId = next.json().id;
      }
      return output;
    });
    try {
      const result = await integrate(f.taskId, approved.request);
      expect(result.json(), result.body).toMatchObject({ state: "succeeded" });
      expect((await app.inject(`/api/issues/${f.issueId}`)).json().issue.status).not.toBe("done");
      expect((await app.inject(`/api/tasks/${nextId}`)).json().task.status).toBe("queued");
    } finally { spy.mockRestore(); }
  }, 25_000);
  it("批准与合入分开；固定 SHA 成功交付；同键重放不增加任何事实", async () => {
    const f = await deliveredTask(undefined, { bound: true });
    const { response: approval, request } = await approve(f.taskId);
    expect(approval.statusCode, approval.body).toBe(200);
    expect((await app.inject(`/api/issues/${f.issueId}`)).json().issue.status).toBe("in_review");
    const response = await integrate(f.taskId, request);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ state: "succeeded", decision_id: approval.json().decision.id });
    const merge = git(f.repo, ["rev-parse", "HEAD"]);
    expect(git(f.repo, ["rev-list", "--parents", "-n", "1", merge]).split(/\s+/)).toEqual([merge, f.base, f.head]);
    expect((await app.inject(`/api/issues/${f.issueId}`)).json().issue.status).toBe("done");
    const before = evidenceSnapshot();
    const replay = await integrate(f.taskId, request);
    expect(replay.json()).toEqual(response.json());
    expect(evidenceSnapshot()).toEqual(before);
    const diff = (await app.inject(`/api/tasks/${f.taskId}/diff`)).json();
    expect(diff).toMatchObject({ base_commit: f.base, head_commit: f.head });
    expect(git(f.workDir, ["rev-parse", "HEAD"])).toBe(f.head);
  }, 20_000);

  it.each([["任务分支", "head_changed"], ["目标分支", "base_advanced"]])("%s前进保留原验证并阻止批准和覆盖", async (kind, code) => {
    const f = await deliveredTask(undefined, { bound: true });
    commitFile(kind === "任务分支" ? f.workDir : f.repo, "later.txt", "之后的内容\n", "推进分支");
    const before = evidenceSnapshot();
    const { gate } = await latestGate(f.taskId);
    expect(gate.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code, kind: "integrity" })]));
    expect(gate.can_override).toBe(false);
    const { response } = await approve(f.taskId);
    expect(response.statusCode).toBe(409);
    expect(evidenceSnapshot()).toEqual(before);
  }, 20_000);

  it("质量失败必须理由与二次确认，覆盖可交付但不会篡改 failed 证据", async () => {
    const f = await deliveredTask("基础内容\n交付内容带尾随空格 \n", { bound: true });
    const normal = await approve(f.taskId);
    expect(normal.response.statusCode).toBe(409);
    const missing = await approve(f.taskId, { result: "overridden", reason: "接受此文本空格" });
    expect(missing.response.statusCode).toBe(400);
    const accepted = await approve(f.taskId, { result: "overridden", reason: "接受此文本空格", confirmed: true });
    expect(accepted.response.statusCode, accepted.response.body).toBe(200);
    expect(accepted.response.json().decision.result).toBe("overridden");
    const result = await integrate(f.taskId, accepted.request);
    expect(result.json().state).toBe("succeeded");
    expect((await app.inject(`/api/tasks/${f.taskId}`)).json().task.verification_status).toBe("failed");
  }, 20_000);

  it("报告 SHA 不一致不可覆盖，旧 v2 合入入口明确拒绝", async () => {
    const f = await deliveredTask(undefined, { reportHead: "base", bound: true });
    const { gate } = await latestGate(f.taskId);
    expect(gate.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "report_head_mismatch" })]));
    const response = (await approve(f.taskId, { result: "overridden", reason: "仍然不允许", confirmed: true })).response;
    expect(response.statusCode).toBe(409);
    const legacy = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/merge` });
    expect(legacy.json().code).toBe("modern_integration_required");
  }, 20_000);

  it("同请求裁决幂等，不同裁决冲突；批准后现场变化不准合入", async () => {
    const f = await deliveredTask(undefined, { bound: true });
    const approved = await approve(f.taskId);
    expect((await approve(f.taskId)).response.json()).toEqual(approved.response.json());
    const rejected = await approve(f.taskId, { result: "rejected", reason: "改变主意" });
    expect(rejected.response.statusCode).toBe(409);
    fs.writeFileSync(path.join(f.workDir, "dirty.txt"), "未保存");
    expect((await integrate(f.taskId, approved.request)).statusCode).toBe(409);
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(f.base);
    expect(app.db.$client.prepare("SELECT count(*) AS n FROM review_decisions").get()).toEqual({ n: 1 });
  }, 20_000);

  it("返工创建新 Task，原裁决和原输入保持且不复用工作区", async () => {
    const f = await deliveredTask(undefined, { bound: true });
    const result = await approve(f.taskId, { result: "rejected", reason: "请补充验收说明" });
    expect(result.response.statusCode, result.response.body).toBe(200);
    const next = (await app.inject(`/api/tasks/${result.response.json().next_task_id}`)).json().task;
    expect(next).toMatchObject({ status: "queued", parent_task_id: f.taskId, work_dir: null });
    expect(next.task_branch).toBeNull();
    expect(next.repository_snapshot_json).toBeTruthy();
    expect(git(f.workDir, ["rev-parse", "HEAD"])).toBe(f.head);
  }, 20_000);

  it("Git 成功但数据库完成失败后可查询恢复为新操作，不第二次批准或合入", async () => {
    const f = await deliveredTask(undefined, { bound: true });
    const approved = await approve(f.taskId);
    app.db.$client.exec("CREATE TRIGGER fail_done BEFORE UPDATE OF status ON issues WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT, '测试完成事务失败'); END");
    const failed = await integrate(f.taskId, approved.request);
    expect(failed.json().state).toBe("unknown");
    const merge = git(f.repo, ["rev-parse", "HEAD"]);
    expect(merge).not.toBe(f.base);
    expect((await app.inject(`/api/issues/${f.issueId}`)).json().issue.status).toBe("in_review");
    app.db.$client.exec("DROP TRIGGER fail_done");
    const recovered = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/operations/${failed.json().id}/recover`, headers: { "idempotency-key": "recover-test-01" }, payload: approved.request });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().state).toBe("succeeded");
    expect(recovered.json().id).not.toBe(failed.json().id);
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(merge);
    expect(app.db.$client.prepare("SELECT count(*) AS n FROM review_decisions").get()).toEqual({ n: 1 });
    expect((await latestGate(f.taskId)).gate.blockers.some((b: any) => b.code === "base_advanced")).toBe(true);
    const before = evidenceSnapshot();
    const oldRecovery = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/operations/${failed.json().id}/recover`, headers: { "idempotency-key": "recover-old-again" }, payload: approved.request });
    expect(oldRecovery.statusCode).toBe(409);
    expect(oldRecovery.json().code).toBe("operation_conflict");
    expect(evidenceSnapshot()).toEqual(before);
  }, 20_000);

  it("refs/replace 不改变固定 Diff 和合入对象", async () => {
    const f = await deliveredTask(undefined, { bound: true });
    git(f.workDir, ["switch", "--detach", f.base]);
    const replacement = commitFile(f.workDir, "file.txt", "基础内容\n替代内容\n", "替换对象");
    git(f.workDir, ["switch", f.branch]);
    git(f.repo, ["replace", f.head, replacement]);
    const diff = (await app.inject(`/api/tasks/${f.taskId}/diff`)).json();
    expect(diff.diff_text).toContain("+交付内容");
    const approved = await approve(f.taskId);
    expect(approved.response.statusCode, approved.response.body).toBe(200);
    expect((await integrate(f.taskId, approved.request)).json().state).toBe("succeeded");
    expect(fs.readFileSync(path.join(f.repo, "file.txt"), "utf8")).toBe("基础内容\n交付内容\n");
  }, 20_000);

  it("历史未绑定 v2 只允许查看 Diff，不能经旧入口交付", async () => {
    const f = await deliveredTask();
    const result = await app.inject({ method: "POST", url: `/api/tasks/${f.taskId}/merge` });
    expect(result.json().code).toBe("modern_integration_required");
    expect((await latestGate(f.taskId)).gate.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "repository_binding_required" })]));
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(f.base);
  }, 20_000);
});
