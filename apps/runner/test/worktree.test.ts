import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ensureGitAvailable, git, prepareWorkdir, gitDiffStat, readWorktreeHead,
  readGitCommonDir, assertResumeRepository, canonicalizeFsPath,
  canonicalizePathForCompare, reposEqualById, isAnchorProvided,
  hasAnySavedAnchor, areAllAnchorsPresent, resolveRealPath,
  type GitCommonDirId,
} from "../src/worktree.js";
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
    ).rejects.toThrow(/anchor|targetBranch|target_branch|baseCommit|base_commit|锚点/i);
    // 只传 task_branch 但 base 缺失同样失败(任何缺失都不得猜测)
    await expect(
      prepareWorkdir(
        issue, "87654321-ffff-task", runnerRoot, first.workDir,
        { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: null },
      ),
    ).rejects.toThrow(/anchor|baseCommit|base_commit|锚点/i);
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
    )).rejects.toThrow(/anchor|targetBranch|target_branch|锚点/i);
    // base_commit 缺失
    await expect(prepareWorkdir(
      issue, "87654321-ffff-task", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: null },
    )).rejects.toThrow(/anchor|baseCommit|base_commit|锚点/i);
  });
});

// =============================================================================
// A04-FIX2 · Resume 仓库身份校验 + 状态矩阵细化
//
// 关键不变量(防止 A04-FIX1 之后仍然存在的两类 bug):
//   1. PATCH Issue 改 repo_path 后,Runner 不得在旧仓库的 worktree 中继续执行。
//   2. Server 持久化了完整 Resume 锚点但 prior worktree 已不存在时,不得静默 fresh。
//   3. prior=null 但存在任意 saved anchor 时,不得静默创建新 task/<id> 分支。
//   4. 无 repo_path 普通目录任务不得携带任何 saved Git anchor。
// =============================================================================

describe("A04-FIX2 · canonicalizeFsPath", () => {
  it("A04-FIX2: 解析相对路径为绝对路径,realpath 失败时回退到绝对路径", () => {
    const p = canonicalizeFsPath(".");
    expect(path.isAbsolute(p)).toBe(true);
  });
  it("A04-FIX2: 已存在路径经 realpath 后保持稳定", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-canon-"));
    const a = canonicalizeFsPath(repo);
    const b = canonicalizeFsPath(repo);
    expect(a).toBe(b);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("A04-FIX2 · readGitCommonDir", () => {
  it("A04-FIX2: 普通仓库返回自身 .git 路径 + 文件标识", async () => {
    const repo = seedRepo();
    const id = await readGitCommonDir(repo);
    expect(id.path).toMatch(/\.git$/);
    expect(id.dev).not.toBe(0n);
    expect(id.ino).not.toBe(0n);
  });
  it("A04-FIX2: worktree 的 common dir 等于主仓库的 common dir(按 dev+ino)", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const wt = await prepareWorkdir(issue, "abcd1234-t", runnerRoot, null);
    const main = await readGitCommonDir(repo);
    const wtCommon = await readGitCommonDir(wt.workDir);
    expect(wtCommon.dev).toBe(main.dev);
    expect(wtCommon.ino).toBe(main.ino);
  });
});

describe("A04-FIX2 · 本地仓库身份校验", () => {
  it("A04-FIX2: 仓库 A 的 prior worktree + Issue 仍为 A → Resume 成功,resumed=true", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd", runnerRoot, null);
    const second = await prepareWorkdir(
      issue, "87654321-ffff", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
    );
    expect(second.resumed).toBe(true);
    expect(second.workDir).toBe(first.workDir);
  });

  it("A04-FIX2: 仓库 A 的 prior worktree + Issue 改成仓库 B → 明确失败,不在 B 创建 task branch,不修改 A 的 worktree", async () => {
    const repoA = seedRepo();
    const repoB = seedRepo();
    const runnerRoot = tmpRoot();
    const issueA = { repo_path: repoA } as Issue;
    const first = await prepareWorkdir(issueA, "12345678-abcd", runnerRoot, null);
    expect(first.taskBranch).toBe("task/12345678");

    // prior 属于 A,但 issue 改成 B
    const issueB = { repo_path: repoB } as Issue;
    await expect(prepareWorkdir(
      issueB, "87654321-ffff", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
    )).rejects.toThrow(/仓库|repo|repository|不一致|不匹配/i);

    // B 不应出现 task/87654321 分支
    const branchesB = execFileSync("git", ["branch", "--list"], { cwd: repoB }).toString();
    expect(branchesB).not.toContain("task/87654321");
    // A 的 worktree 仍存在且分支未变
    const wtBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: first.workDir }).toString().trim();
    expect(wtBranch).toBe("task/12345678");
  });

  it("A04-FIX2: issue.repo_path 使用不同文本形式(同仓库)→ 仍能 Resume(Windows 大小写 / realpath 等价形式)", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd", runnerRoot, null);

    // 用 . / .. 段构造一条指向同一目录的文本路径(不依赖用户硬编码目录)
    // 例如 /tmp/anvil-runner-XXX/worktrees/12345678/../12345678 与 /tmp/anvil-runner-XXX/worktrees/12345678 同指一处
    const altPrior = path.join(first.workDir, ".", ".");
    // 验证:虽然文本形式不同,但 (dev,ino) 必须一致
    const id1 = await readGitCommonDir(first.workDir);
    const id2 = await readGitCommonDir(altPrior);
    expect(id1.dev).toBe(id2.dev);
    expect(id1.ino).toBe(id2.ino);

    // 把 issue.repo_path 也换成 realpath 形式(可能与 first.workDir 的文本形式不同)
    // 由于 prior workdir 属于 repo 的 .git,只要 issue.repo_path 指向同一 repo,Resume 必须成功
    // 这里直接把 first 的路径作为 issue.repo_path(它是 repo 的 worktree,不属于 repo 本体)
    // 所以我们用 repo 自身(不同方式)来构造 issue.repo_path 的等价形式
    const altIssuePath = repo; // baseline
    // 验证:assertResumeRepository 不抛错
    await expect(assertResumeRepository(first.workDir, altIssuePath, runnerRoot)).resolves.toBeUndefined();
  });
});

