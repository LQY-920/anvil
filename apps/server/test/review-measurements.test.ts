import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

let app: FastifyInstance, taskId: string, issueId: string;
const completed = new Date(Date.now() - 120_000).toISOString();
const payload = () => ({ ui_version: "legacy", review_started_at: new Date(Date.now() - 10_000).toISOString(), active_review_ms: 5000, opened_transcript: true, opened_full_diff: false });
const put = (body: unknown, id = taskId) => app.inject({ method: "PUT", url: `/api/tasks/${id}/review-measurement`, payload: body as any });
const row = () => app.db.$client.prepare("SELECT * FROM review_measurements WHERE task_id=?").get(taskId) as any;
beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  const agent = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "计时", provider: "kimi" } })).json();
  issueId = (await app.inject({ method: "POST", url: "/api/issues", payload: { title: "前瞻基线", assignee_type: "agent", assignee_id: agent.id } })).json().id;
  taskId = (await app.inject({ method: "GET", url: `/api/issues/${issueId}/tasks` })).json()[0].id;
  app.db.$client.prepare("UPDATE tasks SET status='completed', completed_at=? WHERE id=?").run(completed, taskId);
});
afterEach(async () => { await app.close(); });

describe("A08 验收测量", () => {
  it.each([1, 2])("旧 UI 可以记录 v%i Task，版本分组互不混淆", async version => {
    app.db.$client.prepare("UPDATE tasks SET delivery_contract_version=? WHERE id=?").run(version, taskId);
    const p = payload(); const first = await put(p);
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ task_id: taskId, ...p });
    expect(row()).toMatchObject({ ui_version: "legacy", active_review_ms: 5000, opened_transcript: 1 });
    expect((await put(p)).json()).toEqual(first.json());
    expect((app.db.$client.prepare("SELECT COUNT(*) AS n FROM review_measurements").get() as any).n).toBe(1);
  });
  it("延续取累计最大值，迟到请求不回退时间和已打开标志", async () => {
    const p = payload(); await put(p);
    const newer = await put({ ...p, active_review_ms: 8000, opened_full_diff: true });
    expect(newer.statusCode).toBe(200);
    expect((await put(p)).json()).toEqual(newer.json());
    expect(row()).toMatchObject({ active_review_ms: 8000, opened_full_diff: 1 });
  });
  it("失效标记覆盖既有有效行，延迟的有效请求不能恢复样本", async () => {
    const p = payload(); await put(p);
    expect((await put({ ...p, review_started_at: null, active_review_ms: null })).statusCode).toBe(200);
    expect((await put(p)).json()).toMatchObject({ review_started_at: null, active_review_ms: null });
  });
  it.each([
    ["负数", { active_review_ms: -1 }], ["小数", { active_review_ms: 1.5 }], ["字符串", { active_review_ms: "5" }],
    ["未来", { review_started_at: "2999-01-01T00:00:00.000Z" }], ["无效日期", { review_started_at: "2026-02-30T00:00:00.000Z" }],
    ["空日期", { review_started_at: "" }], ["无效版本", { ui_version: "v2" }], ["超过墙钟", { active_review_ms: 60_000 }],
    ["半个 null", { active_review_ms: null }], ["非法 bool", { opened_full_diff: 1 }], ["日志虚报", { opened_transcript: false }],
    ["伪造录入时间", { recorded_at: completed }], ["缺字段", { opened_full_diff: undefined }],
    ["早于完成", { review_started_at: "2020-01-01T00:00:00.000Z" }],
  ])("拒绝非法测量：%s", async (_name, override) => {
    expect((await put({ ...payload(), ...override })).statusCode).toBe(400); expect(row()).toBeUndefined();
  });
  it("只接收存在且已完成的 Task", async () => {
    expect((await put(payload(), "missing")).statusCode).toBe(404);
    app.db.$client.prepare("UPDATE tasks SET status='running' WHERE id=?").run(taskId);
    expect((await put(payload())).statusCode).toBe(409); expect(row()).toBeUndefined();
  });
  it("merge 携带失败标记先排除样本，即使旧计时请求稍后才到", async () => {
    const p = payload(); await put(p);
    // 此 fixture 没有可合入仓库，验证失效处理不依赖 Git 操作成功。
    await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge`, payload: { review_measurement_failed_for: taskId } });
    expect(row().active_review_ms).toBeNull();
    await put(p); expect(row().active_review_ms).toBeNull();
  });
  it("打回意见携带失败标记，继续评论/排队但排除测量", async () => {
    await put(payload());
    const r = await app.inject({ method: "POST", url: `/api/issues/${issueId}/comments`, payload: { body: "补充检查", review_measurement_failed_for: taskId } });
    expect(r.statusCode).toBe(201); expect(r.json().trigger.enqueued).toBe(true); expect(row().active_review_ms).toBeNull();
  });
  it("测量表持续写入失败仍可打回，独立失效标记阻止旧样本恢复", async () => {
    app.db.$client.prepare("UPDATE tasks SET result_json=? WHERE id=?").run(JSON.stringify({ branch: "task/kept", head_commit: "a".repeat(40), verification: { status: "failed" } }), taskId);
    const p = payload(); await put(p);
    app.db.$client.exec("CREATE TRIGGER measurement_unavailable BEFORE INSERT ON review_measurements BEGIN SELECT RAISE(ABORT, '测试测量表不可写'); END");
    expect((await put({ ...p, active_review_ms: 6000 })).statusCode).toBe(500);
    const r = await app.inject({ method: "POST", url: `/api/issues/${issueId}/comments`, payload: { body: "继续打回", review_measurement_failed_for: taskId } });
    expect(r.statusCode).toBe(201); expect(r.json().trigger.enqueued).toBe(true);
    const result = app.db.$client.prepare("SELECT result_json FROM tasks WHERE id=?").get(taskId) as any;
    expect(JSON.parse(result.result_json)).toEqual({ branch: "task/kept", head_commit: "a".repeat(40), verification: { status: "failed" }, review_measurement_excluded: true });
    app.db.$client.exec("DROP TRIGGER measurement_unavailable");
    expect((await put(p)).json().active_review_ms).toBeNull();
  });
  it("失败标记不能指向其他 Issue/Task", async () => {
    const other = (await app.inject({ method: "POST", url: "/api/issues", payload: { title: "其他" } })).json();
    const r = await app.inject({ method: "POST", url: `/api/issues/${other.id}/comments`, payload: { body: "意见", review_measurement_failed_for: taskId } });
    expect(r.statusCode).toBe(400); expect(row()).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge`, payload: { review_measurement_failed_for: "other" } })).statusCode).toBe(400);
  });
});
