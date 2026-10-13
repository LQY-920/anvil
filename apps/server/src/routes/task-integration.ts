import type { FastifyInstance } from "fastify";
import type { IntegrationActionRequest, SubmitDecisionRequest } from "@anvil/core";
import type { Db } from "../db/client.js";
import type { Hub } from "../ws/hub.js";
import type { createGitHubService } from "../services/github-integration.js";
import { getTask } from "../services/tasks.js";
import { getIssue } from "../services/issues.js";
import { getTaskIntegration, getReviewGate, submitDecision, integrateLocal, requestKey, integrationError, readOperations } from "../services/task-integration.js";

export function registerTaskIntegrationRoutes(app: FastifyInstance, db: Db, hub: Hub, github: ReturnType<typeof createGitHubService>) {
  const refresh = async (id: string) => {
    const task = getTask(db, id);
    if (!task) integrationError("task_not_found", "任务不存在", 404);
    if (task.repository_id) await github.refreshGitFacts(task.repository_id, id);
  };
  const changed = (id: string) => {
    const task = getTask(db, id)!;
    hub.broadcast({ type: "task.updated", data: task });
    hub.broadcast({ type: "issue.updated", data: getIssue(db, task.issue_id) });
  };
  app.get("/api/tasks/:id/integration", async req => {
    const { id } = req.params as { id: string };
    // 刷新失败由仓库连接状态进入 Gate，仍返回可读的旧材料与失败原因。
    try { await refresh(id); } catch { /* getTaskIntegration 检查持久连接状态 */ }
    return getTaskIntegration(db, id);
  });
  app.post("/api/tasks/:id/decisions", async req => {
    const { id } = req.params as { id: string };
    // 同键重放不需要网络；新裁决必须先取得实时远端事实。
    const exists = db.$client.prepare("SELECT id FROM review_decisions WHERE task_id=?").get(id);
    if (!exists) await refresh(id);
    const result = await submitDecision(db, id, req.body as SubmitDecisionRequest, requestKey(req.headers["idempotency-key"]));
    changed(id);
    if (result.next_task_id) hub.hintDaemons({ type: "task.available", data: { task_id: result.next_task_id } });
    return result;
  });
  app.post("/api/tasks/:id/integrate", async req => {
    const { id } = req.params as { id: string };
    const operation = await integrateLocal(db, id, req.body as IntegrationActionRequest, requestKey(req.headers["idempotency-key"]));
    changed(id);
    return operation;
  });
  app.post("/api/tasks/:id/pull-request", async req => {
    const { id } = req.params as { id: string };
    const operation = await github.createPullRequest(id, req.body as IntegrationActionRequest, requestKey(req.headers["idempotency-key"]), () => getReviewGate(db, id));
    changed(id);
    return operation;
  });
  app.post("/api/tasks/:id/operations/:operationId/recover", async req => {
    const { id, operationId } = req.params as { id: string; operationId: string };
    const prior = readOperations(db, id).find(item => item.id === operationId);
    if (!prior) integrationError("operation_not_found", "操作不存在", 404);
    const request = req.body as IntegrationActionRequest, key = requestKey(req.headers["idempotency-key"]);
    const operation = prior.action === "local_merge" ? await integrateLocal(db, id, request, key, operationId)
      : await github.recoverPullRequest(id, operationId, request, key, () => getReviewGate(db, id));
    changed(id);
    return operation;
  });
}
