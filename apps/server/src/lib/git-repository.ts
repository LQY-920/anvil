import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { git } from "./git.js";

/** 文件标识以十进制字符串保存，避免 Windows 的 64 位 inode 丢失精度。 */
export interface GitRepositoryIdentity { real_path: string; dev: string; ino: string; }

export function canonicalRepositoryPath(value: string, windows = process.platform === "win32"): string {
  if (!windows) return value.replace(/\\/g, "/");
  let result = value.replace(/\//g, "\\");
  if (result.startsWith("\\\\?\\UNC\\")) result = `\\\\${result.slice(8)}`;
  else if (result.startsWith("\\\\?\\")) result = result.slice(4);
  return result.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

export async function readGitRepositoryIdentity(repo: string): Promise<GitRepositoryIdentity> {
  const common = (await git(repo, ["rev-parse", "--git-common-dir"])).trim();
  const realPath = fs.realpathSync(path.resolve(repo, common));
  const stat = fs.statSync(realPath, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Git common-dir 不是目录");
  return { real_path: canonicalRepositoryPath(realPath), dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function strong(identity: GitRepositoryIdentity): boolean { return identity.dev !== "0" && identity.ino !== "0"; }
export function sameGitRepository(left: GitRepositoryIdentity, right: GitRepositoryIdentity): boolean {
  if (strong(left) && strong(right)) return left.dev === right.dev && left.ino === right.ino;
  // 弱身份退化仍保留路径大小写，不能把 Windows 区分大小写的目录混为一谈。
  return canonicalRepositoryPath(left.real_path) === canonicalRepositoryPath(right.real_path);
}
export function gitRepositoryKey(identity: GitRepositoryIdentity): string {
  const value = strong(identity) ? `${identity.dev}:${identity.ino}` : identity.real_path;
  return createHash("sha256").update(value).digest("hex");
}
