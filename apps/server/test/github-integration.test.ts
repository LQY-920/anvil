import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import type { IntegrationActionRequest, Repository, ReviewGate } from "@anvil/core";
import { createDb, newId, runMigrations, seed, type Db } from "../src/db/client.js";
import { git } from "../src/lib/git.js";
import { GitHubError, type GitHubClient } from "../src/lib/github.js";
import { createGitHubService, type GitHubService } from "../src/services/github-integration.js";
import { getIssueSource, getRepository } from "../src/services/repositories.js";
import { registerRepositoryRoutes } from "../src/routes/repositories.js";
import { Hub } from "../src/ws/hub.js";

// 本文件每条场景都会创建真实 Git/SQLite 现场；PR 恢复还包含多次 fetch/push。为 Windows 进程 IO 留出独立预算，断言与全局测试超时保持不变。
const gitR = (cwd: string, args: string[]) => execFileSync("git", ["--no-replace-objects", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
class FakeGitHub implements GitHubClient {
  fullName = "owner/repo"; repoId = 42; push = true; requests: Array<{ method: string; endpoint: string; body: any }> = [];
  source = { id: 101, number: 1, html_url: "https://github.com/owner/repo/issues/1", title: "来源标题", body: "初始描述", state: "open", updated_at: "2026-10-13T00:00:00.000Z" } as any;
  pulls: any[] = []; failAfterCreate = false; failReads: GitHubError | null = null;
  constructor(readonly remotePath: string) {}
  remoteHead(branch: string) { try { return gitR(this.remotePath, ["rev-parse", "--verify", `refs/heads/${branch}`]); } catch { return null; } }
  async request<T>(_host: string, method: "GET" | "POST", endpoint: string, body?: unknown) {
    this.requests.push({ method, endpoint, body });
    if (this.failReads && method === "GET") throw this.failReads;
    const url = new URL(endpoint, "https://github.com"), base = `/repos/${this.fullName}`;
    let data: any;
    if (url.pathname === "/user") data = { login: "tester" };
    else if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) data = { id: this.repoId, full_name: this.fullName, clone_url: `https://github.com/${this.fullName}.git`, default_branch: "main", permissions: { push: this.push, pull: true } };
    else if (url.pathname.startsWith(`${base}/branches/`)) data = { name: "main" };
    else if (url.pathname === `${base}/issues/1`) data = { ...this.source };
    else if (url.pathname.startsWith(`${base}/git/ref/heads/`)) {
      const value = this.remoteHead(decodeURIComponent(url.pathname.slice(`${base}/git/ref/heads/`.length)));
      if (!value) throw new GitHubError("Not Found", 404, "github_request_failed", false);
      data = { object: { sha: value } };
    } else if (url.pathname === `${base}/pulls` && method === "POST") {
      const request = body as any;
      data = { id: 501 + this.pulls.length, number: 10 + this.pulls.length, html_url: `https://github.com/${this.fullName}/pull/10`, state: "open", merged: false, merged_at: null,
        merge_commit_sha: null, body: request.body, head: { ref: request.head, sha: this.remoteHead(request.head), repo: { id: this.repoId } }, base: { ref: request.base, repo: { id: this.repoId } } };
      this.pulls.push(data);
      if (this.failAfterCreate) { this.failAfterCreate = false; throw new GitHubError("响应丢失", 503, "github_transport_error", true, 0, true); }
    } else if (url.pathname === `${base}/pulls`) data = this.pulls.map(pull => ({ ...pull, head: { ...pull.head, sha: pull.state === "open" ? this.remoteHead(pull.head.ref) ?? pull.head.sha : pull.head.sha } }));
    else if (new RegExp(`^${base}/pulls/\\d+$`).test(url.pathname)) {
      const found = this.pulls.find(pull => pull.number === Number(url.pathname.split("/").at(-1)));
      data = found && { ...found, head: { ...found.head, sha: found.state === "open" ? this.remoteHead(found.head.ref) ?? found.head.sha : found.head.sha } };
    } else if (url.pathname.endsWith("/check-runs")) data = { check_runs: [{ name: "GitHub CI", status: "completed", conclusion: "success", html_url: null }] };
    else if (url.pathname.endsWith("/status")) data = { statuses: [] };
    else throw new Error(`未配置模拟接口 ${method} ${endpoint}`);
    return { data: data as T, headers: {} };
  }
}

let directory: string, checkout: string, remote: string, db: Db, github: FakeGitHub, service: GitHubService, hub: Hub;
let clock: number, writes: string[][], afterPushFailure: boolean;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-github-integration-"));
  checkout = path.join(directory, "checkout"); remote = path.join(directory, "remote.git"); fs.mkdirSync(checkout);
  gitR(checkout, ["init", "-b", "main"]); gitR(checkout, ["config", "user.name", "Anvil Test"]); gitR(checkout, ["config", "user.email", "test@anvil.local"]);
  fs.writeFileSync(path.join(checkout, "file.txt"), "base\n"); gitR(checkout, ["add", "."]); gitR(checkout, ["commit", "-m", "基础"]);
  gitR(directory, ["clone", "--bare", checkout, remote]); gitR(checkout, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
  gitR(checkout, ["checkout", "-b", "task/t01"]); fs.appendFileSync(path.join(checkout, "file.txt"), "task\n"); gitR(checkout, ["commit", "-am", "任务"]); gitR(checkout, ["checkout", "main"]);
  db = createDb(":memory:"); runMigrations(db); seed(db); github = new FakeGitHub(remote); hub = new Hub();
  clock = Date.parse("2026-10-13T01:00:00.000Z"); writes = []; afterPushFailure = false;
  service = createGitHubService(db, hub, github, { now: () => clock, git: async (cwd, args) => {
    const action = args.includes("push") ? "push" : args.includes("fetch") ? "fetch" : null;
    if (action) writes.push(args);
    if (action === "push") expect((db.prepare("SELECT count(*) AS n FROM delivery_operations WHERE state='prepared'").get() as any).n).toBe(1);
    const mapped = action ? args.map(arg => arg === "https://github.com/owner/repo.git" ? remote : arg) : args;
    const result = await git(cwd, mapped);
    if (action === "push" && afterPushFailure) { afterPushFailure = false; throw new Error("push 响应丢失 https://user:secret@github.com/owner/repo.git"); }
    return result;
  } });
});
afterEach(async () => { await service.stop(); db.$client.close(); fs.rmSync(directory, { recursive: true, force: true }); });

