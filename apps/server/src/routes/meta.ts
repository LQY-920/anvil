import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { seed, newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { sha256Hex } from "../lib/hash.js";
import { parseRecentRepos } from "../services/issues.js";
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
    const body = req.body as { name: string; provider: string; max_concurrent_tasks?: number };
    if (!body.name || !body.provider) return reply.code(400).send({ error: "name/provider required" });
    const id = newId();
    db.insert(schema.agents).values({
      id, workspace_id: workspace.id, name: body.name, provider: body.provider,
      status: "idle", max_concurrent_tasks: body.max_concurrent_tasks ?? 1,
      created_at: new Date().toISOString(),
    }).run();
    return reply.code(201).send(db.select().from(schema.agents).where(eq(schema.agents.id, id)).all()[0]);
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
