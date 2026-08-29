import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureGitAvailable, git, prepareWorkdir, gitDiffStat } from "../src/worktree.js";
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
});
