import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

interface Owner { pid: number; host: string; nonce: string; created_at: number; }
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error.code !== "ESRCH"; }
}
async function ownerAt(directory: string): Promise<Owner | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8"));
    return Number.isSafeInteger(raw.pid) && raw.pid > 0 && typeof raw.nonce === "string" && typeof raw.host === "string" ? raw : null;
  } catch { return null; }
}

/** Server 与 Runner 共用的进程锁；只覆盖 Git 临界操作，不跨 Agent 执行或人工等待。
 * 活进程的锁不按时间偷取；进程已消失才恢复。PID 复用或跨主机无法确认时保守阻塞。 */
export async function withGitLock<T>(commonDir: string, action: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
  const root = await fs.realpath(commonDir);
  const directory = path.join(root, "anvil-operation.lock");
  const reclaim = path.join(root, "anvil-operation-recovery.lock");
  const owner: Owner = { pid: process.pid, host: os.hostname(), nonce: randomUUID(), created_at: Date.now() };
  const timeout = options.timeoutMs ?? 10_000;
  let acquired = false;
  const end = Date.now() + timeout;
  while (!acquired) {
    let recovering = false;
    try { await fs.stat(reclaim); recovering = true; } catch { /* 无恢复互斥 */ }
    if (!recovering) {
      try {
        await fs.mkdir(directory);
        try {
          await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify(owner), { flag: "wx" });
          acquired = (await ownerAt(directory))?.nonce === owner.nonce;
        } catch (error) {
          // 尚未拿到所有权时不能删除别人的锁。
          if ((await ownerAt(directory))?.nonce === owner.nonce) await fs.rm(directory, { recursive: true, force: true });
          throw error;
        }
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        const previous = await ownerAt(directory);
        if (previous && previous.host === owner.host && !alive(previous.pid)) {
          // 恢复动作也互斥；进入后重读 nonce，避免两个等待者删除刚建立的新锁。
          let reclaiming = false;
          try {
            await fs.mkdir(reclaim); reclaiming = true;
            const current = await ownerAt(directory);
            if (current?.nonce === previous.nonce && !alive(current.pid)) {
              await fs.rm(directory, { recursive: true, force: true });
            }
          } catch (recoveryError: any) {
            if (recoveryError.code !== "EEXIST" && recoveryError.code !== "ENOENT") throw recoveryError;
          } finally { if (reclaiming) await fs.rmdir(reclaim).catch(() => {}); }
        }
      }
    }
    if (!acquired) {
      if (Date.now() >= end) throw Object.assign(new Error("仓库正被其他 Git 操作占用，请稍后重试；未知锁须先核对现场"), { http: 409, code: "repository_busy", retryable: true });
      await pause(50);
    }
  }
  try { return await action(); }
  finally {
    if ((await ownerAt(directory))?.nonce === owner.nonce) await fs.rm(directory, { recursive: true, force: true });
  }
}
