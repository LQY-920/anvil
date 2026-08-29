import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { sha256Hex } from "./hash.js";

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7);
}

/** A03 · daemon token 预校验:失败返回结构化 { code, message };通过则给 request 挂上 workspaceId。
 *  401 与公开的 AnvilErrorCode 不在同一语义层(401 是认证层,公开码是 API 业务层),这里
 *  用本地 code="invalid_token" 保持稳定可读。日志与响应不打印 token。 */
export function makeDaemonAuth(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!token) return reply.code(401).send({ code: "invalid_token", message: "缺少 Authorization Bearer token" });
    const row = db.$client
      .prepare(`SELECT * FROM daemon_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(sha256Hex(token)) as any;
    if (!row) return reply.code(401).send({ code: "invalid_token", message: "daemon token 无效或已吊销" });
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
