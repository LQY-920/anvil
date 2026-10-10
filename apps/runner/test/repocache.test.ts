import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import type { Issue } from "@anvil/core";
import { repoCachePath } from "@anvil/core";
import { ensureRepoCache } from "../src/repocache.js";
import { git, prepareWorkdir } from "../src/worktree.js";
import { executeTask } from "../src/executor.js";
import { ApiClient } from "../src/client.js";
import type { AgentBackend } from "../src/agents/backend.js";

const tmpDirs: string[] = [];
let app: FastifyInstance | null = null;

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function gitR(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

/** 本机 bare 仓库当"远程"：seed 仓库在 main 提交一笔后推入 bare，返回 file:// URL。 */
function makeRemote(): { url: string; bareDir: string; seedDir: string } {
  const base = tmp("anvil-remote-");
  const seedDir = path.join(base, "seed");
  const bareDir = path.join(base, "bare.git");
  fs.mkdirSync(seedDir);
  gitR(seedDir, ["init", "-b", "main"]);
  gitR(seedDir, ["config", "user.email", "t@t"]);
  gitR(seedDir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(seedDir, "a.txt"), "hi\n");
  gitR(seedDir, ["add", "-A"]);
  gitR(seedDir, ["commit", "-m", "init"]);
  gitR(base, ["init", "--bare", "-b", "main", bareDir]);
  gitR(seedDir, ["push", bareDir, "main"]);
  return { url: pathToFileURL(bareDir).href, bareDir, seedDir };
}

afterEach(async () => {
  await app?.close();
  app = null;
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows 清理失败可忽略 */ }
  }
});