async function bind(): Promise<Repository> {
  return service.bindRepository({ mode: "github_pr", repo: "git@github.com:owner/repo.git", checkout_path: checkout });
}
async function makeTask(repository: Repository, issueId?: string, branch = "task/t01") {
  issueId ??= (await service.importIssue(repository.id, { issue_number: 1 })).issue_id;
  const { workspace } = seed(db), taskId = newId(), agentId = newId(), created = new Date(clock++).toISOString();
  db.prepare("INSERT INTO agents(id,workspace_id,name,provider,status,max_concurrent_tasks,created_at) VALUES (?,?,'测试','kimi','idle',1,?)").run(agentId, workspace.id, created);
  const source = getIssueSource(db, issueId), head = gitR(checkout, ["rev-parse", branch]);
  const snapshot = { schema_version: 1, repository_id: repository.id, mode: repository.mode, host: repository.host, external_id: repository.external_id,
    full_name: repository.full_name, clone_url: repository.clone_url, target_branch: repository.target_branch, checkout_path: repository.checkout_path,
    identity: repository.identity, source_snapshot_id: source?.accepted.id ?? null, input: { title: source?.accepted.title ?? "工作", description: source?.accepted.body ?? null, acceptance: null } };
  db.prepare(`INSERT INTO tasks(id,workspace_id,issue_id,agent_id,status,delivery_contract_version,task_branch,target_branch,base_commit,head_commit,work_dir,worktree_clean,repository_id,source_snapshot_id,repository_snapshot_json,created_at)
    VALUES (?,?,?,?,'completed',2,?,'main',?,?,?,1,?,?,?,?)`)
    .run(taskId, workspace.id, issueId, agentId, branch, gitR(checkout, ["rev-parse", "main"]), head, checkout, repository.id, source?.accepted.id ?? null, JSON.stringify(snapshot), created);
  db.prepare("UPDATE issues SET status='in_review' WHERE id=?").run(issueId);
  const request: IntegrationActionRequest = { expected_head: head, expected_version: `version-${taskId}` };
  const gate = async (): Promise<ReviewGate> => ({ task_id: taskId, expected_head: head, evidence_version: request.expected_version,
    mode: "github_pr", repository: getRepository(db, repository.id), blockers: [], can_approve: true, can_override: true });
  return { taskId, issueId, head, request, gate, snapshot };
}
function approve(task: Awaited<ReturnType<typeof makeTask>>, repository: Repository, head = task.head) {
  db.prepare(`INSERT INTO review_decisions(id,task_id,repository_id,actor_id,result,reason,head_commit,evidence_version,request_key,payload_hash,snapshot_json,created_at)
    VALUES (?,?,?,'owner','approved','人工确认',?,?,?,'hash','{}',?)`)
    .run(newId(), task.taskId, repository.id, head, task.request.expected_version, newId(), new Date(clock++).toISOString());
}
function squashMerge() {
  gitR(checkout, ["merge", "--squash", "task/t01"]); gitR(checkout, ["commit", "-m", "压缩合并"]);
  const commit = gitR(checkout, ["rev-parse", "HEAD"]); gitR(checkout, ["push", remote, "main"]);
  Object.assign(github.pulls[0], { merged: true, merged_at: new Date(clock).toISOString(), state: "closed", merge_commit_sha: commit });
  return commit;
}

