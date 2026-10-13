import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { repoCachePath } from "@anvil/core";

let app: FastifyInstance;
let workspaceId: string;
let agentId: string;
const tmpDirs: string[] = [];

function gitR(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
}

/** 真实临时 git 仓库：main 分支 + 一个初始提交。 */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-review-"));
  tmpDirs.push(dir);
  gitR(dir, ["init", "-b", "main"]);
  gitR(dir, ["config", "user.email", "test@anvil.local"]);
  gitR(dir, ["config", "user.name", "Anvil Test"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "line1\n");
  gitR(dir, ["add", "."]);
  gitR(dir, ["commit", "-m", "init"]);
  return dir;
}

/** 在 repo 上建 task/test123 分支并改同一文件后回到 main。 */
function makeTaskBranch(repo: string): void {
  gitR(repo, ["checkout", "-b", "task/test123"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "line1\nline2\n");
  gitR(repo, ["add", "."]);
  gitR(repo, ["commit", "-m", "task work"]);
  gitR(repo, ["checkout", "main"]);
}

async function createIssue(payload: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "demo", ...payload } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** 手工把 issue 的 queued 任务改成 completed 并写入 result_json（模拟 runner 完成上报）。 */
async function completeTaskWithResult(issueId: string, result: Record<string, unknown>): Promise<string> {
  const tasks = await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` });
  const taskId = tasks.json()[0].id;
  app.db.prepare(`UPDATE tasks SET status='completed', delivery_contract_version=1, result_json=?, completed_at=? WHERE id=?`)
    .run(JSON.stringify(result), new Date().toISOString(), taskId);
  return taskId;
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const boot = await app.inject({ method: "GET", url: "/api/bootstrap" });
  workspaceId = boot.json().workspace.id;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
});

afterEach(async () => {
  await app.close();
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows 临时目录清理失败可忽略 */ }
  }
});

describe("board latest_task", () => {
  it("GET /api/issues 附 latest_task 摘要；无任务 issue 为 null", async () => {
    const withTask = await createIssue({ title: "with task", assignee_type: "agent", assignee_id: agentId });
    await createIssue({ title: "no task" });
    const list = await app.inject({ method: "GET", url: `/api/issues?workspace_id=${workspaceId}` });
    const items = list.json();
    expect(items).toHaveLength(2);
    const a = items.find((i: any) => i.id === withTask.id);
    expect(a.latest_task).toBeTruthy();
    expect(a.latest_task.status).toBe("queued");
    expect(a.latest_task.attempt).toBe(1);
    expect(a.latest_task.max_attempts).toBe(3);
    const b = items.find((i: any) => i.title === "no task");
    expect(b.latest_task).toBeNull();
  });
});

describe("claim comments", () => {
  it("claim 任务包带最近评论（时间正序）", async () => {
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId });
    // 入队时会写一条 system 评论，清掉以便只验证用户评论
    app.db.prepare(`DELETE FROM comments WHERE issue_id=?`).run(issue.id);
    await app.inject({ method: "POST", url: `/api/issues/${issue.id}/comments`, payload: { body: "第一条" } });
    await app.inject({ method: "POST", url: `/api/issues/${issue.id}/comments`, payload: { body: "第二条" } });

    const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: { label: "t" } });
    const token = tk.json().token;
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: "POST", url: "/api/daemon/register", headers: auth,
      payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1.0.0" }] },
    });
    const r = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth, payload: { daemon_id: "d1" } });
    expect(r.statusCode).toBe(200);
    const pkg = r.json().tasks[0];
    expect(pkg.comments).toHaveLength(2);
    expect(pkg.comments[0].body).toBe("第一条");
    expect(pkg.comments[1].body).toBe("第二条");
    expect(pkg.comments[0].created_at <= pkg.comments[1].created_at).toBe(true);
  });
});

describe("GET /api/tasks/:id/diff", () => {
  it("返回任务分支相对 merge-base 的 diff", async () => {
    const repo = makeRepo();
    makeTaskBranch(repo);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });

    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/diff` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branch).toBe("task/test123");
    expect(body.base).toBe("main");
    expect(body.diff_stat).toContain("file.txt");
    expect(body.diff_text).toContain("+line2");
    expect(body.truncated).toBe(false);
  });

  it("completed 但 result_json 无 branch → 404", async () => {
    const repo = makeRepo();
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { diff_stat: "x" });
    const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/diff` });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/merge", () => {
  it("历史独立 checkout 的旧 GitHub 地址即使重定向到新名称也不能经旧入口直推", async () => {
    const repo = makeRepo(); makeTaskBranch(repo);
    gitR(repo, ["remote", "add", "origin", "git@github.com:old-owner/old-name.git"]);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
    const before = gitR(repo, ["rev-parse", "HEAD"]);
    const response = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("github_pr_required");
    expect(gitR(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(app.db.prepare("SELECT count(*) AS n FROM integration_attempts").get()).toEqual({ n: 0 });
  });
  it("成功：合入 main、issue 置 done、保留分支并幂等返回", async () => {
    const repo = makeRepo();
    makeTaskBranch(repo);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, merged_branch: "task/test123", target: "main" });
    expect(fs.readFileSync(path.join(repo, "file.txt"), "utf8")).toContain("line2");
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    expect(detail.json().issue.status).toBe("done");
    expect(gitR(repo, ["branch", "--list", "task/test123"])).toContain("task/test123");
    const head = gitR(repo, ["rev-parse", "HEAD"]);
    const comments = app.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE issue_id=?").get(issue.id);
    const replay = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(res.json());
    expect(gitR(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE issue_id=?").get(issue.id)).toEqual(comments);
  }, 15_000);

  it("冲突：409 且 issue 状态不变", async () => {
    const repo = makeRepo();
    makeTaskBranch(repo);
    // main 改同一行制造冲突
    fs.writeFileSync(path.join(repo, "file.txt"), "line1-main\n");
    gitR(repo, ["add", "."]);
    gitR(repo, ["commit", "-m", "conflicting main work"]);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });

    const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBeTruthy();
    expect(res.json().error).toContain("CONFLICT"); // git 冲突详情在 stdout，必须透出给用户
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    expect(detail.json().issue.status).not.toBe("done");
    // S1 保留冲突现场，不在无法确认所有权时自动 abort。
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(true);
    expect(res.json().code).toBe("recovery_required");
  });

  it("回归：带 content-type: application/json 但 body 为空的 POST 不返回 400", async () => {
    const repo = makeRepo();
    makeTaskBranch(repo);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });

    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/merge`,
      headers: { "content-type": "application/json" }, // 模拟修复前 web 客户端的空 body 请求
    });
    expect(res.statusCode).toBe(200);
  });
});