describe("ensureRepoCache", () => {
  it("首次 clone 到 <runnerRoot>/repos/<hash>", { timeout: 30000 }, async () => {
    const { url } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const cache = await ensureRepoCache(url, runnerRoot);
    expect(cache).toBe(repoCachePath(url, runnerRoot));
    expect(fs.existsSync(path.join(cache, ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(cache, "a.txt"), "utf8")).toContain("hi");
    expect(await git(cache, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("二次调用走 fetch --all --prune（拿到新提交，不重复 clone）", { timeout: 30000 }, async () => {
    const { url, bareDir, seedDir } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const cache = await ensureRepoCache(url, runnerRoot);
    // 远程推进一笔
    fs.writeFileSync(path.join(seedDir, "b.txt"), "new\n");
    gitR(seedDir, ["add", "-A"]);
    gitR(seedDir, ["commit", "-m", "second"]);
    gitR(seedDir, ["push", bareDir, "main"]);
    const seedHead = gitR(seedDir, ["rev-parse", "HEAD"]);
    const cache2 = await ensureRepoCache(url, runnerRoot);
    expect(cache2).toBe(cache);
    expect(await git(cache, ["rev-parse", "origin/main"])).toBe(seedHead);
  });

  it("fetch 后快进本地分支到上游：缓存本地 main 包含远程新提交", { timeout: 30000 }, async () => {
    const { url, bareDir, seedDir } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const cache = await ensureRepoCache(url, runnerRoot);
    // 远程推进一笔
    fs.writeFileSync(path.join(seedDir, "b.txt"), "new\n");
    gitR(seedDir, ["add", "-A"]);
    gitR(seedDir, ["commit", "-m", "second"]);
    gitR(seedDir, ["push", bareDir, "main"]);
    const seedHead = gitR(seedDir, ["rev-parse", "HEAD"]);
    await ensureRepoCache(url, runnerRoot);
    // 本地分支（不只是 origin/main）已快进到最新远程
    expect(await git(cache, ["rev-parse", "HEAD"])).toBe(seedHead);
    expect(await git(cache, ["log", "--oneline"])).toContain("second");
  });

  it("同 URL 并发调用复用同一 Promise（per-URL 互斥）", { timeout: 30000 }, async () => {
    const { url } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const p1 = ensureRepoCache(url, runnerRoot);
    const p2 = ensureRepoCache(url, runnerRoot);
    expect(p1).toBe(p2);
    const cache = await p1;
    expect(await p2).toBe(cache);
    expect(fs.existsSync(path.join(cache, ".git"))).toBe(true);
  });

  it("缓存损坏（假 .git）→ 删除残骸重新 clone 自愈", { timeout: 30000 }, async () => {
    const { url } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const cache = await ensureRepoCache(url, runnerRoot);
    // 破坏缓存：真 .git 换成普通文件（rev-parse 跑不通的残骸）
    fs.rmSync(path.join(cache, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(cache, ".git"), "not a git dir");
    const cache2 = await ensureRepoCache(url, runnerRoot);
    expect(cache2).toBe(cache);
    expect(fs.readFileSync(path.join(cache, "a.txt"), "utf8")).toContain("hi");
    expect(await git(cache, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });
});

describe("prepareWorkdir with repo URL", () => {
  it("A04: URL 缓存首次准备返回默认 targetBranch + 完整 40 位 baseCommit,worktree 从该 baseCommit 创建", { timeout: 30000 }, async () => {
    const { url } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const issue = { repo_path: url } as Issue;
    const prepared = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    expect(prepared.taskBranch).toBe("task/12345678");
    expect(prepared.resumed).toBe(false);
    // 目标分支为远程默认分支
    expect(prepared.targetBranch).toBe("main");
    // baseCommit 严格 40 位 hex
    expect(prepared.baseCommit).toMatch(/^[0-9a-f]{40}$/i);
    // worktree HEAD 与返回的 baseCommit 一致(已固化,不是浮动的 origin/main)
    expect(await git(prepared.workDir, ["rev-parse", "HEAD"])).toBe(prepared.baseCommit);
    // worktree 内能正常读出缓存仓库的初始文件
    expect(fs.existsSync(path.join(prepared.workDir, "a.txt"))).toBe(true);
    // 分支落在缓存仓库里
    const cache = repoCachePath(url, runnerRoot);
    expect(await git(cache, ["branch", "--list", "task/12345678"])).toContain("task/12345678");
  });

  it("A04: URL 任务 resume 时目标 origin/main 后续推进,仍保留 Task 已保存的 baseCommit", { timeout: 30000 }, async () => {
    // 关键:A04 承诺"已返回的 baseCommit 不被后续 origin/target HEAD 覆盖"是指 resume 场景。
    // 首次 prepareWorkdir 主动读当时 main HEAD;后续若同一 Task 走 resume,
    // 必须用 Task 已存 baseCommit,即使缓存已 ff 到新 main 也不覆盖。
    const { url, bareDir, seedDir } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const issue = { repo_path: url } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    const savedBase = first.baseCommit!;
    expect(savedBase).toMatch(/^[0-9a-f]{40}$/i);

    // 远程推进 + 缓存快进(确保 origin/main 与本地 main 都已前进)
    fs.writeFileSync(path.join(seedDir, "b.txt"), "advanced\n");
    gitR(seedDir, ["add", "-A"]);
    gitR(seedDir, ["commit", "-m", "advance"]);
    gitR(seedDir, ["push", bareDir, "main"]);
    // 显式 fetch 让本地 origin/main 同步到新提交
    gitR(repoCachePath(url, runnerRoot), ["fetch", "--all", "--prune"]);
    gitR(repoCachePath(url, runnerRoot), ["merge", "--ff-only", "@{u}"]);
    const advancedHead = gitR(repoCachePath(url, runnerRoot), ["rev-parse", "HEAD"]);
    expect(advancedHead).not.toBe(savedBase);

    // 模拟 resume:priorWorkDir 存在 + savedAnchors = Task 已存值
    const second = await prepareWorkdir(
      issue, "87654321-ffff-task", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: savedBase },
    );
    expect(second.baseCommit).toBe(savedBase);
    expect(second.baseCommit).not.toBe(advancedHead);
    expect(second.resumed).toBe(true);
  });
});

function cacheFor(url: string, runnerRoot: string): string {
  return repoCachePath(url, runnerRoot);
}

describe("executeTask with repo URL", () => {
  it("完成后把任务分支推送到远程（pushed: true）", { timeout: 60000 }, async () => {
    const { url, bareDir } = makeRemote();
    app = await buildApp({ dbPath: ":memory:", logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as any).port;
    const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
    const daemonClient = new ApiClient(`http://127.0.0.1:${port}`, tk.json().token);
    const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
    await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "remote repo task", assignee_type: "agent", assignee_id: a.json().id, repo_path: url },
    });
    await daemonClient.register("d1", [{ provider: "kimi", version: "test" }]);
    const { tasks } = await daemonClient.claim("d1");
    const pkg = tasks[0];
    const runnerRoot = tmp("anvil-runner-");

    const success: AgentBackend = {
      provider: "kimi",
      execute() {
        return {
          messages: (async function* () {})(),
          result: Promise.resolve({ status: "completed" as const, exitCode: 0 }),
          kill: () => {},
        };
      },
    };
    await executeTask({ client: daemonClient, backend: success, runnerRoot, cancelPollMs: 50, daemonId: 'd1' }, pkg);

    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    const result = JSON.parse(got.json().task.result_json);
    expect(result.pushed).toBe(true);
    // 远程 bare 仓库可见任务分支
    const remoteBranches = gitR(bareDir, ["branch", "--list", "task/*"]);
    expect(remoteBranches).toContain(`task/${pkg.task.id.slice(0, 8)}`);
  });
});

// =============================================================================
// A04-FIX2 · URL 仓库身份校验(防止 PATCH Issue 改 repo_path 后在错误 URL 缓存中执行)
// =============================================================================

describe("A04-FIX2 · URL 仓库身份校验", () => {
  it("A04-FIX2: URL A 缓存 worktree + Issue 仍为 URL A → Resume 成功,不重新 fetch,baseCommit 不被远程推进覆盖", { timeout: 30000 }, async () => {
    const { url, bareDir, seedDir } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const issue = { repo_path: url } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd", runnerRoot, null);
    const savedBase = first.baseCommit!;
    expect(savedBase).toMatch(/^[0-9a-f]{40}$/i);

    // 远程推进 + 缓存 ff(模拟上游新提交)
    fs.writeFileSync(path.join(seedDir, "c.txt"), "newer\n");
    gitR(seedDir, ["add", "-A"]);
    gitR(seedDir, ["commit", "-m", "advance-2"]);
    gitR(seedDir, ["push", bareDir, "main"]);
    gitR(repoCachePath(url, runnerRoot), ["fetch", "--all", "--prune"]);
    gitR(repoCachePath(url, runnerRoot), ["merge", "--ff-only", "@{u}"]);
    const advancedHead = gitR(repoCachePath(url, runnerRoot), ["rev-parse", "HEAD"]);
    expect(advancedHead).not.toBe(savedBase);

    // Resume:URL 没变,prior worktree 仍是 URL A 的 worktree
    const second = await prepareWorkdir(
      issue, "87654321-ffff", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: savedBase },
    );
    expect(second.baseCommit).toBe(savedBase);
    expect(second.baseCommit).not.toBe(advancedHead);
    expect(second.resumed).toBe(true);
  });

  it("A04-FIX2: URL A 缓存 worktree + Issue 改成 URL B → 明确失败,不进入 URL A 执行,不 clone/fetch URL B 作为 fresh fallback", { timeout: 30000 }, async () => {
    const urlA = makeRemote().url;
    const urlB = makeRemote().url;
    expect(urlA).not.toBe(urlB);
    const runnerRoot = tmp("anvil-runner-");
    const issueA = { repo_path: urlA } as Issue;
    const first = await prepareWorkdir(issueA, "12345678-abcd", runnerRoot, null);
    expect(first.taskBranch).toBe("task/12345678");

    // prior 来自 URL A,但 issue 改成 URL B
    const issueB = { repo_path: urlB } as Issue;
    await expect(prepareWorkdir(
      issueB, "87654321-ffff", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
    )).rejects.toThrow(/仓库|repo|repository|不一致|不匹配/i);

    // 关键:URL B 的缓存目录不应被创建(没有静默 fresh fallback)
    const cacheB = repoCachePath(urlB, runnerRoot);
    expect(fs.existsSync(cacheB)).toBe(false);
    // 也不应在 URL A 缓存里创建 task/87654321 分支
    const cacheA = repoCachePath(urlA, runnerRoot);
    const branchesA = gitR(cacheA, ["branch", "--list"]);
    expect(branchesA).not.toContain("task/87654321");
  });
});
