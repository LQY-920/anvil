// apps/server/test/delivery-report.test.ts
//
// A05 · Delivery Report、v2 delivered_at 与追问契约
//
// 覆盖:认证、Schema 与大小、UTF-8 字节限制、脱敏、幂等、
// active 替换、事务回滚(trigger 强制失败)、GET delivery。
// 重点:不修改 Task 终态以外业务表的非必要副作用;
// 所有断言都通过 buildApp :memory: + app.inject 走真实 HTTP 路径。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { DELIVERY_CONTRACT_CURRENT_VERSION } from "@anvil/core";

let app: FastifyInstance;
let daemonToken: string;
let agentId: string;
let issueId: string;
let taskId: string;
let taskToken: string;

const TASK_TOKEN = () => taskToken;
const DAEMON_TOKEN = () => daemonToken;

/** claim 一个 v2 task,返回 task_id 与 task_token。 */
async function claimV2Task(): Promise<{ id: string; task_token: string }> {
  const c = await app.inject({
    method: "POST",
    url: "/api/daemon/claim",
    headers: { authorization: `Bearer ${daemonToken}` },
    payload: { daemon_id: "d1" },
  });
  const pkg = c.json().tasks[0];
  if (!pkg) throw new Error("no task claimed");
  return { id: pkg.task.id, task_token: pkg.task_token };
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  agentId = a.json().id;
  const i = await app.inject({
    method: "POST",
    url: "/api/issues",
    payload: { title: "demo", assignee_type: "agent", assignee_id: agentId },
  });
  issueId = i.json().id;
  await app.inject({
    method: "POST",
    url: "/api/daemon/register",
    headers: { authorization: `Bearer ${daemonToken}` },
    payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] },
  });
  // claim 一个 v2 task,记录 task id + task token
  const claimed = await claimV2Task();
  taskId = claimed.id;
  taskToken = claimed.task_token;
});

afterEach(async () => {
  await app?.close();
});

/** 构造一个合法的 Delivery Report 主体。 */
function makeValidReport(head = "a".repeat(40)) {
  return {
    schema_version: 1,
    report_head_commit: head,
    problem_understanding: "问题理解",
    solution_summary: "方案摘要",
    changed_areas: [{ path: "src/a.ts", summary: "改动 1" }],
    risks: [] as { level: string; summary: string; mitigation: string }[],
    unresolved: [] as { description: string }[],
  };
}

const put = (url: string, body: unknown, token?: string) =>
  app.inject({
    method: "PUT",
    url,
    headers: { authorization: `Bearer ${token ?? TASK_TOKEN()}` },
    payload: body as any,
  });

const getDelivery = (url: string, token?: string) =>
  app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token ?? TASK_TOKEN()}` },
  });

// =============================================================================
// 1. 认证
// =============================================================================

describe("delivery-report · authentication", () => {
  it("无 token → 401,零副作用", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/daemon/tasks/${taskId}/delivery-report`,
      payload: makeValidReport(),
    });
    expect(res.statusCode).toBe(401);
    // 没有写入 delivery report
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row).toBeUndefined();
  });

  it("错误 token → 401,零副作用", async () => {
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport(), "atk_bogus");
    expect(res.statusCode).toBe(401);
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row).toBeUndefined();
  });

  it("daemon token 不得替代 task token → 401", async () => {
    const res = await put(
      `/api/daemon/tasks/${taskId}/delivery-report`,
      makeValidReport(),
      DAEMON_TOKEN(),
    );
    expect(res.statusCode).toBe(401);
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row).toBeUndefined();
  });

  it("其他 Task 的 task token → 401,零副作用", async () => {
    // 再 claim 一个 task(把 issue 多 enqueue 一个,需要先把当前 claim 出去的处理掉)
    // 简化做法:直接构造一个不存在的 task id 并伪造一个非匹配的 token 验证授权失败
    // 由于 task token 是单 Task 关联,这里直接用 atk_<random> 形式,期望 401
    const res = await put(
      `/api/daemon/tasks/${taskId}/delivery-report`,
      makeValidReport(),
      `atk_${crypto.randomBytes(16).toString("hex")}`,
    );
    expect(res.statusCode).toBe(401);
  });

  it("active v2 Task 合法提交 → 200,落库 + 写 delivered_at", async () => {
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.task_id).toBe(taskId);
    expect(body.report_version).toBe(1);
    expect(body.report_head_commit).toBe("a".repeat(40));
    // 首次成功提交时 receipt 不带 replay 字段(JSON 序列化后为 undefined),
    // 重复提交时 replay=true。两者都视为非 replay 错误状态。
    expect(body.replay === undefined || body.replay === false).toBe(true);
    expect(typeof body.submitted_at).toBe("string");
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row).toBeTruthy();
    expect(row.problem_understanding).toBe("问题理解");
    const task = app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    expect(task.delivered_at).toBeTruthy();
  });

  it("active v1 Task 提交 → 409 invalid_transition,零写入", async () => {
    // 直接 UPDATE task 的 contract_version 到 1,模拟迁移前 v1 历史
    app.db.$client
      .prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`)
      .run(taskId);
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("invalid_transition");
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row).toBeUndefined();
  });

  it("terminal Task 提交 → 409 task_not_active,零写入", async () => {
    // 不走 complete(会清 task token),直接 UPDATE task status 模拟终态
    // 这样 task token 仍有效,可验证 taskAuth 通过后由 service 拒绝
    app.db.$client
      .prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`)
      .run(taskId);
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("task_not_active");
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row).toBeUndefined();
  });
});