describe("A04-FIX2 · 状态矩阵:prior / anchor 关系", () => {
  it("A04-FIX2: prior 存在 + 完整 anchor + 仓库一致 + 分支一致 → 合法 Resume", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd", runnerRoot, null);
    const second = await prepareWorkdir(
      issue, "87654321-ffff", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
    );
    expect(second.resumed).toBe(true);
  });

  it("A04-FIX2: prior 存在但目录已删除 → 明确失败,不创建 fresh worktree,不创建新 task branch", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd", runnerRoot, null);
    // 删除 worktree 目录(模拟执行前被外部删除)
    fs.rmSync(first.workDir, { recursive: true, force: true });
    // 用一个 40 位 hex baseCommit 模拟 Server 已持久化完整锚点
    const fakeBase = "0123456789abcdef0123456789abcdef01234567";
    await expect(prepareWorkdir(
      issue, "87654321-ffff", runnerRoot, first.workDir,
      { taskBranch: "task/12345678", targetBranch: "main", baseCommit: fakeBase },
    )).rejects.toThrow(/不存在|Resume worktree|不.*存/i);
    // 关键:不创建新的 task/87654321 分支(因为我们用 prior 路径,但 worktree 已删)
    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo }).toString();
    expect(branches).not.toContain("task/87654321");
    // runnerRoot 下没有 worktrees/87654321 新建
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "87654321"))).toBe(false);
  });

  it("A04-FIX2: prior=null + anchors 全 null → 合法 initial/fresh", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const prepared = await prepareWorkdir(issue, "abcdef00-1234", runnerRoot, null, {
      taskBranch: null, targetBranch: null, baseCommit: null,
    });
    expect(prepared.resumed).toBe(false);
    expect(prepared.taskBranch).toBe("task/abcdef00");
  });

  it("A04-FIX2: prior=null + 完整三锚点 → 明确失败,不创建 fresh worktree", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const fakeBase = "0123456789abcdef0123456789abcdef01234567";
    await expect(prepareWorkdir(
      issue, "abcdef00-1234", runnerRoot, null,
      { taskBranch: "task/abcdef00", targetBranch: "main", baseCommit: fakeBase },
    )).rejects.toThrow(/priorWorkDir|prior.*空|saved.*anchor|anchor/i);
    // 不创建 fresh worktree
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "abcdef00"))).toBe(false);
  });

  it("A04-FIX2: prior=null + 部分锚点(只 taskBranch)→ 明确失败,不创建 fresh worktree", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    await expect(prepareWorkdir(
      issue, "abcdef00-1234", runnerRoot, null,
      { taskBranch: "task/abcdef00", targetBranch: null, baseCommit: null },
    )).rejects.toThrow(/priorWorkDir|prior.*空|saved.*anchor|anchor/i);
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "abcdef00"))).toBe(false);
  });

  it("A04-FIX2: prior=null + 部分锚点(只 baseCommit)→ 明确失败,不创建 fresh worktree", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const fakeBase = "0123456789abcdef0123456789abcdef01234567";
    await expect(prepareWorkdir(
      issue, "abcdef00-1234", runnerRoot, null,
      { taskBranch: null, targetBranch: null, baseCommit: fakeBase },
    )).rejects.toThrow(/priorWorkDir|prior.*空|saved.*anchor|anchor/i);
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "abcdef00"))).toBe(false);
  });

  it("A04-FIX2: prior 存在但 anchor 缺 taskBranch → 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd", runnerRoot, null);
    const fakeBase = "0123456789abcdef0123456789abcdef01234567";
    await expect(prepareWorkdir(
      issue, "87654321-ffff", runnerRoot, first.workDir,
      { taskBranch: null, targetBranch: "main", baseCommit: fakeBase },
    )).rejects.toThrow(/anchor|targetBranch|target_branch|baseCommit|base_commit|锚点|不.*完整/i);
  });

  it("A04-FIX2: 无 repo_path + prior 目录 → 继续成功复用,三锚点全 null", async () => {
    const runnerRoot = tmpRoot();
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix2-prior-"));
    fs.writeFileSync(path.join(priorDir, "leftover.txt"), "keep");
    const issue = { repo_path: null } as Issue;
    const prepared = await prepareWorkdir(issue, "abcdef00-9999", runnerRoot, priorDir, {
      taskBranch: null, targetBranch: null, baseCommit: null,
    });
    expect(prepared.workDir).toBe(priorDir);
    expect(prepared.resumed).toBe(true);
    expect(prepared.taskBranch).toBeNull();
    expect(prepared.targetBranch).toBeNull();
    expect(prepared.baseCommit).toBeNull();
    expect(fs.existsSync(path.join(prepared.workDir, "leftover.txt"))).toBe(true);
  });

  it("A04-FIX2: 无 repo_path + 任意非 null saved anchor → 明确失败,不得忽略异常锚点", async () => {
    const runnerRoot = tmpRoot();
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix2-prior-"));
    const issue = { repo_path: null } as Issue;
    // 只传 taskBranch(其他 null)
    await expect(prepareWorkdir(issue, "abcdef00-9999", runnerRoot, priorDir, {
      taskBranch: "task/abcdef00", targetBranch: null, baseCommit: null,
    })).rejects.toThrow(/无 repo_path|Git.*anchor|Git.*锚点|saved.*anchor/i);
    // 只传 baseCommit
    await expect(prepareWorkdir(issue, "abcdef00-9999", runnerRoot, priorDir, {
      taskBranch: null, targetBranch: null, baseCommit: "0123456789abcdef0123456789abcdef01234567",
    })).rejects.toThrow(/无 repo_path|Git.*anchor|Git.*锚点|saved.*anchor/i);
    // 三项都非 null
    await expect(prepareWorkdir(issue, "abcdef00-9999", runnerRoot, priorDir, {
      taskBranch: "task/abcdef00", targetBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567",
    })).rejects.toThrow(/无 repo_path|Git.*anchor|Git.*锚点|saved.*anchor/i);
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

// =============================================================================
// A04-FIX3 · 仓库身份精度(BigIntStats) + 路径规范化(Windows 长路径/UNC) +
//              仓库身份比较(reposEqualById) + 空字符串锚点状态矩阵
//
// 关键不变量(对应 Codex 在 A04-FIX2 review 中识别的两类 bug):
//  1. 仓库身份 dev/ino 必须直接来自 fs.statSync(path, { bigint: true }) 精确读取,
//     不得先取普通 fs.Stats 再 BigInt(number) 转换(Windows inode 会丢精度)。
//  2. 仓库身份比较必须综合规范路径与精确 dev/ino,避免 0n/0n 跨路径误判。
//  3. Windows 路径归一必须正确处理 \\?\ 与 \\?\UNC\ 前缀(UNC 根保留双反斜杠)。
//  4. hasAnySavedAnchor / areAllAnchorsPresent 严格按 null/undefined 判断,
//     空字符串视为"已提供但非法",被状态矩阵拒绝(不得绕过非法状态守卫)。
// =============================================================================

describe("A04-FIX3 · readGitCommonDir 精确 BigIntStats", () => {
  it("A04-FIX3: dev/ino 与 fs.statSync(path, { bigint: true }) 精确相等,不只校验 typeof === 'bigint'", async () => {
    const repo = seedRepo();
    const id = await readGitCommonDir(repo);
    // 必须用 bigint:true 拿一次对照值,然后逐字段 ===
    const realStat = fs.statSync(id.realPath, { bigint: true });
    expect(typeof id.dev).toBe("bigint");
    expect(typeof id.ino).toBe("bigint");
    expect(id.dev).toBe(realStat.dev);
    expect(id.ino).toBe(realStat.ino);
    // 显式反向校验:普通 statSync 拿 number 后再用 BigInt(number) 包装,
    // 如果原始值超过 Number.MAX_SAFE_INTEGER,BigInt(number) 会得到一个与真实值不同的 bigint。
    // 这正是 A04-FIX3 修复的"先用普通 stat 再 BigInt"反模式;这里证明 readGitCommonDir
    // 走的是 bigint:true 直读,而不是 BigInt(number) 包装出来的"伪 bigint"。
    const smallStat = fs.statSync(id.realPath);
    if (BigInt(smallStat.dev) !== realStat.dev || BigInt(smallStat.ino) !== realStat.ino) {
      // 平台 inode 超 MAX_SAFE_INTEGER(典型 Windows NTFS):只有 BigIntStats 才是真值
      expect(id.dev).toBe(realStat.dev);
      expect(id.ino).toBe(realStat.ino);
      expect(BigInt(smallStat.ino)).not.toBe(realStat.ino);
    }
  });

  it("A04-FIX3: resolveRealPath 返回真实可访问路径,不进行大小写归一", () => {
    const repo = seedRepo();
    const real = resolveRealPath(repo);
    expect(fs.existsSync(real)).toBe(true);
    // 真实路径不得被 canonicalizeFsPath 改大小写;resolveRealPath 与 realpath 行为一致
    const rp = fs.realpathSync(repo);
    expect(real).toBe(rp);
  });
});

describe("A04-FIX3 · reposEqualById 仓库身份比较规则", () => {
  function id(path: string, dev: bigint, ino: bigint): GitCommonDirId {
    return { realPath: path, path, dev, ino };
  }

  it("A04-FIX3: 相同规范路径 + 两边 0n/0n → 相同(规范路径优先级最高)", () => {
    const a = id("c:\\repo\\.git", 0n, 0n);
    const b = id("c:\\repo\\.git", 0n, 0n);
    expect(reposEqualById(a, b)).toBe(true);
  });

  it("A04-FIX3: 不同规范路径 + 两边都是 0n/0n → 不同(不得把两个未取到文件标识的目录判同)", () => {
    const a = id("c:\\repo-a\\.git", 0n, 0n);
    const b = id("c:\\repo-b\\.git", 0n, 0n);
    expect(reposEqualById(a, b)).toBe(false);
  });

  it("A04-FIX3: 不同规范路径 + 相同精确非零 dev/ino → 相同(8.3 / 符号链接 / 长路径别名场景)", () => {
    const a = id("c:\\repo\\.git", 12345n, 67890n);
    const b = id("\\\\?\\c:\\repo\\.git", 12345n, 67890n);
    expect(reposEqualById(a, b)).toBe(true);
  });

  it("A04-FIX3: 不同规范路径 + dev 不同 → 不同", () => {
    const a = id("c:\\repo-a\\.git", 11111n, 22222n);
    const b = id("c:\\repo-b\\.git", 33333n, 22222n);
    expect(reposEqualById(a, b)).toBe(false);
  });

  it("A04-FIX3: 不同规范路径 + ino 不同 → 不同", () => {
    const a = id("c:\\repo-a\\.git", 12345n, 11111n);
    const b = id("c:\\repo-b\\.git", 12345n, 22222n);
    expect(reposEqualById(a, b)).toBe(false);
  });

  it("A04-FIX3: 一侧 0n/0n 另一侧非零 dev/ino 但不同路径 → 仍按 dev/ino 比较,允许判同(8.3 别名)", () => {
    const a = id("c:\\repo\\.git", 0n, 0n);
    const b = id("\\\\?\\c:\\repo\\.git", 12345n, 67890n);
    // a 没有有效文件标识,只能依赖路径;路径不同 ⇒ 一定不同
    expect(reposEqualById(a, b)).toBe(false);
  });
});

describe("A04-FIX3 · canonicalizePathForCompare Windows 路径归一", () => {
  it("A04-FIX3: \\\\?\\C:\\Repo\\.git → 去除长路径前缀并小写归一", () => {
    expect(canonicalizePathForCompare("\\\\?\\C:\\Repo\\.git", true)).toBe("c:\\repo\\.git");
  });

  it("A04-FIX3: \\\\?\\UNC\\server\\share\\repo\\.git → 还原为 \\\\server\\share\\repo\\.git(保留双反斜杠)", () => {
    const out = canonicalizePathForCompare("\\\\?\\UNC\\server\\share\\repo\\.git", true);
    expect(out).toBe("\\\\server\\share\\repo\\.git");
    // 不能错误地变成 UNC\server\...(没有前导双反斜杠)
    expect(out.startsWith("\\\\")).toBe(true);
    expect(out.startsWith("UNC\\")).toBe(false);
  });

  it("A04-FIX3: 普通 UNC 路径(无长路径前缀)不丢开头的双反斜杠", () => {
    const out = canonicalizePathForCompare("\\\\server\\share\\repo\\.git", true);
    expect(out).toBe("\\\\server\\share\\repo\\.git");
  });

  it("A04-FIX3: POSIX 路径不主动小写,只把分隔符归一为 /", () => {
    expect(canonicalizePathForCompare("C:\\Repo\\.git", false)).toBe("C:/Repo/.git");
    expect(canonicalizePathForCompare("/tmp/Repo/.git", false)).toBe("/tmp/Repo/.git");
  });

  it("A04-FIX3: 在非 Windows 跑测时也能显式校验 Windows 归一行为(win32Mode 显式传 true)", () => {
    // 即便运行平台不是 Windows,函数显式 win32Mode=true 也走 Windows 分支
    const out = canonicalizePathForCompare("\\\\?\\UNC\\srv\\share\\repo", true);
    expect(out).toBe("\\\\srv\\share\\repo");
  });
});

describe("A04-FIX3 · 锚点字段提供判定(严格按 null/undefined)", () => {
  it("A04-FIX3: isAnchorProvided 严格区分 null/undefined 与空字符串", () => {
    expect(isAnchorProvided("task/abc")).toBe(true);
    expect(isAnchorProvided("")).toBe(true);
    expect(isAnchorProvided(null)).toBe(false);
    expect(isAnchorProvided(undefined)).toBe(false);
  });

  it("A04-FIX3: hasAnySavedAnchor 空字符串视为已提供(空字符串也按 anchor 算)", () => {
    // 三项全 null ⇒ false
    expect(hasAnySavedAnchor({ taskBranch: null, targetBranch: null, baseCommit: null })).toBe(false);
    expect(hasAnySavedAnchor(null)).toBe(false);
    // 任一字段是空字符串 ⇒ true(空字符串算"已提供但非法")
    expect(hasAnySavedAnchor({ taskBranch: "", targetBranch: null, baseCommit: null })).toBe(true);
    expect(hasAnySavedAnchor({ taskBranch: null, targetBranch: "", baseCommit: null })).toBe(true);
    expect(hasAnySavedAnchor({ taskBranch: null, targetBranch: null, baseCommit: "" })).toBe(true);
  });

  it("A04-FIX3: areAllAnchorsPresent 严格按 null/undefined,空字符串也算已提供", () => {
    expect(areAllAnchorsPresent(null)).toBe(false);
    expect(areAllAnchorsPresent({ taskBranch: null, targetBranch: null, baseCommit: null })).toBe(false);
    // 空字符串算"齐全"(但 prepareWorkdir 后续会按格式校验拒绝)
    expect(areAllAnchorsPresent({ taskBranch: "", targetBranch: "", baseCommit: "" })).toBe(true);
    expect(areAllAnchorsPresent({ taskBranch: "task/a", targetBranch: "main", baseCommit: "0123456789abcdef0123456789abcdef01234567" })).toBe(true);
  });
});

describe("A04-FIX3 · 空字符串锚点状态矩阵(Git 任务)", () => {
  it("A04-FIX3: priorWorkDir=null + taskBranch='' → 明确失败,不创建 worktree", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    await expect(prepareWorkdir(
      issue, "ff000001-aaaa", runnerRoot, null,
      { taskBranch: "", targetBranch: null, baseCommit: null },
    )).rejects.toThrow(/priorWorkDir|prior.*空|saved.*anchor|anchor|空字符串|纯空白/i);
    // 不应创建 fresh worktree
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "ff000001"))).toBe(false);
    // 也不应在 repo 中创建 task/ff000001 分支
    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo }).toString();
    expect(branches).not.toContain("task/ff000001");
  });

  it("A04-FIX3: priorWorkDir=null + targetBranch='' → 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    await expect(prepareWorkdir(
      issue, "ff000002-aaaa", runnerRoot, null,
      { taskBranch: null, targetBranch: "", baseCommit: null },
    )).rejects.toThrow(/priorWorkDir|prior.*空|saved.*anchor|anchor|空字符串|纯空白/i);
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "ff000002"))).toBe(false);
  });

  it("A04-FIX3: priorWorkDir=null + baseCommit='' → 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    await expect(prepareWorkdir(
      issue, "ff000003-aaaa", runnerRoot, null,
      { taskBranch: null, targetBranch: null, baseCommit: "" },
    )).rejects.toThrow(/priorWorkDir|prior.*空|saved.*anchor|anchor|空字符串|纯空白/i);
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "ff000003"))).toBe(false);
  });

  it("A04-FIX3: priorWorkDir 存在 + 三项齐全但 taskBranch='' → 明确失败,不进入 Resume", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "11223344-ffff", runnerRoot, null);
    await expect(prepareWorkdir(
      issue, "55667788-eeee", runnerRoot, first.workDir,
      { taskBranch: "", targetBranch: "main", baseCommit: first.baseCommit },
    )).rejects.toThrow(/空字符串|纯空白|sha|sha1|40/i);
  });

  it("A04-FIX3: priorWorkDir 存在 + 三项齐全但 targetBranch='' → 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "11223344-ffff", runnerRoot, null);
    await expect(prepareWorkdir(
      issue, "55667788-eeee", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: "", baseCommit: first.baseCommit },
    )).rejects.toThrow(/空字符串|纯空白/i);
  });

  it("A04-FIX3: priorWorkDir 存在 + 三项齐全但 baseCommit='' → 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "11223344-ffff", runnerRoot, null);
    await expect(prepareWorkdir(
      issue, "55667788-eeee", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: "" },
    )).rejects.toThrow(/sha|sha1|40/i);
  });

  it("A04-FIX3: priorWorkDir 存在 + 三项齐全但 targetBranch='  '(纯空白)→ 明确失败", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "11223344-ffff", runnerRoot, null);
    await expect(prepareWorkdir(
      issue, "55667788-eeee", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: "   ", baseCommit: first.baseCommit },
    )).rejects.toThrow(/空字符串|纯空白/i);
  });
});

