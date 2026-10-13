import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GhClient, GitHubError, parseGitHubRepository, retryDelay, validateGitHubRequest } from "../src/lib/github.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fakeGh(code: string, options: { timeoutMs?: number; maxBytes?: number } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-gh-client-")); directories.push(directory);
  const file = path.join(directory, "gh.mjs"); fs.writeFileSync(file, code);
  return new GhClient({ command: process.execPath, argsPrefix: [file], ...options });
}

describe("受限 GitHub 客户端", () => {
  it("HTTPS 与两种 SSH 地址归一；带凭据和非允许主机被拒绝", () => {
    for (const value of ["https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
      expect(parseGitHubRepository(value)).toEqual({ host: "github.com", owner: "owner", name: "repo", fullName: "owner/repo" });
    }
    for (const value of ["https://user:secret@github.com/owner/repo", "https://elsewhere.example/owner/repo", "https://github.com/owner/repo?token=secret", "file:///repo"]) {
      expect(() => parseGitHubRepository(value)).toThrow();
    }
  });

  it("拒绝自动合并、保护设置和任意 URL；允许固定 PR 与分支查询", () => {
    for (const endpoint of ["https://github.com/repos/o/r/pulls", "/repos/o/r/pulls/1/merge", "/repos/o/r/branches/main/protection", "//example.org/"]) {
      expect(() => validateGitHubRequest("github.com", "POST", endpoint)).toThrow();
    }
    expect(() => validateGitHubRequest("github.com", "GET", "/repos/o/r/git/ref/heads/task%2Fabc")).not.toThrow();
    expect(() => validateGitHubRequest("github.com", "POST", "/repos/o/r/pulls")).not.toThrow();
  });

  it("gh 使用显式 method/hostname，POST JSON 通过 stdin 而非命令字符串", async () => {
    const client = fakeGh(`let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
      process.stdout.write('HTTP/2.0 201 Created\\r\\nX-Request-Id: test\\r\\n\\r\\n'+JSON.stringify({args:process.argv.slice(2),input}));});`);
    const result = await client.request<any>("github.com", "POST", "/repos/o/r/pulls", { title: "中文 ` $(不会执行)", head: "task/a", base: "main" });
    expect(result.data.args).toContain("--method"); expect(result.data.args).toContain("POST");
    expect(result.data.args).toContain("--hostname"); expect(result.data.args).toContain("--input");
    expect(result.data.args.join(" ")).not.toContain("不会执行");
    expect(JSON.parse(result.data.input).title).toBe("中文 ` $(不会执行)");
    expect(result.headers["x-request-id"]).toBe("test");
  });

  it("保留限流 Retry-After 并脱敏服务错误", async () => {
    const client = fakeGh(`process.stdout.write('HTTP/2.0 429 Too Many Requests\\nRetry-After: 120\\n\\n'+JSON.stringify({message:'Bearer secret-token rate limit'}));process.exitCode=1;`);
    const error = await client.request("github.com", "GET", "/user").catch(error => error);
    expect(error).toBeInstanceOf(GitHubError); expect(error.code).toBe("github_rate_limited");
    expect(error.retryAfterMs).toBe(120_000); expect(error.message).not.toContain("secret-token");
    expect(retryDelay({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" }, 60_000)).toBe(60_000);
  });

  it("写入超时与响应超限都标记结果未知", async () => {
    const timeout = fakeGh("setTimeout(()=>{},10000)", { timeoutMs: 100 });
    await expect(timeout.request("github.com", "POST", "/repos/o/r/pulls", {})).rejects.toMatchObject({ outcomeUnknown: true, code: "github_transport_error" });
    const oversized = fakeGh("process.stdout.write('x'.repeat(8192))", { maxBytes: 128 });
    await expect(oversized.request("github.com", "POST", "/repos/o/r/pulls", {})).rejects.toMatchObject({ outcomeUnknown: true });
  });
});
