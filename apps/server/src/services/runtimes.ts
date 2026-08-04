import { newId, type Db } from "../db/client.js";
import type { Provider, Runtime } from "@anvil/core";
import { failTaskInternal } from "./tasks.js";

export const OFFLINE_AFTER_MS = 60 * 1000;

export function registerRuntimes(
  db: Db, workspaceId: string, daemonId: string,
  list: { provider: string; version: string | null }[],
): Runtime[] {
  const now = new Date().toISOString();
  const out: Runtime[] = [];
  for (const r of list) {
    const existing = db.$client
      .prepare(`SELECT * FROM runtimes WHERE workspace_id = ? AND daemon_id = ? AND provider = ?`)
      .get(workspaceId, daemonId, r.provider) as any;
    if (existing) {
      db.$client
        .prepare(`UPDATE runtimes SET version = ?, status = 'online', last_seen_at = ? WHERE id = ?`)
        .run(r.version, now, existing.id);
      out.push({ ...existing, version: r.version, status: "online", last_seen_at: now });
    } else {
      const id = newId();
      db.$client
        .prepare(`INSERT INTO runtimes (id, workspace_id, daemon_id, provider, version, status, last_seen_at)
                  VALUES (?, ?, ?, ?, ?, 'online', ?)`)
        .run(id, workspaceId, daemonId, r.provider, r.version, now);
      out.push({ id, workspace_id: workspaceId, daemon_id: daemonId, provider: r.provider as Provider, version: r.version, status: "online", last_seen_at: now });
    }
  }
  return out;
}

export function heartbeat(db: Db, workspaceId: string, daemonId: string) {
  db.$client
    .prepare(`UPDATE runtimes SET status = 'online', last_seen_at = ? WHERE workspace_id = ? AND daemon_id = ?`)
    .run(new Date().toISOString(), workspaceId, daemonId);
}

/** 离线清扫：心跳超阈值的 runtime 置 offline；其 dispatched/running 任务按 runtime_offline 失败（走重试链）。 */
export function sweepOfflineRuntimes(db: Db, nowIso: string): number {
  const cutoff = new Date(Date.parse(nowIso) - OFFLINE_AFTER_MS).toISOString();
  const stale = db.$client
    .prepare(`SELECT * FROM runtimes WHERE status = 'online' AND (last_seen_at IS NULL OR last_seen_at < ?)`)
    .all(cutoff) as any[];
  let count = 0;
  for (const rt of stale) {
    db.$client.prepare(`UPDATE runtimes SET status = 'offline' WHERE id = ?`).run(rt.id);
    const tasks = db.$client
      .prepare(`SELECT id FROM tasks WHERE runtime_id = ? AND status IN ('dispatched','running')`)
      .all(rt.id) as any[];
    for (const t of tasks) {
      failTaskInternal(db, t.id, "runtime_offline", `runtime ${rt.id} offline`, null);
    }
    count++;
  }
  return count;
}
