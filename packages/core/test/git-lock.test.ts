import { afterEach, describe, expect, it } from "vitest";
import { withGitLock } from "../src/git-lock.js";
import { parseRepositorySnapshot } from "../src/integration.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const directories: string[] = [];
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-lock-test-")); directories.push(dir); return dir; }
afterEach(async () => { for (const dir of directories.splice(0)) {
  if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("anvil-lock-test-")) throw new Error("清理路径不符");
  await fs.rm(dir, { recursive: true, force: true });
} });
describe("跨进程 Git 锁", () => {
  it("两个调用串行进入临界区，异常后释放", async () => {
    const dir = await directory(), events: string[] = [];
    const first = withGitLock(dir, async () => { events.push("一进入"); await new Promise(resolve => setTimeout(resolve, 100)); events.push("一退出"); throw new Error("模拟失败"); });
    const second = withGitLock(dir, async () => { events.push("二进入"); });
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0].status).toBe("rejected");
    expect(settled[1].status).toBe("fulfilled");
    expect(events).toEqual(["一进入", "一退出", "二进入"]);
    await expect(withGitLock(dir, async () => 3)).resolves.toBe(3);
  });
  it("真实子进程持锁时不能抢占，进程退出后可恢复", async () => {
    const dir = await directory();
    const module = pathToFileURL(path.resolve("src/git-lock.ts")).href;
    const script = `import {withGitLock} from ${JSON.stringify(module)}; await withGitLock(process.argv[1],async()=>{process.stdout.write('locked\\n');setInterval(()=>{},1000);await new Promise(()=>{});});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let errors = ""; child.stderr.on("data", data => { errors += data; });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("exit", () => reject(new Error(errors))); child.once("error", reject); });
      await expect(withGitLock(dir, async () => 1, { timeoutMs: 60 })).rejects.toMatchObject({ code: "repository_busy" });
    } finally { child.kill(); await exited; }
    await expect(withGitLock(dir, async () => "已恢复", { timeoutMs: 1000 })).resolves.toBe("已恢复");
  }, 10_000);
  it("没有可证明所有者的锁保留现场", async () => {
    const dir = await directory();
    await fs.mkdir(path.join(dir, "anvil-operation.lock"));
    await expect(withGitLock(dir, async () => 1, { timeoutMs: 50 })).rejects.toMatchObject({ code: "repository_busy" });
    expect((await fs.stat(path.join(dir, "anvil-operation.lock"))).isDirectory()).toBe(true);
  });
});
it("快照明确区分历史空值、坏 JSON 和精度已丢失的身份", () => {
  expect(parseRepositorySnapshot(null)).toBeNull();
  expect(() => parseRepositorySnapshot("{" )).toThrow();
  const snapshot = { schema_version: 1, repository_id: "r", mode: "local_git", host: "local", external_id: "1", full_name: "repo", clone_url: "repo", target_branch: "main", checkout_path: "repo", identity: { real_path: "repo/.git", dev: "1", ino: "9007199254740993" }, source_snapshot_id: null, input: { title: "任务", description: null, acceptance: null } };
  expect(parseRepositorySnapshot(JSON.stringify(snapshot))?.identity.ino).toBe("9007199254740993");
  expect(() => parseRepositorySnapshot(JSON.stringify({ ...snapshot, identity: { ...snapshot.identity, ino: 9007199254740993 } }))).toThrow();
});
