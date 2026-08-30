import type { ClaimResponse, DeliveryQueryResponse, TaskPackage } from "@anvil/core";

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

  /**
   * A04-FIX1 · daemon plane start:用 daemon token + body.daemon_id,all-or-none 锚点校验。
   *
   * 合法模式(仅两种,fetch 才会发出):
   *  1. 三个锚点全部 null/未提供:发送兼容请求 `{ daemon_id, work_dir }`。
   *  2. 三个锚点全部存在且合法:
   *     - taskBranch / targetBranch 必须是非空字符串(已 trim);
   *     - baseCommit 必须是完整 40 位 hex SHA-1。
   *     发送精确 v2 请求 `{ daemon_id, work_dir, task_branch, target_branch,
   *     base_commit, delivery_contract_version: 2 }`。
   *
   * 任何部分锚点(只 taskBranch / 只 target/base / taskBranch null 但其他有 /
   * 空白 branch / 非 40 位 baseCommit)都会在发起 fetch 之前抛错,绝不静默降级为
   * 两字段兼容请求,绝不部分发出。
   */
  startTask(taskId: string, daemonId: string, workDir: string, anchors?: {
    taskBranch: string | null;
    targetBranch: string | null;
    baseCommit: string | null;
  } | null) {
    const body: Record<string, unknown> = { daemon_id: daemonId, work_dir: workDir };
    // 没有任何锚点 → 兼容模式,直接发 2 字段 body
    if (anchors == null) {
      return this.opWithRetry("POST", `/api/daemon/tasks/${taskId}/start`, body);
    }
    // 检测"全 null"兼容形态
    const allNull = anchors.taskBranch == null && anchors.targetBranch == null && anchors.baseCommit == null;
    if (allNull) {
      return this.opWithRetry("POST", `/api/daemon/tasks/${taskId}/start`, body);
    }
    // 至少一项非空 → 必须三项齐全 + 合法,否则抛错不发请求
    const missing: string[] = [];
    if (anchors.taskBranch == null) missing.push("taskBranch");
    if (anchors.targetBranch == null) missing.push("targetBranch");
    if (anchors.baseCommit == null) missing.push("baseCommit");
    if (missing.length > 0) {
      throw new Error(`Start 锚点部分缺失:${missing.join(", ")};必须 all-or-none,不得部分提供`);
    }
    // 类型 / 格式校验
    if (typeof anchors.taskBranch !== "string" || anchors.taskBranch.trim() === "") {
      throw new Error(`Start 锚点非法:taskBranch 必须是非空字符串,实际=${JSON.stringify(anchors.taskBranch)}`);
    }
    if (typeof anchors.targetBranch !== "string" || anchors.targetBranch.trim() === "") {
      throw new Error(`Start 锚点非法:targetBranch 必须是非空字符串,实际=${JSON.stringify(anchors.targetBranch)}`);
    }
    if (typeof anchors.baseCommit !== "string" || !/^[0-9a-f]{40}$/i.test(anchors.baseCommit)) {
      throw new Error(`Start 锚点非法:baseCommit 必须是完整 40 位 hex SHA-1,实际=${JSON.stringify(anchors.baseCommit)}`);
    }
    // v2 完整模式
    body.task_branch = anchors.taskBranch;
    body.target_branch = anchors.targetBranch;
    body.base_commit = anchors.baseCommit;
    body.delivery_contract_version = 2;
    return this.opWithRetry("POST", `/api/daemon/tasks/${taskId}/start`, body);
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
  /**
   * A05 · GET /api/daemon/tasks/:id/delivery(完整 DeliveryQueryResponse)。
   * v1/v2 共用:v1 路径下,delivered=true 来自 issue-status 回调写 delivered_at,
   * report_submitted=false,issue_status_requested 反映 in_review/done/blocked。
   * v2 路径下:report_submitted=true 表示 Delivery Report 落地,report_head_commit
   * 必须与当前 HEAD 严格相等才算本轮交付成功(SHA 允许 hex 大小写归一)。
   */
  async getTaskDelivery(taskId: string, token: string): Promise<DeliveryQueryResponse | null> {
    try {
      const r = (await this.req(
        "GET",
        `/api/daemon/tasks/${taskId}/delivery`,
        undefined,
        token,
      )) as DeliveryQueryResponse;
      return r;
    } catch (e: any) {
      if (e.status === 401 || e.status === 404) return null; // token 失效/任务消失 → 视为不可查询
      throw e;
    }
  }
  /**
   * 旧 v1 兼容:仅返回 delivered boolean。v2 路径已不再使用,保留是为了不破坏
   * 旧 runner 兼容测试。v2 应该用 getTaskDelivery 拿完整 DeliveryQueryResponse。
   */
  async taskDelivered(taskId: string, token: string): Promise<boolean> {
    const r = await this.getTaskDelivery(taskId, token);
    return r?.delivered === true;
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