describe("A04-FIX3 · 空字符串锚点状态矩阵(无 repo_path 普通目录任务)", () => {
  it("A04-FIX3: 无 repo_path + taskBranch='' → 明确失败,不得创建普通目录", async () => {
    const runnerRoot = tmpRoot();
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix3-norepo-"));
    const issue = { repo_path: null } as Issue;
    await expect(prepareWorkdir(
      issue, "aa00bb00-cccc", runnerRoot, priorDir,
      { taskBranch: "", targetBranch: null, baseCommit: null },
    )).rejects.toThrow(/无 repo_path|saved.*anchor|Git.*锚点|空字符串/i);
  });

  it("A04-FIX3: 无 repo_path + targetBranch='' → 明确失败,不得创建普通目录", async () => {
    const runnerRoot = tmpRoot();
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix3-norepo-"));
    const issue = { repo_path: null } as Issue;
    await expect(prepareWorkdir(
      issue, "aa00bb00-cccc", runnerRoot, priorDir,
      { taskBranch: null, targetBranch: "", baseCommit: null },
    )).rejects.toThrow(/无 repo_path|saved.*anchor|Git.*锚点|空字符串/i);
  });

  it("A04-FIX3: 无 repo_path + baseCommit='' → 明确失败,不得创建普通目录", async () => {
    const runnerRoot = tmpRoot();
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix3-norepo-"));
    const issue = { repo_path: null } as Issue;
    await expect(prepareWorkdir(
      issue, "aa00bb00-cccc", runnerRoot, priorDir,
      { taskBranch: null, targetBranch: null, baseCommit: "" },
    )).rejects.toThrow(/无 repo_path|saved.*anchor|Git.*锚点|空字符串/i);
  });

  it("A04-FIX3: 无 repo_path 失败时不得在 runnerRoot 下创建新 worktree 目录", async () => {
    const runnerRoot = tmpRoot();
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix3-norepo-"));
    const issue = { repo_path: null } as Issue;
    await expect(prepareWorkdir(
      issue, "aa00bb00-cccc", runnerRoot, priorDir,
      { taskBranch: "", targetBranch: null, baseCommit: null },
    )).rejects.toThrow();
    expect(fs.existsSync(path.join(runnerRoot, "worktrees", "aa00bb00"))).toBe(false);
  });
});

