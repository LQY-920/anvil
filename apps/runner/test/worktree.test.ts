import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureGitAvailable, git, prepareWorkdir } from "../src/worktree.js";
import type { Issue } from "@anvil/core";

describe("worktree", () => {
  it("ensureGitAvailable resolves git (PATH or known locations)", async () => {
    await ensureGitAvailable();
    const out = await git(process.cwd(), ["--version"]);
    expect(out).toContain("git version");
  });

  it("prepareWorkdir creates a real git worktree when repo_path set", async () => {
    await ensureGitAvailable();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-runner-"));
    const issue = { repo_path: repo } as Issue;
    const prepared = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    expect(prepared.branch).toBe("task/12345678");
    expect(fs.existsSync(path.join(prepared.workDir, "a.txt"))).toBe(true);

    const branches = execFileSync("git", ["branch", "--list"], { cwd: repo }).toString();
    expect(branches).toContain("task/12345678");
  });

  it("prepareWorkdir falls back to plain dir without repo_path", async () => {
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-runner-"));
    const prepared = await prepareWorkdir({ repo_path: null } as Issue, "abcdef99-0000", runnerRoot, null);
    expect(prepared.branch).toBeNull();
    expect(fs.existsSync(prepared.workDir)).toBe(true);
  });

  it("resume reuses workdir and recovers the existing task branch", async () => {
    await ensureGitAvailable();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });

    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-runner-"));
    const issue = { repo_path: repo } as Issue;
    const first = await prepareWorkdir(issue, "12345678-abcd-task", runnerRoot, null);
    expect(first.branch).toBe("task/12345678");
    // 第二次任务复用 first 的 work_dir：应读回已有分支而不是丢分支
    const second = await prepareWorkdir(issue, "87654321-ffff-task", runnerRoot, first.workDir);
    expect(second.resumed).toBe(true);
    expect(second.branch).toBe("task/12345678");
  });
});
