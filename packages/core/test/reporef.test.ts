import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import { isRepoUrl, repoCachePath } from "../src/index.js";

describe("isRepoUrl", () => {
  it("recognizes http/https/git@ URLs", () => {
    expect(isRepoUrl("https://github.com/user/repo.git")).toBe(true);
    expect(isRepoUrl("http://git.local/user/repo.git")).toBe(true);
    expect(isRepoUrl("git@github.com:user/repo.git")).toBe(true);
  });

  it("recognizes file:// URLs（测试/本机裸仓库当远程用）", () => {
    expect(isRepoUrl("file:///C:/tmp/bare.git")).toBe(true);
    expect(isRepoUrl("file:///home/u/bare.git")).toBe(true);
  });

  it("rejects local paths", () => {
    expect(isRepoUrl("D:/projects/foo")).toBe(false);
    expect(isRepoUrl("C:\\projects\\foo")).toBe(false);
    expect(isRepoUrl("/home/u/repo")).toBe(false);
    expect(isRepoUrl("./relative")).toBe(false);
    expect(isRepoUrl("")).toBe(false);
  });
});

describe("repoCachePath", () => {
  it("is <anvilRoot>/repos/<sha1(url) 前 12 位>", () => {
    const url = "https://github.com/user/repo.git";
    const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
    expect(repoCachePath(url, "/root/.anvil")).toBe(path.join("/root/.anvil", "repos", hash));
  });

  it("is deterministic and url-sensitive", () => {
    const a = repoCachePath("https://github.com/u/a.git", "/r");
    expect(repoCachePath("https://github.com/u/a.git", "/r")).toBe(a);
    expect(repoCachePath("https://github.com/u/b.git", "/r")).not.toBe(a);
  });
});
