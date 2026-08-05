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
});

describe("prepareWorkdir with repo URL", () => {
  it("从缓存建 worktree：分支 task/<short> 基于缓存默认分支", { timeout: 30000 }, async () => {
    const { url } = makeRemote();
    const runnerRoot = tmp("anvil-runner-");
    const issue = { repo_path: url } as Issue;
    const prepared = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    expect(prepared.branch).toBe("task/12345678");
    expect(prepared.resumed).toBe(false);
    expect(fs.existsSync(path.join(prepared.workDir, "a.txt"))).toBe(true);
    // 分支落在缓存仓库里，且指向缓存 main 的提交
    const cache = repoCachePath(url, runnerRoot);
    expect(await git(cache, ["branch", "--list", "task/12345678"])).toContain("task/12345678");
    expect(await git(prepared.workDir, ["rev-parse", "HEAD"])).toBe(await git(cache, ["rev-parse", "main"]));
  });
});

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
    await executeTask({ client: daemonClient, backend: success, runnerRoot, cancelPollMs: 50 }, pkg);

    const got = await app.inject({ method: "GET", url: `/api/tasks/${pkg.task.id}` });
    expect(got.json().task.status).toBe("completed");
    const result = JSON.parse(got.json().task.result_json);
    expect(result.pushed).toBe(true);
    // 远程 bare 仓库可见任务分支
    const remoteBranches = gitR(bareDir, ["branch", "--list", "task/*"]);
    expect(remoteBranches).toContain(`task/${pkg.task.id.slice(0, 8)}`);
  });
});