describe("仓库与 Issue 来源", () => {
  it("SSH/HTTPS 同稳定 ID 幂等，缺推送权限仍保留可读绑定", async () => {
    const first = await bind();
    const second = await service.bindRepository({ mode: "github_pr", repo: "https://github.com/owner/repo", checkout_path: checkout });
    expect(second.id).toBe(first.id); expect(second.version).toBe(first.version); expect(service.listRepositories()).toHaveLength(1);
    github.push = false;
    const readonly = await bind(); expect(readonly.can_push).toBe(false); expect(readonly.connection_status).toBe("permission_denied");
  }, 20_000);
  it("远端重命名需显式确认；同地址稳定 ID 被替换不能借用旧绑定", async () => {
    const first = await bind(); github.fullName = "owner/renamed";
    await expect(service.bindRepository({ mode: "github_pr", repo: "https://github.com/owner/renamed", checkout_path: checkout })).rejects.toMatchObject({ code: "repository_renamed" });
    const renamed = await service.bindRepository({ mode: "github_pr", repo: "https://github.com/owner/renamed", checkout_path: checkout, confirm_rename: true });
    expect(renamed.id).toBe(first.id); expect(renamed.version).toBe(first.version + 1);
    github.repoId = 999;
    await expect(service.importIssue(first.id, { issue_number: 1 })).rejects.toMatchObject({ code: "repository_mismatch" });
  }, 20_000);
  it("导入幂等且不派工；刷新只改 latest，接受来源不改已有 Task 输入", async () => {
    const repository = await bind();
    const imported = await service.importIssue(repository.id, { issue_number: 1 });
    expect((db.prepare("SELECT status,assignee_id FROM issues WHERE id=?").get(imported.issue_id) as any)).toMatchObject({ status: "backlog", assignee_id: null });
    expect((db.prepare("SELECT count(*) AS n FROM tasks").get() as any).n).toBe(0);
    const task = await makeTask(repository, imported.issue_id);
    github.source.title = "来源新标题"; github.source.body = "新描述"; github.source.updated_at = "2026-10-13T02:00:00.000Z";
    const repeated = await service.importIssue(repository.id, { issue_number: 1 });
    expect(repeated).toMatchObject({ issue_id: imported.issue_id, source_snapshot_id: imported.source_snapshot_id, disposition: "existing" });
    const source = service.getIssueSource(imported.issue_id)!;
    expect(source.changed).toBe(true); expect(source.accepted.title).toBe("来源标题"); expect(source.latest.title).toBe("来源新标题");
    service.acceptSource(imported.issue_id, source.latest.id);
    expect(service.getIssueSource(imported.issue_id)?.changed).toBe(false);
    const saved = db.prepare("SELECT repository_snapshot_json FROM tasks WHERE id=?").get(task.taskId) as any;
    expect(JSON.parse(saved.repository_snapshot_json).input.title).toBe("来源标题");
    expect((db.prepare("SELECT count(*) AS n FROM tasks").get() as any).n).toBe(1);
  }, 20_000);
  it("PR 不得作为 Issue 导入，来源版本变化返回冲突", async () => {
    const repository = await bind(); github.source.pull_request = {};
    await expect(service.importIssue(repository.id, { issue_number: 1 })).rejects.toMatchObject({ code: "not_an_issue" });
    delete github.source.pull_request;
    await expect(service.importIssue(repository.id, { issue_number: 1, source_updated_at: "old" })).rejects.toMatchObject({ code: "source_changed" });
  }, 20_000);
  it("同步按 Retry-After 退避，手动请求不能绕过；轮询不改变仓库 version", async () => {
    const repository = await bind(); github.failReads = new GitHubError("限流", 429, "github_rate_limited", true, 180_000);
    const result = await service.refreshRepository(repository.id);
    expect(result.connection_status).toBe("unavailable"); expect(Date.parse(result.next_sync_at!)).toBe(clock + 180_000);
    const count = github.requests.length; clock += 11_000;
    await expect(service.refreshRepository(repository.id)).rejects.toMatchObject({ code: "sync_backoff" });
    expect(github.requests).toHaveLength(count);
    github.failReads = null; clock += 180_000;
    const recovered = await service.refreshRepository(repository.id); expect(recovered.connection_status).toBe("connected"); expect(recovered.version).toBe(repository.version);
  }, 20_000);
  it("实时事实刷新失败持久连接阻断，避免 Gate 消费旧缓存", async () => {
    const repository = await bind(); github.failReads = new GitHubError("连接不可用", 503, "github_unavailable", true);
    await expect(service.refreshGitFacts(repository.id)).rejects.toMatchObject({ code: "github_unavailable" });
    expect(service.getRepository(repository.id)).toMatchObject({ connection_status: "unavailable", error: "连接不可用" });
  }, 20_000);
  it("冻结路由导入/来源/接受/同步契约可独立注册", async () => {
    const repository = await bind(), app = Fastify(); registerRepositoryRoutes(app, db, hub, service);
    try {
      const imported = await app.inject({ method: "POST", url: `/api/repositories/${repository.id}/import-issue`, payload: { issue_number: 1 } });
      expect(imported.statusCode).toBe(200); const id = imported.json().issue_id;
      const source = await app.inject({ method: "GET", url: `/api/issues/${id}/source` }); expect(source.json().accepted.title).toBe("来源标题");
      const accepted = await app.inject({ method: "POST", url: `/api/issues/${id}/accept-source`, payload: { snapshot_id: source.json().latest.id } }); expect(accepted.statusCode).toBe(200);
      const synced = await app.inject({ method: "POST", url: `/api/repositories/${repository.id}/sync` }); expect(synced.statusCode).toBe(200);
      const duplicate = await app.inject({ method: "POST", url: `/api/repositories/${repository.id}/sync` }); expect(duplicate.statusCode).toBe(429); expect(duplicate.headers["retry-after"]).toBeDefined();
    } finally { await app.close(); }
  }, 20_000);
});

