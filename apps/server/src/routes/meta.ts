import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { seed, newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { sha256Hex } from "../lib/hash.js";
import crypto from "node:crypto";

export function registerMetaRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/bootstrap", async () => seed(db));

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
}