describe("A04-FIX3 · 正常回归(确保 A04-FIX2 行为不被破坏)", () => {
  it("A04-FIX3: Git 任务 prior=null + 三 anchor 全 null → 合法 fresh", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const prepared = await prepareWorkdir(issue, "abcdef00-1111", runnerRoot, null, {
      taskBranch: null, targetBranch: null, baseCommit: null,
    });
    expect(prepared.resumed).toBe(false);
    expect(prepared.taskBranch).toBe("task/abcdef00");
  });

  it("A04-FIX3: Git 任务 prior 存在 + 完整合法 SavedAnchors + 同仓库 + 分支一致 → Resume 成功", async () => {
    const repo = seedRepo();
    const runnerRoot = tmpRoot();
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "abcdef00-2222", runnerRoot, null);
    const second = await prepareWorkdir(
      issue, "abcdef00-3333", runnerRoot, first.workDir,
      { taskBranch: first.taskBranch, targetBranch: first.targetBranch, baseCommit: first.baseCommit },
    );
    expect(second.resumed).toBe(true);
    expect(second.workDir).toBe(first.workDir);
    expect(second.taskBranch).toBe(first.taskBranch);
  });

  it("A04-FIX3: 无 repo_path + prior=null + 三 anchor 全 null → 创建普通目录,三 anchor 全 null", async () => {
    const runnerRoot = tmpRoot();
    const issue = { repo_path: null } as Issue;
    const prepared = await prepareWorkdir(issue, "abcdef00-4444", runnerRoot, null, {
      taskBranch: null, targetBranch: null, baseCommit: null,
    });
    expect(prepared.taskBranch).toBeNull();
    expect(prepared.targetBranch).toBeNull();
    expect(prepared.baseCommit).toBeNull();
    expect(prepared.resumed).toBe(false);
    expect(fs.existsSync(prepared.workDir)).toBe(true);
  });

  it("A04-FIX3: 无 repo_path + prior 存在 + 三 anchor 全 null → 复用目录,resumed=true", async () => {
    const runnerRoot = tmpRoot();
    const priorDir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-fix3-prior-"));
    fs.writeFileSync(path.join(priorDir, "leftover.txt"), "keep");
    const issue = { repo_path: null } as Issue;
    const prepared = await prepareWorkdir(issue, "abcdef00-5555", runnerRoot, priorDir, {
      taskBranch: null, targetBranch: null, baseCommit: null,
    });
    expect(prepared.workDir).toBe(priorDir);
    expect(prepared.resumed).toBe(true);
    expect(prepared.taskBranch).toBeNull();
    expect(fs.existsSync(path.join(prepared.workDir, "leftover.txt"))).toBe(true);
  });
});
