import { describe, expect, it } from "vitest";
import { canonicalRepositoryPath, gitRepositoryKey, sameGitRepository } from "../src/lib/git-repository.js";

describe("Git common-dir 身份", () => {
  it("超出 JavaScript 安全整数范围的相邻文件标识不能混同", () => {
    const left = { real_path: "D:\\仓库\\.git", dev: "123", ino: "9007199254740992" };
    const right = { ...left, ino: "9007199254740993" };
    expect(sameGitRepository(left, right)).toBe(false);
    expect(gitRepositoryKey(left)).not.toBe(gitRepositoryKey(right));
    expect(sameGitRepository(left, { ...left, real_path: "D:\\别名\\.git" })).toBe(true);
  });
  it("弱文件标识退化到真实路径时保留目录大小写", () => {
    const left = { real_path: "D:\\Repo\\.git", dev: "0", ino: "0" };
    expect(sameGitRepository(left, { ...left, real_path: "D:\\repo\\.git" })).toBe(false);
    expect(sameGitRepository(left, { ...left, dev: "123", ino: "456" })).toBe(true);
  });
  it("Windows 长路径及 UNC 别名规范化，但不折叠区分大小写的目录", () => {
    expect(canonicalRepositoryPath("\\\\?\\d:\\Repo\\.git", true)).toBe("D:\\Repo\\.git");
    expect(canonicalRepositoryPath("\\\\?\\UNC\\server\\Repo\\.git", true)).toBe("\\\\server\\Repo\\.git");
    expect(canonicalRepositoryPath("d:/Repo/.git", true)).toBe("D:\\Repo\\.git");
  });
});