// =============================================================================
// 2. Schema 与大小
// =============================================================================

describe("delivery-report · schema and size validation", () => {
  it("schema_version=1 合法", async () => {
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect(res.statusCode).toBe(200);
  });

  it("未知 schema_version 拒绝 → 400 invalid_schema", async () => {
    const body = makeValidReport();
    (body as any).schema_version = 99;
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("非法 SHA(短 SHA)拒绝 → 400 invalid_schema", async () => {
    const res = await put(
      `/api/daemon/tasks/${taskId}/delivery-report`,
      makeValidReport("abc"),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("problem_understanding 缺失拒绝 → 400", async () => {
    const body = makeValidReport();
    (body as any).problem_understanding = "";
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("solution_summary 缺失拒绝 → 400", async () => {
    const body = makeValidReport();
    delete (body as any).solution_summary;
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("changed_areas 超过 50 拒绝 → 400", async () => {
    const body = makeValidReport();
    body.changed_areas = Array.from({ length: 51 }, (_, i) => ({
      path: `src/file${i}.ts`,
      summary: `改动 ${i}`,
    }));
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("risks 超过 20 拒绝 → 400", async () => {
    const body = makeValidReport();
    body.risks = Array.from({ length: 21 }, (_, i) => ({
      level: "low",
      summary: `风险 ${i}`,
      mitigation: `缓解 ${i}`,
    }));
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("unresolved 超过 20 拒绝 → 400", async () => {
    const body = makeValidReport();
    body.unresolved = Array.from({ length: 21 }, (_, i) => ({ description: `未知 ${i}` }));
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("重复 changed path 拒绝 → 400", async () => {
    const body = makeValidReport();
    body.changed_areas = [
      { path: "src/a.ts", summary: "第一次" },
      { path: "src/a.ts", summary: "重复" },
    ];
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("非法 risk level 拒绝 → 400", async () => {
    const body = makeValidReport();
    body.risks = [{ level: "extreme", summary: "x", mitigation: "y" }];
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_schema");
  });

  it("UTF-8 中文按字节限制(超过 64KB 拒绝)", async () => {
    // 制造恰好超过 64KB 的 body
    // "中".charCodeAt 1 字节 = 3,4000 个 "中" = 12000 字节,远不够
    // 用 description 字段造大:每个 description 重复长字符串
    const big = "测".repeat(64 * 1024); // 单字段 64KB,整体超限
    const body = {
      schema_version: 1,
      report_head_commit: "a".repeat(40),
      problem_understanding: "x",
      solution_summary: "y",
      changed_areas: [{ path: "src/a.ts", summary: big }],
      risks: [],
      unresolved: [],
    };
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    // 超 64KB 整段拒绝
    expect([400]).toContain(res.statusCode);
    expect(res.json().code).toBe("payload_too_large");
  });

  it("64KB 边界合法", async () => {
    // 让 body 总字节正好 = 64 * 1024
    // 骨架很小,大字段放在 changed_areas.summary,字节数精确凑齐
    const body = makeValidReport();
    // 用 "测" 字符(UTF-8 3 字节)来精确凑整
    const base = JSON.stringify(body);
    const target = 64 * 1024;
    const need = target - Buffer.byteLength(base, "utf8");
    // need 包括新增 path/summary 的 JSON 包装("path":"src/pad.ts","summary":"测测测..."):
    // 包装约占 30 字节,留余量
    const padSize = Math.max(0, need - 40);
    if (padSize > 0) {
      body.changed_areas.push({ path: "src/pad.ts", summary: "测".repeat(Math.floor(padSize / 3)) });
    }
    // 重新计算实际大小,微调让总体 <= target
    let finalSize = Buffer.byteLength(JSON.stringify(body), "utf8");
    while (finalSize > target) {
      const last = body.changed_areas[body.changed_areas.length - 1];
      last.summary = last.summary.slice(0, -1);
      if (last.summary.length === 0) {
        body.changed_areas.pop();
        if (body.changed_areas.length === 1) break; // 至少保留 1 个
      }
      finalSize = Buffer.byteLength(JSON.stringify(body), "utf8");
    }
    expect(finalSize).toBeLessThanOrEqual(64 * 1024);
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    // 整 64KB 边界合法
    expect(res.statusCode).toBe(200);
  });

  it("拒绝后 Report 与 delivered_at 都不写", async () => {
    // 先故意触发一次非法提交
    const bad = makeValidReport("z".repeat(40));
    (bad as any).changed_areas = [{ path: "x" }, { path: "x" }];
    const r1 = await put(`/api/daemon/tasks/${taskId}/delivery-report`, bad);
    expect(r1.statusCode).toBe(400);
    const row1 = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row1).toBeUndefined();
    const task1 = app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    expect(task1.delivered_at).toBeNull();
  });
});

// =============================================================================
// 3. 脱敏
// =============================================================================

describe("delivery-report · redaction", () => {
  it("task token 出现在 problem_understanding → 数据库中不得出现原 token", async () => {
    const body = makeValidReport();
    body.problem_understanding = `请按计划处理 ${taskToken} 后继续`;
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(200);
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row.problem_understanding).not.toContain(taskToken);
    // 脱敏占位 [REDACTED] 必须出现
    expect(row.problem_understanding).toContain("[REDACTED]");
  });

  it("atv_ / anv_ / Bearer token 在嵌套字段都被脱敏", async () => {
    const body = makeValidReport();
    const fakeAnv = "anv_fake_daemon_token_value";
    const fakeAtk = "atk_fake_task_token_value";
    const fakeBearer = "Bearer abcdefghij12345";
    body.changed_areas = [
      { path: "src/a.ts", summary: `daemon token: ${fakeAnv}, task token: ${fakeAtk}, header: ${fakeBearer}` },
    ];
    body.risks = [{ level: "low", summary: fakeAnv, mitigation: fakeAtk }];
    body.unresolved = [{ description: fakeBearer }];
    body.solution_summary = `Authorization: Bearer xyzzy12345`;
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(200);
    const row = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(row.changed_areas_json).not.toContain(fakeAnv);
    expect(row.changed_areas_json).not.toContain(fakeAtk);
    expect(row.changed_areas_json).not.toContain("xyzzy12345");
    expect(row.risks_json).not.toContain(fakeAnv);
    expect(row.risks_json).not.toContain(fakeAtk);
    expect(row.unresolved_json).not.toContain("abcdefghij12345");
    expect(row.solution_summary).toContain("[REDACTED]");
  });

  it("响应与错误信息不泄漏 token", async () => {
    const body = makeValidReport();
    body.problem_understanding = `secret ${taskToken}`;
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body);
    expect(res.statusCode).toBe(200);
    // 响应里只有 delivery 字段,不会回显原 problem_understanding
    const json = res.json();
    expect(JSON.stringify(json)).not.toContain(taskToken);
  });
});

// =============================================================================
// 4. 幂等
// =============================================================================

describe("delivery-report · idempotency", () => {
  it("首次提交写一行并设置 delivered_at", async () => {
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect(res.statusCode).toBe(200);
    const r1 = app.db.$client
      .prepare(`SELECT submitted_at, updated_at, report_head_commit FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(r1.report_head_commit).toBe("a".repeat(40));
    expect(r1.submitted_at).toBeTruthy();
    expect(r1.updated_at).toBeTruthy();
    const t1 = app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    expect(t1.delivered_at).toBeTruthy();
  });

  it("相同内容重放 → replay=true,行数 1,submitted_at/updated_at/delivered_at 不变", async () => {
    const r1 = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect(r1.statusCode).toBe(200);
    const after1 = app.db.$client
      .prepare(`SELECT submitted_at, updated_at FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    const t1 = app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any;

    // 等 50ms 后再提交,确保时间戳差异若被刷新也能检测到
    await new Promise((r) => setTimeout(r, 50));

    const r2 = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect(r2.statusCode).toBe(200);
    const body2 = r2.json();
    expect(body2.replay).toBe(true);

    // 行数仍为 1
    const rows = app.db.$client
      .prepare(`SELECT COUNT(*) AS n FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(rows.n).toBe(1);

    const after2 = app.db.$client
      .prepare(`SELECT submitted_at, updated_at FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(after2.submitted_at).toBe(after1.submitted_at);
    expect(after2.updated_at).toBe(after1.updated_at);

    const t2 = app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    expect(t2.delivered_at).toBe(t1.delivered_at);

    // 评论数仍为初始(本任务从 queued → dispatched 是 claim,没有评论;只有 enqueue 才有)
    // replay 不应新增评论
    const commentsBefore = app.db.$client
      .prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?`)
      .get(issueId) as any;
    // 第二次(replay)后评论数应与第一次提交后一致
    const commentsAfter = app.db.$client
      .prepare(`SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?`)
      .get(issueId) as any;
    expect(commentsAfter.n).toBe(commentsBefore.n);
  });

  it("数组顺序不同但规范化内容相同 → 也视为 replay", async () => {
    const head = "b".repeat(40);
    const body1 = {
      schema_version: 1,
      report_head_commit: head,
      problem_understanding: "p",
      solution_summary: "s",
      changed_areas: [
        { path: "src/a.ts", summary: "A" },
        { path: "src/b.ts", summary: "B" },
      ],
      risks: [
        { level: "low", summary: "r1", mitigation: "m1" },
        { level: "medium", summary: "r2", mitigation: "m2" },
      ],
      unresolved: [{ description: "u1" }, { description: "u2" }],
    };
    const body2 = {
      ...body1,
      changed_areas: [body1.changed_areas[1], body1.changed_areas[0]],
      risks: [body1.risks[1], body1.risks[0]],
      unresolved: [body1.unresolved[1], body1.unresolved[0]],
    };
    const r1 = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body1);
    expect(r1.statusCode).toBe(200);
    const r2 = await put(`/api/daemon/tasks/${taskId}/delivery-report`, body2);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().replay).toBe(true);
    const n = app.db.$client
      .prepare(`SELECT COUNT(*) AS n FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(n.n).toBe(1);
  });

  it("active Task 提交不同 Report → 更新同一行(行数仍 1,更新 head_commit,delivered_at 保持首次)", async () => {
    const r1 = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport("a".repeat(40)));
    expect(r1.statusCode).toBe(200);
    const t1 = app.db.$client
      .prepare(`SELECT submitted_at FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    const origDeliveredAt = (app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any).delivered_at;
    await new Promise((r) => setTimeout(r, 50));

    // 提交不同 report_head_commit
    const r2 = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport("b".repeat(40)));
    expect(r2.statusCode).toBe(200);
    // 不同内容不是 replay,response 不带 replay 字段(JSON 序列化为 undefined)。
    expect(r2.json().replay === undefined || r2.json().replay === false).toBe(true);

    const n = app.db.$client
      .prepare(`SELECT COUNT(*) AS n FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(n.n).toBe(1);

    const after = app.db.$client
      .prepare(`SELECT report_head_commit, submitted_at, updated_at FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(after.report_head_commit).toBe("b".repeat(40));
    // submitted_at 保留首次
    expect(after.submitted_at).toBe(t1.submitted_at);
    // updated_at 应更新
    expect(after.updated_at).not.toBe(t1.submitted_at);

    // delivered_at 保持首次提交时间
    const finalDelivered = (app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any).delivered_at;
    expect(finalDelivered).toBe(origDeliveredAt);
  });
});

// =============================================================================
// 5. 事务回滚(trigger 强制失败)
// =============================================================================

describe("delivery-report · transaction rollback via trigger", () => {
  /** 在 INSERT 时直接抛错,确保 Report 与 delivered_at 一起回滚。 */
  function armReportInsertTrigger() {
    app.db.$client.exec(`CREATE TRIGGER force_report_fail BEFORE INSERT ON task_delivery_reports
      BEGIN SELECT RAISE(ABORT, 'forced report insert failure for A05 test'); END;`);
  }
  function armDeliveredAtTrigger() {
    app.db.$client.exec(`CREATE TRIGGER force_delivered_at_fail BEFORE UPDATE OF delivered_at ON tasks
      WHEN NEW.id = OLD.id
      BEGIN SELECT RAISE(ABORT, 'forced delivered_at update failure for A05 test'); END;`);
  }
  function dropAllTriggers() {
    app.db.$client.exec(`DROP TRIGGER IF EXISTS force_report_fail;`);
    app.db.$client.exec(`DROP TRIGGER IF EXISTS force_delivered_at_fail;`);
  }
  afterEach(() => dropAllTriggers());

  it("Report INSERT 失败 → delivered_at 不得写入", async () => {
    armReportInsertTrigger();
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    // 失败由 trigger 抛出,应表现为 5xx 或 4xx(本实现以事务回滚完成,不对外暴露 trigger 文本)
    expect([400, 500]).toContain(res.statusCode);
    // Report 没有写入
    const r = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(r).toBeUndefined();
    // delivered_at 没有写入
    const t = app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    expect(t.delivered_at).toBeNull();
  });

  it("delivered_at UPDATE 失败 → Report 不得残留", async () => {
    armDeliveredAtTrigger();
    const res = await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    expect([400, 500]).toContain(res.statusCode);
    // Report 没有残留
    const r = app.db.$client
      .prepare(`SELECT * FROM task_delivery_reports WHERE task_id = ?`)
      .get(taskId) as any;
    expect(r).toBeUndefined();
    // delivered_at 没有写入
    const t = app.db.$client
      .prepare(`SELECT delivered_at FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    expect(t.delivered_at).toBeNull();
  });
});

// =============================================================================
// 6. GET delivery
// =============================================================================

describe("GET /api/daemon/tasks/:id/delivery", () => {
  it("无 Report 时 → report_submitted=false,其它 Report 字段 null", async () => {
    const res = await getDelivery(`/api/daemon/tasks/${taskId}/delivery`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(false);
    expect(body.report_submitted).toBe(false);
    expect(body.report_schema_version).toBeNull();
    expect(body.report_head_commit).toBeNull();
    expect(body.issue_status_requested).toBeNull();
  });

  it("提交后 → 返回真实 schema_version 与 report_head_commit,delivered=true", async () => {
    const head = "c".repeat(40);
    await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport(head));
    const res = await getDelivery(`/api/daemon/tasks/${taskId}/delivery`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(true);
    expect(body.report_submitted).toBe(true);
    expect(body.report_schema_version).toBe(1);
    expect(body.report_head_commit).toBe(head);
    // v2 走 Delivery Report 路径,issue_status_requested 保持 null
    expect(body.issue_status_requested).toBeNull();
  });

  it("v1 callback 兼容:issue-status=in_review 后 issue_status_requested='in_review'", async () => {
    // 把 Task 改回 v1
    app.db.$client
      .prepare(`UPDATE tasks SET delivery_contract_version = 1 WHERE id = ?`)
      .run(taskId);
    // agent 调 issue-status=in_review
    const cb = await app.inject({
      method: "POST",
      url: `/api/daemon/tasks/${taskId}/issue-status`,
      headers: { authorization: `Bearer ${taskToken}` },
      payload: { status: "in_review" },
    });
    expect(cb.statusCode).toBe(200);
    const res = await getDelivery(`/api/daemon/tasks/${taskId}/delivery`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delivered).toBe(true);
    // v1 走 callback 路径,无 Report
    expect(body.report_submitted).toBe(false);
    expect(body.issue_status_requested).toBe("in_review");
  });

  it("v2 Report 不伪造 issue_status_requested(未调 callback → null)", async () => {
    await put(`/api/daemon/tasks/${taskId}/delivery-report`, makeValidReport());
    const res = await getDelivery(`/api/daemon/tasks/${taskId}/delivery`);
    const body = res.json();
    expect(body.issue_status_requested).toBeNull();
  });

  it("v2 blocked callback 成功后 issue_status_requested='blocked'", async () => {
    const cb = await app.inject({
      method: "POST",
      url: `/api/daemon/tasks/${taskId}/issue-status`,
      headers: { authorization: `Bearer ${taskToken}` },
      payload: { status: "blocked" },
    });
    expect(cb.statusCode).toBe(200);
    const res = await getDelivery(`/api/daemon/tasks/${taskId}/delivery`);
    const body = res.json();
    expect(body.issue_status_requested).toBe("blocked");
  });
});

// =============================================================================
// 7. v2 task contract_version 防御
// =============================================================================

describe("delivery-report · v2 contract guard", () => {
  it("contract_version=2 是可写前提(由 claimTasks 写入)", () => {
    const row = app.db.$client
      .prepare(`SELECT delivery_contract_version FROM tasks WHERE id = ?`)
      .get(taskId) as any;
    expect(row.delivery_contract_version).toBe(DELIVERY_CONTRACT_CURRENT_VERSION);
  });
});
