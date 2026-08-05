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
  app.db.prepare(`UPDATE tasks SET status='completed', result_json=?, completed_at=? WHERE id=?`)
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
  it("成功：合入 main、issue 置 done、分支被清理", async () => {
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
    expect(gitR(repo, ["branch", "--list", "task/test123"])).toBe("");
  });

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
    const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    expect(detail.json().issue.status).not.toBe("done");
    // merge 失败已 abort，仓库不留 MERGING 状态
    expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
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
  });

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

  it("merge：合入后推送 main 到远程，并删除远程任务分支", async () => {
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
      // 远程任务分支被删除
      expect(gitR(bareDir, ["branch", "--list", "task/test123"])).toBe("");
      // 缓存本地分支也被清理
      expect(gitR(cache, ["branch", "--list", "task/test123"])).toBe("");
      const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
      expect(detail.json().issue.status).toBe("done");
    });
  });

  it("merge：推送失败 → 409 且 issue 仍置 done（本地已合入）", async () => {
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-root-"));
    tmpDirs.push(runnerRoot);
    await withRunnerRoot(runnerRoot, async () => {
      const { url, bareDir } = makeBareRemote();
      makeUrlTaskBranch(url, runnerRoot, "task/test123");
      const issue = await createIssue({ assignee_type: "agent", assignee_id: agentId, repo_path: url });
      const taskId = await completeTaskWithResult(issue.id, { branch: "task/test123" });
      // 删掉远程让 push 失败
      fs.rmSync(bareDir, { recursive: true, force: true });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain("已合入本地");
      expect(res.json().error).toContain("推送");
      const detail = await app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
      expect(detail.json().issue.status).toBe("done");
    });
  });
});
