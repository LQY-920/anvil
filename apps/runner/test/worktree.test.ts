import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureGitAvailable, git, prepareWorkdir, gitDiffStat, readWorktreeHead } from "../src/worktree.js";
import type { Issue } from "@anvil/core";

const SHA1_40 = /^[0-9a-f]{40}$/i;

function seedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.txt"), "hi");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anvil-runner-"));
}

describe("worktree", () => {
  it("ensureGitAvailable resolves git (PATH or known locations)", async () => {
    await ensureGitAvailable();
    const out = await git(process.cwd(), ["--version"]);
    expect(out).toContain("git version");
  });

  // ---------------------------------------------------------------------------
  // A04 · 本地仓库首次准备 —— 完整 5 字段 + 严格 40 位 SHA
  // ---------------------------------------------------------------------------
  it("A04: 本地仓库首次准备:返回 taskBranch / targetBranch / 完整 40 位 baseCommit,worktree HEAD 固化到 baseCommit", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const preHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    const preBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).toString().trim();

    const prepared = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);

    expect(prepared.taskBranch).toBe("task/12345678");
    expect(prepared.targetBranch).toBe(preBranch);
    expect(prepared.targetBranch).not.toBe("HEAD");
    expect(prepared.baseCommit).not.toBeNull();
    expect(prepared.baseCommit).toBe(preHead);
    expect(prepared.baseCommit).toMatch(SHA1_40);
    expect(prepared.resumed).toBe(false);
    // worktree HEAD 必须等于 baseCommit(已固化的 40 位 SHA)
    const wtHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: prepared.workDir }).toString().trim();
    expect(wtHead).toBe(prepared.baseCommit);
  });

  // ---------------------------------------------------------------------------
  // A04 · detached HEAD 必须明确失败,不得返回 targetBranch="HEAD"
  // ---------------------------------------------------------------------------
  it("A04: 本地仓库 detached HEAD 必须明确失败,无 taskBranch='HEAD'", async () => {
    const repo = seedRepo();
    // 进入 detached HEAD
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    execFileSync("git", ["checkout", "--detach", head], { cwd: repo });
    const abbrev = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).toString().trim();
    expect(abbrev).toBe("HEAD");

    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    await expect(
      prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null),
    ).rejects.toThrow(/detached/i);
    // 失败时不应留下可执行任务工作区:仓库不应出现 task/12345678 分支
    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo }).toString();
    expect(branches).not.toContain("task/12345678");
  });

  // ---------------------------------------------------------------------------
  // A04 · 无 repo_path 的普通目录任务:三个 Git 锚点全 null,resumed=false
  // ---------------------------------------------------------------------------
  it("A04: 无 repo_path 走普通目录,3 个 Git 锚点均为 null,resumed=false", async () => {
    const runnerRoot = tmpRoot();
    const prepared = await prepareWorkdir({ repo_path: null } as Issue, "abcdef99-0000", runnerRoot, null);
    expect(prepared.taskBranch).toBeNull();
    expect(prepared.targetBranch).toBeNull();
    expect(prepared.baseCommit).toBeNull();
    expect(prepared.resumed).toBe(false);
    expect(fs.existsSync(prepared.workDir)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // A04 · Resume:复用 workDir,使用 Task 已保存锚点;即使目标前进也不覆盖
  // ---------------------------------------------------------------------------
  it("A04: Resume 复用 workDir,使用 Task 已保存 targetBranch/baseCommit", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    expect(first.taskBranch).toBe("task/12345678");
    expect(first.baseCommit).toMatch(SHA1_40);

    const second = await prepareWorkdir(
      issue, "87654321-ffff-task", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
    );
    expect(second.resumed).toBe(true);
    expect(second.taskBranch).toBe(first.taskBranch);
    expect(second.targetBranch).toBe(first.targetBranch);
    expect(second.baseCommit).toBe(first.baseCommit);
  });

  it("A04: Resume 时目标 main 前进,仍保留已保存 baseCommit(不重新读取浮动 HEAD)", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    const savedBase = first.baseCommit!;
    expect(savedBase).toMatch(SHA1_40);

    // 目标分支前进:在 main 上新建 commit(模拟他人 push)
    execFileSync("git", ["checkout", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "b.txt"), "advanced");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "advance"], { cwd: repo });
    const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    expect(newHead).not.toBe(savedBase);

    const second = await prepareWorkdir(
      issue, "87654321-ffff-task", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: savedBase },
    );
    // 关键不变量:baseCommit 不能因为 main 前进而被覆盖
    expect(second.baseCommit).toBe(savedBase);
    expect(second.baseCommit).not.toBe(newHead);
  });

  it("A04: Resume 时 worktree 实际分支与已保存 task_branch 不一致 → 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);

    // 在该 workDir 上手动切换到一个不同的任务分支
    execFileSync("git", ["checkout", "-b", "task/ffff0000"], { cwd: first.workDir });

    await expect(
      prepareWorkdir(
        issue, "87654321-ffff-task", runnerRoot, first.workDir,
        { taskBranch: "task/12345678", targetBranch: first.targetBranch, baseCommit: first.baseCommit },
      ),
    ).rejects.toThrow(/task_branch|mismatch|branch/i);
  });

  it("A04: Resume 时 worktree detached HEAD → 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);

    // 把 worktree 切到 detached
    const wtHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: first.workDir }).toString().trim();
    execFileSync("git", ["checkout", "--detach", wtHead], { cwd: first.workDir });

    await expect(
      prepareWorkdir(
        issue, "87654321-ffff-task", runnerRoot, first.workDir,
        { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
      ),
    ).rejects.toThrow(/detached/i);
  });

  it("A04: Resume 时已保存 targetBranch/baseCommit 缺失 → 明确失败,不得猜测", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);

    // 显式不传 target/base(savedAnchors 缺位)
    await expect(
      prepareWorkdir(issue, "87654321-ffff-task", runnerRoot, first.workDir, null),
    ).rejects.toThrow(/anchor|target_branch|base_commit/i);
    // 只传 task_branch 但 base 缺失同样失败(任何缺失都不得猜测)
    await expect(
      prepareWorkdir(
        issue, "87654321-ffff-task", runnerRoot, first.workDir,
        { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: null },
      ),
    ).rejects.toThrow(/anchor|base_commit/i);
  });

  // ---------------------------------------------------------------------------
  // A04 · 非法 branch / 非法 SHA 显式失败(resume 路径:Task 已存 SHA 非法立即失败)
  // ---------------------------------------------------------------------------
  it("A04: resume 时已保存 baseCommit 非 40 位 SHA → 显式失败,不构造假锚点", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    // 模拟 Task 行里残留了非法 SHA(例如某次脏写入或外部调用)
    await expect(
      prepareWorkdir(
        issue, "87654321-ffff-task", runnerRoot, first.workDir,
        { taskBranch: first.taskBranch, targetBranch: "main", baseCommit: "not-a-sha" },
      ),
    ).rejects.toThrow(/sha|sha1|40/i);
  });

  // ---------------------------------------------------------------------------
  // A04 · 固定 diff 范围:base..head 必须包含 base 之后的 commit
  // ---------------------------------------------------------------------------
  it("A04: gitDiffStat 使用 base..head 范围,Agent commit 后能读到改动;git diff HEAD 已空", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const prepared = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);

    // 在 worktree 内 commit 一个新文件(模拟 Agent 完成)
    fs.writeFileSync(path.join(prepared.workDir, "new.txt"), "agent change");
    execFileSync("git", ["add", "-A"], { cwd: prepared.workDir });
    execFileSync("git", ["commit", "-m", "agent change"], { cwd: prepared.workDir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: prepared.workDir }).toString().trim();
    expect(head).toMatch(SHA1_40);
    expect(head).not.toBe(prepared.baseCommit);

    // 验证"git diff HEAD"已空(传统的 stale 路径),用以证明 A04 必须用 base..head
    const emptyDiff = execFileSync("git", ["diff", "--stat", "HEAD"], { cwd: prepared.workDir }).toString();
    expect(emptyDiff).toBe("");

    // A04 · 固定 base..head 范围必须返回非空且包含改动文件
    const stat = await gitDiffStat(prepared.workDir, prepared.baseCommit!, head);
    expect(stat).toContain("new.txt");
    expect(stat.length).toBeGreaterThan(0);

    // 同一 base 同样的 head,结果稳定
    const stat2 = await gitDiffStat(prepared.workDir, prepared.baseCommit!, head);
    expect(stat2).toBe(stat);
  });

  // ---------------------------------------------------------------------------
  // A04-FIX1 · 无 repo_path 普通目录任务 + prior_work_dir 存在 → 复用,无需锚点
  // ---------------------------------------------------------------------------
  it("A04-FIX1: 无 repo_path + prior_work_dir 存在 + null SavedAnchors → 复用,resumed=true,三锚点全 null", async () => {
    const runnerRoot = tmpRoot();
    // 任意一个已存在的目录(可以是非 Git 目录,模拟普通目录任务之前的 prior)
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-prior-"));
    fs.writeFileSync(path.join(priorDir, "leftover.txt"), "from previous task");

    const issue = { repo_path: null } as Issue;
    // savedAnchors 完全不传
    const prepared = await prepareWorkdir(issue, "abcdef99-0000", runnerRoot, priorDir, null);
    expect(prepared.workDir).toBe(priorDir);
    expect(prepared.resumed).toBe(true);
    expect(prepared.taskBranch).toBeNull();
    expect(prepared.targetBranch).toBeNull();
    expect(prepared.baseCommit).toBeNull();
    // prior 目录的内容没有被改写
    expect(fs.existsSync(path.join(prepared.workDir, "leftover.txt"))).toBe(true);
    // 即便传入全 null 的 SavedAnchors,行为一致
    const prepared2 = await prepareWorkdir(
      issue, "abcdef99-0001", runnerRoot, priorDir,
      { taskBranch: null, targetBranch: null, baseCommit: null },
    );
    expect(prepared2.workDir).toBe(priorDir);
    expect(prepared2.resumed).toBe(true);
    expect(prepared2.taskBranch).toBeNull();
    expect(prepared2.targetBranch).toBeNull();
    expect(prepared2.baseCommit).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // A04-FIX1 · Git 任务 resume:用真实 saved 锚点 + 实际分支一致 → 成功
  // ---------------------------------------------------------------------------
  it("A04-FIX1: Git 任务 resume + 完整 SavedAnchors + 实际分支一致 → 成功复用 workDir", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    expect(first.taskBranch).toBe("task/12345678");

    // 模拟 server 端已经把锚点写进 task row:完整三锚点
    const second = await prepareWorkdir(
      issue, "87654321-ffff-task", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
    );
    expect(second.resumed).toBe(true);
    expect(second.workDir).toBe(first.workDir);
    expect(second.taskBranch).toBe(first.taskBranch);
    expect(second.targetBranch).toBe(first.targetBranch);
    expect(second.baseCommit).toBe(first.baseCommit);
  });

  // ---------------------------------------------------------------------------
  // A04-FIX1 · Git 任务 resume:缺 target/base → 显式失败,不得从目标分支 HEAD 猜测
  // ---------------------------------------------------------------------------
  it("A04-FIX1: Git 任务 resume 缺 target_branch/base_commit → 显式失败,不得猜测", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);

    // target_branch 缺失
    await expect(prepareWorkdir(
      issue, "87654321-ffff-task", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: null, baseCommit: first.baseCommit },
    )).rejects.toThrow(/anchor|target_branch/i);
    // base_commit 缺失
    await expect(prepareWorkdir(
      issue, "87654321-ffff-task", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: null },
    )).rejects.toThrow(/anchor|base_commit/i);
  });
});