/** 本机 bare 仓库当"远程"：main + 一个初始提交，返回 file:// URL。 */
function makeBareRemote(): { url: string; bareDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-remote-"));
  tmpDirs.push(base);
  const seedDir = path.join(base, "seed");
  const bareDir = path.join(base, "bare.git");
  fs.mkdirSync(seedDir);
  gitR(seedDir, ["init", "-b", "main"]);
  gitR(seedDir, ["config", "user.email", "test@anvil.local"]);
  gitR(seedDir, ["config", "user.name", "Anvil Test"]);
  fs.writeFileSync(path.join(seedDir, "file.txt"), "line1\n");
  gitR(seedDir, ["add", "."]);
  gitR(seedDir, ["commit", "-m", "init"]);
  gitR(base, ["init", "--bare", "-b", "main", bareDir]);
  gitR(seedDir, ["push", bareDir, "main"]);
  return { url: pathToFileURL(bareDir).href, bareDir };
}

/** 模拟 runner：clone URL 到缓存路径，建任务分支（file.txt 加 line2）并推到远程。返回缓存路径。 */
function makeUrlTaskBranch(url: string, runnerRoot: string, branch: string): string {
  const cache = repoCachePath(url, runnerRoot);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  gitR(path.dirname(cache), ["clone", url, cache]);
  gitR(cache, ["config", "user.email", "test@anvil.local"]);
  gitR(cache, ["config", "user.name", "Anvil Test"]);
  gitR(cache, ["checkout", "-b", branch]);
  fs.writeFileSync(path.join(cache, "file.txt"), "line1\nline2\n");
  gitR(cache, ["add", "."]);
  gitR(cache, ["commit", "-m", "task work"]);
  gitR(cache, ["checkout", "main"]);
  gitR(cache, ["push", "origin", branch]);
  return cache;
}

