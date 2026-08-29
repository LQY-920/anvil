import type { ClaimResponse, TaskPackage } from "@anvil/core";

/** A03 · daemon plane:start / complete / fail 使用构造时保存的 daemon token,body 显式带 daemon_id;
 *  Agent plane:messages / status / delivery 继续使用 task token。 */
export class ApiClient {
  constructor(private baseUrl: string, private daemonToken: string) {}

  /** 通用请求:token 缺省用构造时的 daemon token;Agent plane 路径显式传 task token。 */
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

  /**
   * A03 · 对 transport error 与 5xx 做有限重试(总尝试 3 次,首次 + 最多 2 次重试);
   * 4xx 立即抛出。每次重试复用同一个已序列化 payload,严禁在重试时重新生成时间戳、随机 ID、
   * 证据字段或 JSON 字符串。错误日志不得打印 token 或 Authorization。
   */
  private async opWithRetry(method: string, path: string, body: unknown, maxAttempts = 3) {
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.daemonToken}` },
          body: serialized,
        });
      } catch (e: any) {
        // transport error:重试(下一轮仍用同一 payload)
        lastErr = e;
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      if (res.ok) return res.json();
      if (res.status >= 400 && res.status < 500) {
        // 4xx:不重试,立即抛结构化错误
        const text = await res.text().catch(() => "");
        const err = new Error(`${method} ${path} → ${res.status} ${text}`) as any;
        err.status = res.status;
        try { err.body = JSON.parse(text); } catch { /* ignore */ }
        throw err;
      }
      // 5xx:重试
      lastErr = new Error(`${method} ${path} → ${res.status}`);
      lastErr.status = res.status;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 50 * attempt));
    }
    throw lastErr ?? new Error(`${method} ${path} failed after ${maxAttempts} attempts`);
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

  /** A03 · daemon plane start:用 daemon token,body 显式带 daemon_id。 */
  startTask(taskId: string, daemonId: string, workDir: string) {
    return this.opWithRetry("POST", `/api/daemon/tasks/${taskId}/start`, { daemon_id: daemonId, work_dir: workDir });
  }

  /** A03-FIX · daemon plane complete。daemonId 由方法参数最终写入,result.daemon_id 即使存在
   *  也会被展开顺序中的 daemonId 覆盖;不得让 result 偷偷传 daemonId 改写请求。 */
  complete(taskId: string, daemonId: string, result: Record<string, unknown>) {
    const { daemon_id: _ignored, ...rest } = result as { daemon_id?: string } & Record<string, unknown>;
    return this.opWithRetry("POST", `/api/daemon/tasks/${taskId}/complete`, { daemon_id: daemonId, ...rest });
  }

  /** A03 · daemon plane fail。 */
  fail(taskId: string, daemonId: string, reason: string, error: string, workDir?: string) {
    return this.opWithRetry("POST", `/api/daemon/tasks/${taskId}/fail`, { daemon_id: daemonId, failure_reason: reason, error, work_dir: workDir });
  }

  // Agent plane:继续使用 task token。
  appendMessages(taskId: string, token: string, messages: unknown[]) {
    return this.req("POST", `/api/daemon/tasks/${taskId}/messages`, { messages }, token);
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
