import fs from "node:fs";
import path from "node:path";
import { repoCachePath } from "@anvil/core";
import { git } from "./worktree.js";

/** 确保 URL 仓库的本地缓存存在且最新：不存在 → git clone <url> <cacheDir>；存在 → git fetch --all --prune。返回缓存路径。 */
export async function ensureRepoCache(url: string, runnerRoot: string): Promise<string> {
  const cacheDir = repoCachePath(url, runnerRoot);
  if (fs.existsSync(path.join(cacheDir, ".git"))) {
    await git(cacheDir, ["fetch", "--all", "--prune"]);
    return cacheDir;
  }
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  await git(path.dirname(cacheDir), ["clone", url, cacheDir]);
  return cacheDir;
}
