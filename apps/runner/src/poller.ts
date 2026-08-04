import WebSocket from "ws";
import type { ApiClient } from "./client.js";
import type { TaskPackage } from "@anvil/core";
import { killAllActiveSessions } from "./executor.js";

export interface DaemonOptions {
  daemonId: string;
  providers: { provider: string; version: string | null }[];
  pollMs: number;          // 正常轮询间隔（生产 10s，测试 50ms）
  heartbeatMs: number;     // 心跳间隔（生产 15s）
  executor: (pkg: TaskPackage) => Promise<void>;
}

/** 主循环纪律（spec §8）：任何单任务/单轮异常都不能让 daemon 退出。 */
export class Daemon {
  private stopped = false;
  private executing = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private ws: WebSocket | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;

  constructor(private client: ApiClient, private opts: DaemonOptions) {}

  async start() {
    await this.withGuard(() => this.client.register(this.opts.daemonId, this.opts.providers));
    const hb = setInterval(() => this.withGuard(() => this.client.heartbeat(this.opts.daemonId)), this.opts.heartbeatMs);
    const poll = setInterval(() => this.withGuard(() => this.pollOnce()), this.opts.pollMs);
    this.timers.push(hb, poll);
    this.connectHints();
    await this.withGuard(() => this.pollOnce()); // 启动立即来一轮
  }

  isAlive() { return !this.stopped; }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
    this.ws?.close();
    killAllActiveSessions(); // 杀掉在途 Agent 进程，避免孤儿
  }

  private connectHints() {
    if (this.stopped) return;
    const base = (this.client as any).baseUrl as string | undefined;
    if (!base) return; // hint 非必需，轮询兜底
    try {
      const wsUrl = base.replace(/^http/, "ws") + "/api/daemon/ws";
      this.ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${(this.client as any).daemonToken}` } });
      this.ws.on("message", () => this.withGuard(() => this.pollOnce()));
      this.ws.on("close", () => { if (!this.stopped) this.wsReconnectTimer = setTimeout(() => this.connectHints(), 5000); });
      this.ws.on("error", () => { /* hint 丢失无害，轮询兜底 */ });
    } catch { /* ignore */ }
  }

  private async pollOnce() {
    if (this.stopped) return;
    const { tasks } = await this.client.claim(this.opts.daemonId, 4);
    for (const pkg of tasks) {
      if (this.executing.has(pkg.task.id)) continue;
      this.executing.add(pkg.task.id);
      this.opts.executor(pkg)
        .catch((e) => { console.error("[anvil-daemon] executor crashed:", (e as Error)?.message ?? e); }) // executor 内部已上报 fail；这里兜底不传播
        .finally(() => this.executing.delete(pkg.task.id));
    }
  }

  private async withGuard(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { console.error("[anvil-daemon]", (e as Error).message); }
  }
}
