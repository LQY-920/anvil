import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { seed, newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { sha256Hex } from "../lib/hash.js";
import { parseRecentRepos } from "../services/issues.js";
import { createProfile, getProfile, listProfiles, probeProfile, updateProfile, validateProfileBody } from "../services/profiles.js";
import crypto from "node:crypto";

export function registerMetaRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/bootstrap", async () => {
    const s = seed(db);
    // 最近使用的仓库引用，供 web 创建模态框快捷选择
    return { ...s, recent_repos: parseRecentRepos(s.workspace.settings_json) };
  });

  app.get("/api/agents", async () => {
    return db.select().from(schema.agents).all();
  });

  app.post("/api/agents", async (req, reply) => {
    const { workspace } = seed(db);
    const body = req.body as { name: string; provider: string; max_concurrent_tasks?: number; profile_id?: string };
    if (!body.name || !body.provider) return reply.code(400).send({ error: "name/provider required" });
    if (body.provider !== "kimi" && body.provider !== "codex") return reply.code(400).send({ error: "provider 只允许 kimi 或 codex" });
    let profileId = body.profile_id ?? null;
    if (profileId) {
      const profile = getProfile(db, profileId);
      if (!profile || profile.provider !== body.provider) return reply.code(409).send({ error: "profile 与 provider 不一致" });
    } else if (body.provider === "codex") {
      profileId = createProfile(db, workspace.id, { executable: "codex" }).id;
    }
    const id = newId();
    db.insert(schema.agents).values({
      id, workspace_id: workspace.id, name: body.name, provider: body.provider,
      status: "idle", max_concurrent_tasks: body.max_concurrent_tasks ?? 1,
      profile_id: profileId,
      created_at: new Date().toISOString(),
    }).run();
    return reply.code(201).send(db.select().from(schema.agents).where(eq(schema.agents.id, id)).all()[0]);
  });

  app.get("/api/agent-profiles", async () => listProfiles(db));

  app.post("/api/agent-profiles", async (req, reply) => {
    const { workspace } = seed(db);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const problem = validateProfileBody(body);
    if (problem) return reply.code(400).send({ error: problem });
    const row = createProfile(db, workspace.id, {
      executable: String(body.executable),
      sandbox: body.sandbox as "read-only" | "workspace-write" | undefined,
      model: body.model as string | null | undefined,
    });
    return reply.code(201).send(row);
  });

  app.patch("/api/agent-profiles/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const problem = validateProfileBody(body, true);
    if (problem) return reply.code(400).send({ error: problem });
    const row = updateProfile(db, id, {
      executable: typeof body.executable === "string" ? body.executable : undefined,
      sandbox: body.sandbox as "read-only" | "workspace-write" | undefined,
      model: body.model as string | null | undefined,
    });
    if (!row) return reply.code(404).send({ error: "not found" });
    return row;
  });

  app.post("/api/agent-profiles/:id/probe", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await probeProfile(db, id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return {
      id: row.id,
      provider: row.provider,
      auth_state: row.auth_state,
      cli_version: row.cli_version,
      config_version: row.config_version,
    };
  });

  app.get("/api/runtimes", async () => {
    return db.select().from(schema.runtimes).all();
  });

  // 自用 v1：web 端创建 daemon token，明文仅本响应返回一次，库中只存哈希
  app.post("/api/daemon-tokens", async (req, reply) => {
    const { workspace } = seed(db);
    const { label } = (req.body ?? {}) as { label?: string };
    const token = `anv_${crypto.randomBytes(24).toString("hex")}`;
    const id = newId();
    db.insert(schema.daemonTokens).values({
      id, workspace_id: workspace.id, token_hash: sha256Hex(token),
      label: label ?? "default", created_at: new Date().toISOString(),
    }).run();
    return reply.code(201).send({ id, token });
  });

  // token 列表：不回 token_hash
  app.get("/api/daemon-tokens", async () => {
    return db.select({
      id: schema.daemonTokens.id,
      label: schema.daemonTokens.label,
      revoked_at: schema.daemonTokens.revoked_at,
      created_at: schema.daemonTokens.created_at,
    }).from(schema.daemonTokens).all();
  });

  app.post("/api/daemon-tokens/:id/revoke", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.select().from(schema.daemonTokens).where(eq(schema.daemonTokens.id, id)).all()[0];
    if (!row) return reply.code(404).send({ error: "not found" });
    if (row.revoked_at) return reply.code(409).send({ error: "already revoked" });
    db.update(schema.daemonTokens)
      .set({ revoked_at: new Date().toISOString() })
      .where(eq(schema.daemonTokens.id, id))
      .run();
    return { ok: true };
  });
}
