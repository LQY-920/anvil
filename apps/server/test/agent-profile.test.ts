import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { decideSessionResume } from "../src/services/profiles.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
});

describe("session resume decision", () => {
  it("blocks a new worktree, a missing directory, and a different runtime", () => {
    expect(decideSessionResume({
      hasPrior: false, sameProvider: true, sameProfile: true, sameRuntime: true, sameRepo: true, workdirReused: false, workdirExists: false,
    }).action).toBe("fresh");
    expect(decideSessionResume({
      hasPrior: true, sameProvider: true, sameProfile: true, sameRuntime: true, sameRepo: true, workdirReused: false, workdirExists: true,
    }).reason).toContain("新工作树");
    expect(decideSessionResume({
      hasPrior: true, sameProvider: false, sameProfile: true, sameRuntime: true, sameRepo: true, workdirReused: true, workdirExists: true,
    }).reason).toContain("不一致");
    expect(decideSessionResume({
      hasPrior: true, sameProvider: true, sameProfile: true, sameRuntime: true, sameRepo: true, workdirReused: true, workdirExists: false,
    }).reason).toContain("丢失");
  });
});

describe("codex profile", () => {
  it("keeps the queued snapshot when the profile is edited and rejects reserved flags", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/agent-profiles",
      payload: { provider: "codex", executable: "codex", sandbox: "workspace-write" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().auth_state).toBe("auth_not_checked");
    const profileId = created.json().id;

    const reserved = await app.inject({
      method: "POST", url: "/api/agent-profiles",
      payload: { provider: "codex", executable: "codex", "--last": true },
    });
    expect(reserved.statusCode).toBe(400);

    const agent = await app.inject({
      method: "POST", url: "/api/agents",
      payload: { name: "codex", provider: "codex", profile_id: profileId },
    });
    const issue = await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "work", assignee_type: "agent", assignee_id: agent.json().id },
    });
    const before = app.db.prepare(`SELECT execution_snapshot_json, profile_config_version FROM tasks WHERE issue_id = ?`).get(issue.json().id) as any;
    expect(JSON.parse(before.execution_snapshot_json).sandbox).toBe("workspace-write");

    const patched = await app.inject({
      method: "PATCH", url: `/api/agent-profiles/${profileId}`,
      payload: { sandbox: "read-only" },
    });
    expect(patched.json().config_version).toBe(2);
    const after = app.db.prepare(`SELECT execution_snapshot_json FROM tasks WHERE issue_id = ?`).get(issue.json().id) as any;
    expect(JSON.parse(after.execution_snapshot_json).sandbox).toBe("workspace-write");
  });

  it("does not claim a codex task from a runtime without matching capabilities", async () => {
    const token = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: { label: "t" } })).json().token;
    const agent = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "codex", provider: "codex" } });
    app.db.prepare(`UPDATE agent_profiles SET capabilities_json = ?`).run(JSON.stringify({
      stream: true, resume: true, cancel: true, structured_report: true,
    }));
    await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "work", assignee_type: "agent", assignee_id: agent.json().id },
    });
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: "POST", url: "/api/daemon/register", headers: auth,
      payload: { daemon_id: "d1", runtimes: [{ provider: "codex", version: "0.147.0" }] },
    });
    const denied = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth, payload: { daemon_id: "d1" } });
    expect(denied.json().tasks).toHaveLength(0);

    await app.inject({
      method: "POST", url: "/api/daemon/register", headers: auth,
      payload: {
        daemon_id: "d1",
        runtimes: [{ provider: "codex", version: "0.147.0", capabilities: { stream: true, resume: true, cancel: true, structured_report: true } }],
      },
    });
    const claimed = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth, payload: { daemon_id: "d1" } });
    expect(claimed.json().tasks).toHaveLength(1);
    expect(claimed.json().tasks[0].prior_session_ref).toBeNull();
    expect(claimed.json().tasks[0].session_action).toBe("fresh");
  });

  it("resumes only the same profile, runtime, repo and existing worktree", async () => {
    const token = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: { label: "t" } })).json().token;
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: "POST", url: "/api/daemon/register", headers: auth,
      payload: { daemon_id: "d1", runtimes: [{ provider: "codex", version: "0.147.0", capabilities: { stream: true, resume: true, cancel: true, structured_report: true } }] },
    });
    const runtime = app.db.prepare(`SELECT id FROM runtimes WHERE provider = 'codex'`).get() as { id: string };
    const agent = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "codex", provider: "codex" } });
    const profileId = agent.json().profile_id as string;
    app.db.prepare(`UPDATE agent_profiles SET capabilities_json = ? WHERE id = ?`).run(JSON.stringify({
      stream: true, resume: true, cancel: true, structured_report: true,
    }), profileId);
    const issue = await app.inject({
      method: "POST", url: "/api/issues",
      payload: { title: "continue", assignee_type: "agent", assignee_id: agent.json().id },
    });
    const first = app.db.prepare(`SELECT id FROM tasks WHERE issue_id = ?`).get(issue.json().id) as { id: string };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-session-"));
    app.db.prepare(`UPDATE tasks SET status = 'completed', work_dir = ?, session_id = ? WHERE id = ?`).run(dir, "thread-real", first.id);
    app.db.prepare(`INSERT INTO provider_sessions
      (id, session_ref, provider, runtime_id, task_id, profile_id, work_dir, repo_path, created_at)
      VALUES ('ps1', 'thread-real', 'codex', ?, ?, ?, ?, NULL, ?)`).run(runtime.id, first.id, profileId, dir, new Date().toISOString());
    await app.inject({ method: "POST", url: `/api/issues/${issue.json().id}/comments`, payload: { body: "继续" } });
    const resumed = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth, payload: { daemon_id: "d1" } });
    expect(resumed.json().tasks[0].session_action).toBe("resume");
    expect(resumed.json().tasks[0].prior_session_ref).toBe("thread-real");

    fs.rmSync(dir, { recursive: true, force: true });
    app.db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(resumed.json().tasks[0].task.id);
    await app.inject({ method: "POST", url: `/api/issues/${issue.json().id}/comments`, payload: { body: "再继续" } });
    const blocked = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: auth, payload: { daemon_id: "d1" } });
    expect(blocked.json().tasks[0].session_action).toBe("blocked");
    expect(blocked.json().tasks[0].session_block_reason).toContain("丢失");
  });

  it("records a missing executable without calling it logged in", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/agent-profiles",
      payload: { provider: "codex", executable: "anvil-missing-codex-binary" },
    });
    const probed = await app.inject({ method: "POST", url: `/api/agent-profiles/${created.json().id}/probe` });
    expect(probed.statusCode).toBe(200);
    expect(probed.json().auth_state).toBe("missing");
    expect(probed.json().cli_version).toBeNull();
  });
});
