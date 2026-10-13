import type { FastifyInstance, FastifyReply } from "fastify";
import type { BindRepositoryRequest } from "@anvil/core";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import { GitHubError } from "../lib/github.js";
import { integrationDiagnostic } from "../services/integration-attempts.js";
import type { GitHubService } from "../services/github-integration.js";

function failure(reply: FastifyReply, error: unknown) {
  const value = error as { http?: number; code?: string; message?: string; retryable?: boolean };
  if (error instanceof GitHubError && error.retryAfterMs > 0) reply.header("retry-after", Math.ceil(error.retryAfterMs / 1000));
  return reply.code(value.http ?? 500).send({ error: integrationDiagnostic(value.message ?? "仓库操作失败"),
    code: value.code ?? "repository_error", retryable: value.retryable ?? false });
}

export function registerRepositoryRoutes(app: FastifyInstance, _db: Db, _hub: Hub, service: GitHubService) {
  app.get("/api/repositories", async () => service.listRepositories());
  app.post("/api/repositories", async (request, reply) => {
    try { return reply.code(201).send(await service.bindRepository(request.body as BindRepositoryRequest)); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/api/repositories/:id/import-issue", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return await service.importIssue(id, request.body as { issue_number: number; source_updated_at?: string }); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/api/repositories/:id/sync", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return await service.refreshRepository(id); }
    catch (error) { return failure(reply, error); }
  });
  app.get("/api/issues/:id/source", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.getIssueSource(id); }
    catch (error) { return failure(reply, error); }
  });
  app.post("/api/issues/:id/accept-source", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.acceptSource(id, (request.body as { snapshot_id?: string } | undefined)?.snapshot_id as string); }
    catch (error) { return failure(reply, error); }
  });
}