// =============================================================================
// A04-FIX1 · readWorktreeHead 必须验证分支身份 + 完整 40 位 SHA
// =============================================================================

describe("readWorktreeHead", () => {
  function seedWorktreeRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-rwh-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    return repo;
  }

  it("A04-FIX1: worktree 处于 detached HEAD → readWorktreeHead 明确失败,即使不传 expectedTaskBranch", async () => {
    const repo = seedWorktreeRepo();
    // 切到 detached HEAD
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    execFileSync("git", ["checkout", "--detach", head], { cwd: repo });
    await expect(readWorktreeHead(repo)).rejects.toThrow(/detached/i);
  });

  it("A04-FIX1: worktree 当前分支 != expectedTaskBranch → readWorktreeHead 明确失败,即使 HEAD 是合法 SHA", async () => {
    const repo = seedWorktreeRepo();
    // 当前是 main,先建一个 task/other 分支然后切过去
    execFileSync("git", ["checkout", "-b", "task/other"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "b.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "other change"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    expect(head).toMatch(SHA1_40);
    // 期望 task/expected,但实际是 task/other → 必须失败
    await expect(readWorktreeHead(repo, "task/expected")).rejects.toThrow(/branch|mismatch|taskBranch/i);
  });

  it("A04-FIX1: worktree 当前分支 === expectedTaskBranch → readWorktreeHead 返回完整 40 位 SHA", async () => {
    const repo = seedWorktreeRepo();
    execFileSync("git", ["checkout", "-b", "task/abc12345"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "c.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "change"], { cwd: repo });
    const head = await readWorktreeHead(repo, "task/abc12345");
    expect(head).toMatch(SHA1_40);
    // 同一分支,git rev-parse 出来的 SHA 必须与 readWorktreeHead 一致
    const direct = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    expect(head).toBe(direct);
  });

  it("A04-FIX1: readWorktreeHead 不传 expectedTaskBranch → 仅校验 40 位 SHA,detached 失败,正常分支成功", async () => {
    const repo = seedWorktreeRepo();
    const head = await readWorktreeHead(repo);
    expect(head).toMatch(SHA1_40);
  });
});