/** 在 ANVIL_RUNNER_ROOT 指向 runnerRoot 的环境下跑 fn（server 与 runner 同机共享缓存的单机版假设）。 */
async function withRunnerRoot<T>(runnerRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ANVIL_RUNNER_ROOT;
  process.env.ANVIL_RUNNER_ROOT = runnerRoot;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ANVIL_RUNNER_ROOT;
    else process.env.ANVIL_RUNNER_ROOT = prev;
  }
}

describe("URL 仓库（缓存路径解析）", () => {
  it("diff：URL repo_path 解析到本地缓存", async () => {
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-root-"));
    tmpDirs.push(runnerRoot);
    await withRunnerRoot(runnerRoot, async () => {
      const { url } = makeBareRemote();
      makeUrlTaskBranch(url, runnerRoot, "task/test123");
      const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: url });
      const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });

      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/diff` });
      expect(res.statusCode).toBe(200);
      expect(res.json().base).toBe("main");
      expect(res.json().diff_text).toContain("+line2");
    });
  }, 15000); // 真实 clone/push/Git 进程在 Windows 上不以默认 5s 作为性能门槛。

  it("diff：缓存不存在 → 404 repo cache not found", async () => {
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-root-"));
    tmpDirs.push(runnerRoot);
    await withRunnerRoot(runnerRoot, async () => {
      const issue = await createIssue({
        assignee_type: "agent", assignee_id: agentId,
        repo_path: "https://github.com/user/never-cloned.git",
      });
      const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
      const res = await app.inject({ method: "GET", url: `/api/tasks/${taskId}/diff` });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("repo cache not found");
    });
  });

  it("merge：合入后推送固定提交到远程，保留任务分支", async () => {
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-root-"));
    tmpDirs.push(runnerRoot);
    await withRunnerRoot(runnerRoot, async () => {
      const { url, bareDir } = makeBareRemote();
      const cache = makeUrlTaskBranch(url, runnerRoot, "task/test123");
      const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: url });
      const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, merged_branch: "task/test123", target: "main" });
      // 远程 main 包含任务改动
      expect(gitR(bareDir, ["show", "main:file.txt"])).toContain("line2");
      // 保留远端和本地分支，清理不能删除后来出现的改动。
      expect(gitR(bareDir, ["branch", "--list", "task/test123"])).toContain("task/test123");
      expect(gitR(cache, ["branch", "--list", "task/test123"])).toContain("task/test123");
      const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
      expect(detail.json().issue.status).toBe("done");
    });
  }, 15000);

  it("merge：推送失败保留现场且不 done，重启后换请求键也不再次合入", async () => {
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-root-"));
    tmpDirs.push(runnerRoot);
    await withRunnerRoot(runnerRoot, async () => {
      const { url, bareDir } = makeBareRemote();
      const cache = makeUrlTaskBranch(url, runnerRoot, "task/test123");
      const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: url });
      const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
      // 删掉远程让 push 失败
      fs.rmSync(bareDir, { recursive: true, force: true });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("已合入本地");
      expect(res.json().error).toContain("推送");
      expect(res.json().code).toBe("recovery_required");
      const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
      expect(detail.json().issue.status).not.toBe("done");
      const mergedHead = gitR(cache, ["rev-parse", "HEAD"]);
      expect(gitR(cache, ["show", "HEAD:file.txt"])).toContain("line2");
      const saved = app.db.prepare("SELECT * FROM integration_attempts WHERE task_id=?").get(taskId) as any;
      expect(saved).toMatchObject({ status: "recovery_required", merge_commit: mergedHead });
      gitR(cache, ["checkout", "task/test123"]);
      fs.writeFileSync(path.join(cache, "later.txt"), "不应进入旧操作\n");
      gitR(cache, ["add", "."]); gitR(cache, ["commit", "-m", "后续修改"]); gitR(cache, ["checkout", "main"]);
      // 落盘并重新启动服务，证明保护不依赖进程内 Promise 或内存标记。
      const dbFile = path.join(runnerRoot, "restart.db");
      await app.db.$client.backup(dbFile);
      await app.close();
      app = await buildApp({ dbPath: dbFile, logger: false });
      const replay = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge`, headers: { "idempotency-key": "换一个键" } });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().code).toBe("recovery_required");
      expect(gitR(cache, ["rev-parse", "HEAD"])).toBe(mergedHead);
      expect(fs.existsSync(path.join(cache, "later.txt"))).toBe(false);
      expect(app.db.prepare("SELECT * FROM integration_attempts WHERE task_id=?").get(taskId)).toEqual(saved);
    });
  }, 15000);
});

