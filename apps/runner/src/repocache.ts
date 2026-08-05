import fs from "node:fs";
import path from "node:path";
import { repoCachePath } from "@anvil/core";
import { git } from "./worktree.js";

/** 同 URL 的并发调用复用同一 Promise，避免并发 clone/fetch 撞同一缓存目录。key 用缓存路径（天然含 url+root）。 */
const inflight = new Map<string, Promise<string>>();

/** 缓存健康检查：能 rev-parse --git-dir 才是完整仓库（目录/.git 还在但内容损坏 = 残骸）。 */
async function isHealthyCache(cacheDir: string): Promise<boolean> {
  try {
    await git(cacheDir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

async function ensureRepoCacheLocked(url: string, cacheDir: string): Promise<string> {
  if (fs.existsSync(cacheDir)) {
    if (await isHealthyCache(cacheDir)) {
      await git(cacheDir, ["fetch", "--all", "--prune"]);
      try {
        // 快进本地分支到上游，保证新 worktree / server 端 merge 基于最新远程；分叉或无上游时仅告警
        await git(cacheDir, ["merge", "--ff-only", "@{u}"]);
      } catch (e: any) {
        console.warn(`[anvil-repocache] merge --ff-only @{u} failed in ${cacheDir}:`, e?.message ?? e);
      }
      return cacheDir;
    }
    // 残骸/损坏：删掉重新 clone 自愈
    console.warn(`[anvil-repocache] unhealthy cache, re-cloning: ${cacheDir}`);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
  await git(path.dirname(cacheDir), ["clone", url, cacheDir]);
  return cacheDir;
}

/** 确保 URL 仓库的本地缓存存在且最新：不存在 → git clone <url> <cacheDir>；存在 → fetch + 快进到上游。返回缓存路径。 */
export function ensureRepoCache(url: string, runnerRoot: string): Promise<string> {
  const cacheDir = repoCachePath(url, runnerRoot);
  const existing = inflight.get(cacheDir);
  if (existing) return existing;
  const p = ensureRepoCacheLocked(url, cacheDir).finally(() => { inflight.delete(cacheDir); });
  inflight.set(cacheDir, p);
  return p;
}