describe("固定版本 PR 操作与恢复", () => {
  it("远端查询期间绑定版本发生变化，实际推送前第二次 Gate 阻止副作用", async () => {
    const repository = await bind(), task = await makeTask(repository);
    let gates = 0;
    const result = await service.createPullRequest(task.taskId, task.request, "race-gate", async () => {
      gates++;
      const gate = await task.gate();
      if (gates > 1) return { ...gate, evidence_version: "binding-changed" };
      return gate;
    });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("证据或 HEAD 已变化");
    expect(writes.filter(args => args.includes("push"))).toHaveLength(0);
    expect(github.requests.filter(item => item.method === "POST")).toHaveLength(0);
  }, 20_000);
  it("fetch 后在锁内检查 Gate，只推固定 SHA，质量阻塞可开 PR 而不自动批准或 done", async () => {
    const repository = await bind(), task = await makeTask(repository);
    const gate = async () => { expect(writes.some(args => args.includes("fetch"))).toBe(true); return { ...await task.gate(), blockers: [{ code: "checks_failed", message: "Runner 验证失败", kind: "quality" as const }], can_approve: false }; };
    const result = await service.createPullRequest(task.taskId, task.request, "create", gate);
    expect(result.state, result.error ?? "").toBe("succeeded");
    const push = writes.find(args => args.includes("push"))!; expect(push.at(-1)).toBe(`${task.head}:refs/heads/task/t01`); expect(push).not.toContain("--force");
    expect((db.prepare("SELECT status FROM issues WHERE id=?").get(task.issueId) as any).status).toBe("in_review");
    expect((db.prepare("SELECT count(*) AS n FROM review_decisions").get() as any).n).toBe(0);
    expect(service.getTaskPullRequest(task.taskId)?.head_sha).toBe(task.head);
    const replay = await service.createPullRequest(task.taskId, task.request, "create", task.gate); expect(replay.id).toBe(result.id);
    expect(github.requests.filter(item => item.method === "POST")).toHaveLength(1);
  }, 20_000);
  it("完整性阻塞、HEAD 变动或实时权限丢失不推送", async () => {
    const repository = await bind(), task = await makeTask(repository);
    await expect(service.createPullRequest(task.taskId, task.request, "integrity", async () => ({ ...await task.gate(), blockers: [{ code: "dirty", message: "工作树不干净", kind: "integrity" }] }))).rejects.toMatchObject({ code: "dirty" });
    await expect(service.createPullRequest(task.taskId, { ...task.request, expected_head: "a".repeat(40) }, "head", task.gate)).rejects.toMatchObject({ code: "evidence_changed" });
    github.push = false;
    await expect(service.createPullRequest(task.taskId, task.request, "permission", task.gate)).rejects.toMatchObject({ code: "github_permission_denied" });
    expect(writes.filter(args => args.includes("push"))).toHaveLength(0); expect(github.requests.filter(item => item.method === "POST")).toHaveLength(0);
  }, 20_000);
  it("Git pushInsteadOf 重写到非绑定地址被拒绝，不能跨仓推送", async () => {
    const repository = await bind(), task = await makeTask(repository);
    gitR(checkout, ["config", `url.${remote.replace(/\\/g, "/")}.pushInsteadOf`, "https://github.com/owner/repo.git"]);
    const result = await service.createPullRequest(task.taskId, task.request, "rewrite", task.gate);
    expect(result.state).toBe("failed"); expect(writes.filter(args => args.includes("push"))).toHaveLength(0);
  }, 20_000);
  it("push 响应丢失持久 unknown，换 key 无法绕过，显式恢复不再推送", async () => {
    const repository = await bind(), task = await makeTask(repository); afterPushFailure = true;
    const unknown = await service.createPullRequest(task.taskId, task.request, "push-lost", task.gate);
    expect(unknown.state).toBe("unknown"); expect(unknown.error).not.toContain("secret"); expect(github.pulls).toHaveLength(0);
    await expect(service.createPullRequest(task.taskId, task.request, "another-key", task.gate)).rejects.toMatchObject({ code: "recovery_required" });
    const recovered = await service.recoverPullRequest(task.taskId, unknown.id, task.request, "recover", task.gate);
    expect(recovered.state).toBe("succeeded"); expect(recovered.id).not.toBe(unknown.id); expect(writes.filter(args => args.includes("push"))).toHaveLength(1);
    expect((db.prepare("SELECT state,error FROM delivery_operations WHERE id=?").get(unknown.id) as any)).toMatchObject({ state: "failed", error: expect.stringContaining(recovered.id) });
  }, 20_000);
  it("创建 PR 响应丢失通过远端 marker 关联，恢复不重复 POST，也不新建 Decision", async () => {
    const repository = await bind(), task = await makeTask(repository); approve(task, repository); github.failAfterCreate = true;
    const unknown = await service.createPullRequest(task.taskId, task.request, "create-lost", task.gate);
    expect(unknown.state).toBe("unknown"); expect(github.pulls).toHaveLength(1);
    const recovered = await service.recoverPullRequest(task.taskId, unknown.id, task.request, "recover", task.gate);
    expect(recovered.state).toBe("succeeded"); expect(github.requests.filter(item => item.method === "POST")).toHaveLength(1);
    expect((db.prepare("SELECT count(*) AS n FROM review_decisions").get() as any).n).toBe(1);
  }, 20_000);
  it("恢复查询未明确时保留 unknown，不创建新操作；多 PR 候选拒绝关联", async () => {
    const repository = await bind(), task = await makeTask(repository); github.failAfterCreate = true;
    const unknown = await service.createPullRequest(task.taskId, task.request, "lost", task.gate);
    github.pulls.push({ ...github.pulls[0], id: 502, number: 11 });
    await expect(service.recoverPullRequest(task.taskId, unknown.id, task.request, "recover", task.gate)).rejects.toMatchObject({ code: "pull_request_ambiguous" });
    expect((db.prepare("SELECT state FROM delivery_operations WHERE id=?").get(unknown.id) as any).state).toBe("unknown");
    expect((db.prepare("SELECT count(*) AS n FROM delivery_operations").get() as any).n).toBe(1);
  }, 20_000);
  it("PR 已合并且分支删除时恢复只关联，不重新创建分支", async () => {
    const repository = await bind(), task = await makeTask(repository); github.failAfterCreate = true;
    const unknown = await service.createPullRequest(task.taskId, task.request, "lost", task.gate);
    squashMerge(); gitR(remote, ["update-ref", "-d", "refs/heads/task/t01"]);
    const recovered = await service.recoverPullRequest(task.taskId, unknown.id, task.request, "recover", task.gate);
    expect(recovered.state).toBe("succeeded"); expect(github.remoteHead("task/t01")).toBeNull(); expect(github.pulls).toHaveLength(1);
  }, 20_000);
  it("同 Issue 返工复用开放 PR，各 Task 保存独立关联和裁决", async () => {
    const repository = await bind(), first = await makeTask(repository); approve(first, repository);
    await service.createPullRequest(first.taskId, first.request, "first", first.gate);
    gitR(checkout, ["checkout", "-b", "task/rework", "task/t01"]); fs.appendFileSync(path.join(checkout, "file.txt"), "rework\n"); gitR(checkout, ["commit", "-am", "返工"]); gitR(checkout, ["checkout", "main"]);
    const second = await makeTask(repository, first.issueId, "task/rework");
    const result = await service.createPullRequest(second.taskId, second.request, "second", second.gate);
    expect(result.state).toBe("succeeded"); expect(github.pulls).toHaveLength(1);
    expect(service.getTaskPullRequest(first.taskId)?.head_sha).toBe(first.head); expect(service.getTaskPullRequest(second.taskId)?.head_sha).toBe(second.head);
    expect((db.prepare("SELECT head_commit FROM review_decisions WHERE task_id=?").get(first.taskId) as any).head_commit).toBe(first.head);
  }, 20_000);
  it("返工推送响应丢失后原 PR 被轮询为已合并，仍沿用原意图分支恢复", async () => {
    const repository = await bind(), first = await makeTask(repository);
    expect((await service.createPullRequest(first.taskId, first.request, "first", first.gate)).state).toBe("succeeded");
    gitR(checkout, ["checkout", "-b", "task/rework", "task/t01"]);
    fs.appendFileSync(path.join(checkout, "file.txt"), "返工\n"); gitR(checkout, ["commit", "-am", "返工"]); gitR(checkout, ["checkout", "main"]);
    const second = await makeTask(repository, first.issueId, "task/rework"); approve(second, repository);
    afterPushFailure = true;
    const unknown = await service.createPullRequest(second.taskId, second.request, "second", second.gate);
    expect(unknown.state).toBe("unknown");
    gitR(checkout, ["merge", "--squash", second.head]); gitR(checkout, ["commit", "-m", "合入返工"]); gitR(checkout, ["push", remote, "main"]);
    Object.assign(github.pulls[0], { merged: true, state: "closed", merge_commit_sha: gitR(checkout, ["rev-parse", "HEAD"]), head: { ...github.pulls[0].head, sha: second.head } });
    await service.refreshRepository(repository.id);
    expect(service.getTaskPullRequest(first.taskId)?.state).toBe("merged");
    const recovered = await service.recoverPullRequest(second.taskId, unknown.id, second.request, "recover-second", second.gate);
    expect(recovered.state, recovered.error ?? "").toBe("succeeded");
    expect(service.getTaskPullRequest(second.taskId)?.head_ref).toBe("task/t01");
    expect(github.pulls).toHaveLength(1);
    expect(writes.filter(args => args.includes("push"))).toHaveLength(2);
  }, 20_000);
});

