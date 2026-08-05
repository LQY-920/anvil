import crypto from "node:crypto";
import path from "node:path";

/**
 * 判定仓库引用是否为 URL（http/https/git@/file 开头）。
 * file:// 用于本机裸仓库当"远程"（测试与单机场景）；git clone/push 原生支持。
 */
export function isRepoUrl(ref: string): boolean {
  return /^(https?|file):\/\//.test(ref) || ref.startsWith("git@");
}

/** URL 引用的本地缓存路径：<anvilRoot>/repos/<sha1(url) 前 12 位>。anvilRoot 由调用方传入（默认 ~/.anvil）。 */
export function repoCachePath(ref: string, anvilRoot: string): string {
  const hash = crypto.createHash("sha1").update(ref).digest("hex").slice(0, 12);
  return path.join(anvilRoot, "repos", hash);
}
