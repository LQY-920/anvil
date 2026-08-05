import type { ClaimResponse, TaskPackage } from "@anvil/core";

export class ApiClient {
  constructor(private baseUrl: string, private daemonToken: string) {}

  private async req(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token ?? this.daemonToken}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${method} ${path} → ${res.status} ${text}`) as any;
      err.status = res.status;
      try { err.body = JSON.parse(text); } catch { /* ignore */ }
      throw err;
    }
    return res.json();
  }

  register(daemonId: string, runtimes: { provider: string; version: string | null }[]) {
    return this.req("POST", "/api/daemon/register", { daemon_id: daemonId, runtimes });
  }
  heartbeat(daemonId: string) {
    return this.req("POST", "/api/daemon/heartbeat", { daemon_id: daemonId });
  }
  claim(daemonId: string, maxTasks = 1): Promise<ClaimResponse> {
    return this.req("POST", "/api/daemon/claim", { daemon_id: daemonId, max_tasks: maxTasks });
  }
  startTask(taskId: string, token: string, workDir: string) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/start`, { work_dir: workDir }, token);
  }
  appendMessages(taskId: string, token: string, messages: unknown[]) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/messages`, { messages }, token);
  }
  complete(taskId: string, token: string, result: Record<string, unknown>) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/complete`, result, token);
  }
  fail(taskId: string, token: string, reason: string, error: string, workDir?: string) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/fail`, { failure_reason: reason, error, work_dir: workDir }, token);
  }
  async taskDelivered(taskId: string, token: string): Promise<boolean> {
    try {
      const r = await this.req("GET", `/api/daemon/tasks/${taskId}/delivery`, undefined, token);
      return r.delivered === true;
    } catch (e: any) {
      if (e.status === 401 || e.status === 404) return false; // token 失效/任务消失 → 视为未交付
      throw e;
    }
  }
  async taskStatus(taskId: string, token: string): Promise<string | null> {
    try {
      const r = await this.req("GET", `/api/daemon/tasks/${taskId}/status`, undefined, token);
      return r.status;
    } catch (e: any) {
      if (e.status === 401 || e.status === 404) return null; // token 失效/任务消失 → 视为终态
      throw e;
    }
  }
}

export type { TaskPackage };