describe("权威 PR 合并事实", () => {
  it("压缩合并 SHA 不同但目标可达且获人工批准后 done，重复同步不重复评论", async () => {
    const repository = await bind(), task = await makeTask(repository); approve(task, repository);
    await service.createPullRequest(task.taskId, task.request, "create", task.gate);
    const merge = squashMerge(); expect(merge).not.toBe(task.head);
    await service.refreshRepository(repository.id);
    expect((db.prepare("SELECT status FROM issues WHERE id=?").get(task.issueId) as any).status).toBe("done");
    expect(service.getTaskPullRequest(task.taskId)?.checks[0].name).toBe("GitHub CI");
    const count = (db.prepare("SELECT count(*) AS n FROM comments WHERE issue_id=?").get(task.issueId) as any).n;
    clock += 11_000; await service.refreshRepository(repository.id);
    expect((db.prepare("SELECT count(*) AS n FROM comments WHERE issue_id=?").get(task.issueId) as any).n).toBe(count);
  }, 20_000);
  it.each(["未批准", "旧批准", "未合并关闭", "合并提交不可达", "更新的Task"])("%s不能自动 done", async condition => {
    const repository = await bind(), task = await makeTask(repository);
    if (condition !== "未批准") approve(task, repository, condition === "旧批准" ? "a".repeat(40) : task.head);
    await service.createPullRequest(task.taskId, task.request, "create", task.gate);
    squashMerge();
    if (condition === "未合并关闭") Object.assign(github.pulls[0], { merged: false, merged_at: null, state: "closed" });
    if (condition === "合并提交不可达") github.pulls[0].merge_commit_sha = "b".repeat(40);
    if (condition === "更新的Task") await makeTask(repository, task.issueId);
    github.source.state = "closed";
    await service.refreshRepository(repository.id);
    expect((db.prepare("SELECT status FROM issues WHERE id=?").get(task.issueId) as any).status).toBe("in_review");
  }, 20_000);
});
