import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { sha256Hex } from "./hash.js";

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7);
}

/** daemon token 预校验：通过则给 request 挂上 workspaceId。 */
export function makeDaemonAuth(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!token) return reply.code(401).send({ error: "missing token" });
    const row = db.$client
      .prepare(`SELECT * FROM daemon_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(sha256Hex(token)) as any;
    if (!row) return reply.code(401).send({ error: "invalid token" });
    (req as any).workspaceId = row.workspace_id;
  };
}

/** task token 预校验：哈希匹配且 task id 与路径一致。 */
export function makeTaskAuth(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    const { id } = req.params as { id: string };
    if (!token) return reply.code(401).send({ error: "missing token" });
    const row = db.$client
      .prepare(`SELECT id FROM tasks WHERE id = ? AND task_token_hash = ?`)
      .get(id, sha256Hex(token)) as any;
    if (!row) return reply.code(401).send({ error: "invalid task token" });
  };
}
