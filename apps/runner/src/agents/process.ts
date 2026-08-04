import { spawn, exec } from "node:child_process";
import path from "node:path";
import type { AgentMessage } from "@anvil/core";
import type { AgentResult } from "./backend.js";

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  parseLine: (line: string) => AgentMessage | null;
  idleTimeoutMs: number; // 0 = 不设 watchdog
}

export interface RunningProcess {
  messages: AsyncIterable<AgentMessage>;
  result: Promise<AgentResult>;
  kill: () => void;
}

/** 杀整个进程组/进程树（spec §6：防止孤儿化 CLI 拉起的子进程）。 */
export function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    // 用 SystemRoot 解析绝对路径：某些机器 PATH 缺 C:\Windows\System32，裸 taskkill 会找不到
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    exec(`"${taskkill}" /PID ${pid} /T /F`, { windowsHide: true }, () => {});
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  }
}

export function runCliProcess(opts: RunProcessOptions): RunningProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  // 消息队列：生产-消费桥接为 AsyncIterable
  const queue: AgentMessage[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  const push = (m: AgentMessage | null) => {
    if (!m) return;
    queue.push(m);
    notify?.();
  };

  let watchdog: NodeJS.Timeout | null = null;
  let killedByWatchdog = false;
  let killedManually = false;
  const armWatchdog = () => {
    if (!opts.idleTimeoutMs) return;
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      killedByWatchdog = true;
      if (child.pid) killProcessTree(child.pid);
    }, opts.idleTimeoutMs);
  };
  armWatchdog();

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      push(opts.parseLine(line));
      armWatchdog(); // 有消息即重置 watchdog
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) push({ type: "log", content: `[stderr] ${line}` });
    armWatchdog(); // stderr 有输出也说明进程活着
  });

  const result = new Promise<AgentResult>((resolve) => {
    child.on("error", (err) => {
      finish();
      resolve({ status: "failed", error: `spawn_failed: ${err.message}` });
    });
    child.on("close", (code) => {
      if (buf.trim()) push(opts.parseLine(buf));
      finish();
      if (killedByWatchdog) return resolve({ status: "timeout", error: "idle watchdog" });
      if (killedManually) return resolve({ status: "cancelled" });
      resolve(code === 0 ? { status: "completed", exitCode: 0 } : { status: "failed", exitCode: code ?? -1, error: `exit ${code}` });
    });
    function finish() {
      if (watchdog) clearTimeout(watchdog);
      done = true;
      notify?.();
    }
  });

  const messages: AsyncIterable<AgentMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentMessage>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined as any, done: true });
          return new Promise((resolve) => {
            notify = () => {
              notify = null;
              if (queue.length > 0) resolve({ value: queue.shift()!, done: false });
              else resolve({ value: undefined as any, done: true });
            };
          });
        },
      };
    },
  };

  return {
    messages,
    result,
    kill: () => {
      killedManually = true;
      if (child.pid) killProcessTree(child.pid);
    },
  };
}
