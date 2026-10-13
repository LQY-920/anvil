import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { type Issue, type RepositorySnapshot } from "@anvil/core";
import { withGitLock } from "@anvil/core/git-lock";
import { git, prepareWorkdir, readGitCommonDir } from "../src/worktree.js";

const roots: string[] = [];
function temporary(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-bound-worktree-"));
  roots.push(root);
  return root;
}
function command(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function seedRepo(directory: string): string {
  fs.mkdirSync(directory);
  command(directory, ["init", "-b", "main"]);
  command(directory, ["config", "user.name", "测试"]);
  command(directory, ["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(directory, "file.txt"), "基线");
  command(directory, ["add", "file.txt"]);
  command(directory, ["commit", "-m", "基线"]);
  return directory;
}
async function snapshot(repo: string, overrides: Partial<RepositorySnapshot> = {}): Promise<RepositorySnapshot> {
  const id = await readGitCommonDir(repo);
  return {
    schema_version: 1, repository_id: "repository", mode: "local_git", host: "local", external_id: "local-repository",
    full_name: "本地仓库", clone_url: repo, target_branch: "main", checkout_path: repo,
    identity: { real_path: id.realPath, dev: id.dev.toString(), ino: id.ino.toString() },
    source_snapshot_id: null, input: { title: "固定目标", description: null, acceptance: null }, ...overrides,
  };
}
const issue = { repo_path: "D:/不可变快照之外的目录" } as Issue;

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("T01 绑定仓库工作树", () => {
  it("返工在新工作树承接开放 PR 提交，同时保留真实目标基线", async () => {
    const root = temporary(), repo = seedRepo(path.join(root, "repo"));
    const base = command(repo, ["rev-parse", "main"]);
    command(repo, ["checkout", "-b", "task/pr"]);
    fs.writeFileSync(path.join(repo, "prior.txt"), "开放 PR 的交付");
    command(repo, ["add", "."]); command(repo, ["commit", "-m", "原交付"]);
    const head = command(repo, ["rev-parse", "HEAD"]); command(repo, ["checkout", "main"]);
    const saved = await snapshot(repo, { starting_commit: head });
    const prepared = await prepareWorkdir(issue, "new-review-task", path.join(root, "runner"), null, null, saved);
    expect(prepared.baseCommit).toBe(base);
    expect(command(prepared.workDir, ["rev-parse", "HEAD"])).toBe(head);
    expect(prepared.taskBranch).toBe("task/new-review-task");
    expect(command(repo, ["rev-parse", "task/pr"])).toBe(head);
  });
  it("本地基线来自保存的目标 ref，不跟随 checkout 当前分支或 Issue 路径", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const base = command(repo, ["rev-parse", "main"]);
    const saved = await snapshot(repo);
    command(repo, ["checkout", "-b", "feature"]);
    fs.writeFileSync(path.join(repo, "file.txt"), "当前分支另有改动");
    command(repo, ["commit", "-am", "其他分支"]);
    const prepared = await prepareWorkdir(issue, "12345678-full-task-id", path.join(root, "runner"), null, null, saved);
    expect(prepared).toMatchObject({ taskBranch: "task/12345678-full-task-id", targetBranch: "main", baseCommit: base, resumed: false });
    expect(fs.readFileSync(path.join(prepared.workDir, "file.txt"), "utf8")).toBe("基线");
    expect(command(repo, ["branch", "--show-current"])).toBe("feature");
    expect(fs.existsSync(path.join(saved.identity.real_path, "anvil-operation.lock"))).toBe(false);
  });

  it("相同 short ID 的不同任务使用完整 ID，不碰撞分支/目录", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const saved = await snapshot(repo);
    const first = await prepareWorkdir(issue, "samehead-task-one", path.join(root, "runner"), null, null, saved);
    const second = await prepareWorkdir(issue, "samehead-task-two", path.join(root, "runner"), null, null, saved);
    expect(first.taskBranch).not.toBe(second.taskBranch);
    expect(first.workDir).not.toBe(second.workDir);
    expect(first.baseCommit).toBe(second.baseCommit);
  });

  it("仓库在同路径被替换后拒绝执行，不因路径相同接受新的 inode", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const saved = await snapshot(repo);
    fs.renameSync(repo, path.join(root, "old-repo"));
    seedRepo(repo);
    await expect(prepareWorkdir(issue, "replaced-repo", path.join(root, "runner"), null, null, saved)).rejects.toThrow("仓库身份与 Task 原始快照不一致");
    expect(command(repo, ["branch", "--list", "task/*"])).toBe("");
  });

  it("弱身份仍保留路径大小写，不能用大小写折叠猜测相同仓库", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const saved = await snapshot(repo);
    saved.identity = { real_path: saved.identity.real_path.toUpperCase(), dev: "0", ino: "0" };
    await expect(prepareWorkdir(issue, "weak-id", path.join(root, "runner"), null, null, saved)).rejects.toThrow("仓库身份与 Task 原始快照不一致");
  });

  it("拒绝 number 文件标识，避免将已丢精度的值包装成 bigint", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const saved = await snapshot(repo);
    (saved.identity as unknown as { ino: number }).ino = Number.MAX_SAFE_INTEGER + 1;
    await expect(prepareWorkdir(issue, "unsafe-id", path.join(root, "runner"), null, null, saved)).rejects.toThrow("无损十进制文件标识");
  });

  it("明确目标不存在时失败，不回退 HEAD", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const saved = await snapshot(repo, { target_branch: "missing" });
    await expect(prepareWorkdir(issue, "missing-target", path.join(root, "runner"), null, null, saved)).rejects.toThrow(/refs\/heads\/missing/);
    expect(command(repo, ["branch", "--list", "task/*"])).toBe("");
  });

  it("绑定任务不得携带 prior 或旧锚点继续执行", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const saved = await snapshot(repo);
    await expect(prepareWorkdir(issue, "with-prior", root, repo, null, saved)).rejects.toThrow("绑定任务必须使用新工作树");
    await expect(prepareWorkdir(issue, "with-anchor", root, null, { taskBranch: "task/old", targetBranch: null, baseCommit: null }, saved)).rejects.toThrow("绑定任务必须使用新工作树");
  });

  it("等待共享 Git 锁期间不创建分支，释放后才能完成准备", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const saved = await snapshot(repo);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const owner = withGitLock(saved.identity.real_path, async () => { entered(); await blocked; });
    await ready;
    let finished = false;
    const pending = prepareWorkdir(issue, "locked-task", path.join(root, "runner"), null, null, saved).then(result => { finished = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(finished).toBe(false);
      expect(command(repo, ["branch", "--list", "task/locked-task"])).toBe("");
    } finally { release(); await owner; }
    expect((await pending).taskBranch).toBe("task/locked-task");
  });

  it("GitHub 模式 fetch 明确远端目标，忽略缓存的本地 main 和当前 HEAD", async () => {
    const root = temporary();
    const upstream = seedRepo(path.join(root, "upstream"));
    const remote = path.join(root, "remote.git");
    command(root, ["clone", "--bare", upstream, remote]);
    const remoteUrl = pathToFileURL(remote).href;
    const checkout = path.join(root, "checkout");
    command(root, ["clone", remoteUrl, checkout]);
    const oldBase = command(checkout, ["rev-parse", "main"]);
    command(checkout, ["checkout", "-b", "unrelated"]);
    fs.writeFileSync(path.join(upstream, "file.txt"), "新远端基线");
    command(upstream, ["commit", "-am", "远端前进"]);
    command(upstream, ["push", remoteUrl, "main"]);
    const newBase = command(upstream, ["rev-parse", "main"]);
    const saved = await snapshot(checkout, { mode: "github_pr", host: "github.com", clone_url: remoteUrl });
    const prepared = await prepareWorkdir(issue, "github-main-task", path.join(root, "runner"), null, null, saved);
    expect(prepared.baseCommit).toBe(newBase);
    expect(prepared.baseCommit).not.toBe(oldBase);
    expect(command(checkout, ["rev-parse", "main"])).toBe(oldBase);
    expect(command(checkout, ["branch", "--show-current"])).toBe("unrelated");
    expect(fs.readFileSync(path.join(prepared.workDir, "file.txt"), "utf8")).toBe("新远端基线");
  }, 15_000);

  it("确认新地址后旧 origin 不影响执行，fetch 只使用冻结地址", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    command(repo, ["remote", "add", "origin", "file:///different-repository"]);
    const remote = path.join(root, "renamed.git");
    command(root, ["clone", "--bare", repo, remote]);
    const saved = await snapshot(repo, { mode: "github_pr", clone_url: pathToFileURL(remote).href });
    const prepared = await prepareWorkdir(issue, "changed-origin", root, null, null, saved);
    expect(prepared.baseCommit).toBe(command(repo, ["rev-parse", "main"]));
    expect(command(repo, ["remote", "get-url", "origin"])).toBe("file:///different-repository");
  });

  it("冻结地址被 insteadOf 指向其他仓库时阻断，不依赖 origin 作安全检查", async () => {
    const root = temporary(), repo = seedRepo(path.join(root, "repo"));
    command(repo, ["config", "url.file:///different.insteadOf", "https://github.com/owner/repo.git"]);
    const saved = await snapshot(repo, { mode: "github_pr", clone_url: "https://github.com/owner/repo.git" });
    await expect(prepareWorkdir(issue, "rewritten-url", root, null, null, saved)).rejects.toThrow("Git URL 重写与原始绑定不一致");
  });

  it("Git helper 忽略 replace refs，读取原始提交内容", async () => {
    const root = temporary();
    const repo = seedRepo(path.join(root, "repo"));
    const original = command(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "file.txt"), "替换内容");
    command(repo, ["commit", "-am", "第二版"]);
    const replacement = command(repo, ["rev-parse", "HEAD"]);
    command(repo, ["replace", original, replacement]);
    expect(command(repo, ["show", `${original}:file.txt`])).toBe("替换内容");
    expect(await git(repo, ["show", `${original}:file.txt`])).toBe("基线");
  });
});