describe("持久合入保护", () => {
  it("Git 错误在首次响应、重放和数据库中统一脱敏", async () => {
    const repo = makeRepo(); makeTaskBranch(repo);
    const hooks = path.join(repo, ".git", "review-test-hooks"); fs.mkdirSync(hooks);
    const fakeCredential = "dGVzdDpmYWtlLXJldmlldy1vbmx5";
    fs.writeFileSync(path.join(hooks, "pre-merge-commit"), `#!/bin/sh\nprintf '%s\\n' 'Authorization: Basic ${fakeCredential}' >&2\nexit 1\n`, { mode: 0o755 });
    gitR(repo, ["config", "core.hooksPath", hooks]);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
    const first = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    const replay = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    for (const response of [first, replay]) {
      expect(response.statusCode).toBe(409); expect(response.json().code).toBe("recovery_required");
      expect(response.body).not.toContain(fakeCredential); expect(response.json().error).toContain("[REDACTED]");
    }
    const attempt = app.db.prepare("SELECT error FROM integration_attempts WHERE task_id=?").get(taskId);
    expect(JSON.stringify(attempt)).not.toContain(fakeCredential);
  }, 15000);

  it("porcelain 为空但已有未结束合并时拒绝操作，不 abort 用户现场", async () => {
    const repo = makeRepo(); makeTaskBranch(repo);
    gitR(repo, ["checkout", "-b", "user-merge"]);
    gitR(repo, ["commit", "--allow-empty", "-m", "无文件差异的用户提交"]);
    gitR(repo, ["checkout", "main"]);
    gitR(repo, ["merge", "--no-commit", "--no-ff", "user-merge"]);
    expect(gitR(repo, ["status", "--porcelain"])).toBe("");
    const marker = fs.readFileSync(path.join(repo, ".git", "MERGE_HEAD"), "utf8");
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
    const response = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    expect(response.statusCode).toBe(409); expect(response.json().code).toBe("git_state_changed");
    expect(fs.readFileSync(path.join(repo, ".git", "MERGE_HEAD"), "utf8")).toBe(marker);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM integration_attempts").get()).toEqual({ n: 0 });
  }, 15000);

  it("并发点击只执行一次合入与完成副作用", async () => {
    const repo = makeRepo(); makeTaskBranch(repo);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` })));
    expect(responses.some((response) => response.statusCode === 200)).toBe(true);
    expect(responses.every((response) => response.statusCode === 200 || response.json().code === "recovery_required")).toBe(true);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM integration_attempts WHERE task_id=?").get(taskId)).toEqual({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE issue_id=? AND body LIKE '%本地交付%'").get(issue.id)).toEqual({ n: 1 });
    expect(gitR(repo, ["rev-list", "--count", "--merges", "main"])).toBe("1");
  }, 15000);

  it("Git 成功后数据库记账失败，仍保留持久守卫且不完成任务", async () => {
    const repo = makeRepo(); makeTaskBranch(repo);
    const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: repo });
    const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
    app.db.$client.exec(`CREATE TRIGGER fail_local_merge BEFORE UPDATE OF status ON integration_attempts
      WHEN NEW.status='local_merged' BEGIN SELECT RAISE(ABORT,'模拟记录中断'); END`);
    const first = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    expect(first.statusCode).toBe(409); expect(first.json().code).toBe("recovery_required");
    expect(first.json().error).toContain("已合入本地");
    const head = gitR(repo, ["rev-parse", "HEAD"]);
    expect(gitR(repo, ["show", "HEAD:file.txt"])).toContain("line2");
    app.db.$client.exec("DROP TRIGGER fail_local_merge");
    const retry = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
    expect(retry.json().code).toBe("recovery_required");
    expect(gitR(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect((await app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).json().issue.status).not.toBe("done");
  }, 15000);
});
