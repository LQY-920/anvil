import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { registerRuntimes, heartbeat, sweepOfflineRuntimes, OFFLINE_AFTER_MS } from "../src/services/runtimes.js";
import { seed } from "../src/db/client.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
});

describe("runtimes", () => {
  it("register upserts by (workspace, daemon, provider)", () => {
    const db = app.db;
    const { workspace } = seed(db);
    const r1 = registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.0" }]);
    const r2 = registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.1" }]);
    expect(r2[0].id).toBe(r1[0].id);
    expect(r2[0].version).toBe("1.1");
    expect(r2[0].status).toBe("online");
  });

  it("heartbeat refreshes last_seen_at", () => {
    const db = app.db;
    const { workspace } = seed(db);
    registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.0" }]);
    db.$client.prepare(`UPDATE runtimes SET last_seen_at = '2000-01-01T00:00:00.000Z'`).run();
    heartbeat(db, workspace.id, "d1");
    const row = db.$client.prepare(`SELECT * FROM runtimes`).get() as any;
    expect(row.last_seen_at > "2000-01-01").toBe(true);
  });

  it("sweep marks stale runtimes offline and fails their tasks", () => {
    const db = app.db;
    const { workspace } = seed(db);
    const [rt] = registerRuntimes(db, workspace.id, "d1", [{ provider: "kimi", version: "1.0" }]);
    const now = new Date().toISOString();
    db.$client.prepare(`INSERT INTO agents (id, workspace_id, name, provider, status, max_concurrent_tasks, created_at)
                        VALUES ('a1', ?, 'bot', 'kimi', 'idle', 1, ?)`).run(workspace.id, now);
    db.$client.prepare(`INSERT INTO issues (id, workspace_id, title, status, priority, creator_type, creator_id, position, created_at, updated_at)
                        VALUES ('i1', ?, 't', 'in_progress', 'medium', 'member', 'u', 1, ?, ?)`).run(workspace.id, now, now);
    db.$client.prepare(`INSERT INTO tasks (id, workspace_id, issue_id, agent_id, runtime_id, status, priority, attempt, max_attempts, created_at, started_at)
                        VALUES ('t1', ?, 'i1', 'a1', ?, 'running', 20, 1, 3, ?, ?)`).run(workspace.id, rt.id, now, now);
    const stale = new Date(Date.now() - OFFLINE_AFTER_MS - 1000).toISOString();
    db.$client.prepare(`UPDATE runtimes SET last_seen_at = ?`).run(stale);

    const swept = sweepOfflineRuntimes(db, new Date().toISOString());
    expect(swept).toBe(1);
    const task = db.$client.prepare(`SELECT * FROM tasks WHERE id='t1'`).get() as any;
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toBe("runtime_offline");
    const runtime = db.$client.prepare(`SELECT * FROM runtimes WHERE id=?`).get(rt.id) as any;
    expect(runtime.status).toBe("offline");
  });
});
