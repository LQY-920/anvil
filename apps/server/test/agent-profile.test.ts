import { describe, expect, it, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
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
