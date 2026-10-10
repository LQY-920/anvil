import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { VerificationRun, V2CompleteRequest } from "@anvil/core";

const base = "a".repeat(40), head = "b".repeat(40), oldHead = "c".repeat(40);
let app: FastifyInstance, daemonToken: string, taskToken: string, taskId: string, issueId: string;
const post = (suffix: string, payload: unknown, token = daemonToken) => app.inject({ method: "POST", url: `/api/daemon/tasks/${taskId}/${suffix}`, headers: { authorization: `Bearer ${token}` }, payload: payload as any });
const row = () => app.db.$client.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as any;
const count = (table: string) => (app.db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const issueStatus = () => (app.db.$client.prepare("SELECT status FROM issues WHERE id=?").get(issueId) as { status: string }).status;
function run(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return { schema_version: 1, policy_source: "ANVIL.verify.json", policy_hash: "d".repeat(64), verification_sha: head, status: "passed", started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:01.000Z",
    checks: [{ id: "tests", label: "测试", command: "pnpm test", required: true, status: "passed", exit_code: 0, duration_ms: 100, output_excerpt: "通过" }], ...overrides };
}
function body(verification = run()): V2CompleteRequest {
  return { daemon_id: "d1", branch: "task/evidence", work_dir: "/work", base_commit: base, head_commit: head, worktree_clean: true, verification };
}
async function report(sha = head) {
  const r = await app.inject({ method: "PUT", url: `/api/daemon/tasks/${taskId}/delivery-report`, headers: { authorization: `Bearer ${taskToken}` }, payload: {
    schema_version: 1, report_head_commit: sha, problem_understanding: "问题", solution_summary: "方案", changed_areas: [{ path: "a.ts", summary: "修复" }], risks: [], unresolved: [],
  } });
  expect(r.statusCode).toBe(200);
}
beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  daemonToken = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const agent = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } })).json();
  issueId = (await app.inject({ method: "POST", url: "/api/issues", payload: { title: "证据事务", repo_path: "/repo", assignee_type: "agent", assignee_id: agent.id } })).json().id;
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "test" }] } });
  const pkg = (await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } })).json().tasks[0];
  taskId = pkg.task.id; taskToken = pkg.task_token;
  expect((await post("start", { daemon_id: "d1", work_dir: "/work", task_branch: "task/evidence", target_branch: "main", base_commit: base, delivery_contract_version: 2 })).statusCode).toBe(200);
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); });

describe("A07 原子终检证据", () => {
  it("保存任务事实、Run、Checks、版本化结果和完整回执", async () => {
    await report();
    const r = await post("complete", body());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, task_id: taskId, status: "completed", review_packet_status: "ready" });
    const t = row();
    expect(t).toMatchObject({ status: "completed", base_commit: base, head_commit: head, worktree_clean: 1, verification_status: "passed", task_token_hash: null });
    const stored = app.db.$client.prepare("SELECT * FROM verification_runs WHERE id=?").get(t.verification_run_id) as any;
    expect(stored).toMatchObject({ task_id: taskId, base_commit: base, verification_sha: head, status: "passed", schema_version: 1 });
    const check = app.db.$client.prepare("SELECT * FROM verification_checks WHERE verification_run_id=?").get(stored.id);
    expect(check).toMatchObject({ seq: 0, check_id: "tests", required: 1, exit_code: 0, duration_ms: 100, output_excerpt: "通过" });
    expect(JSON.parse(t.result_json)).toMatchObject({ schema_version: 2, verification_run_id: stored.id, review_packet_status: "ready", verification: run() });
    expect(JSON.parse(t.result_json)).not.toHaveProperty("daemon_id");
    expect(issueStatus()).toBe("in_review");
  });
  it.each(["failed", "partial", "not_configured", "dirty", "stale", "invalid_policy", "verification_error"] as const)("真实 %s 证据可完成并进入人工审查", async kind => {
    await report();
    const p = body();
    if (kind === "failed" || kind === "partial") {
      p.verification.status = kind;
      Object.assign(p.verification.checks[0], { status: "failed", exit_code: 1, required: kind === "failed" });
    } else if (kind === "not_configured") {
      p.verification = run({ policy_source: "none", policy_hash: null, verification_sha: null, status: "not_configured", started_at: null, checks: [] });
    } else if (kind === "dirty") {
      p.worktree_clean = false; p.verification.status = "dirty";
    } else if (kind === "stale") {
      p.verification.status = "stale"; p.verification.verification_sha = oldHead;
    } else {
      p.verification = run({ status: "failed", error_code: kind, verification_sha: null, started_at: null, checks: [], ...(kind === "verification_error" ? { policy_hash: null } : {}) });
    }
    const r = await post("complete", p);
    expect(r.statusCode).toBe(200);
    expect(row().verification_status).toBe(p.verification.status);
    expect(r.json().review_packet_status).toBe(kind === "dirty" || kind === "stale" ? "integrity_blocked" : "verification_blocked");
    expect(issueStatus()).toBe("in_review");
  });
  it("验证前 dirty 的 skipped 检查不被误判 required 失败", async () => {
    const p = body(); p.worktree_clean = false; p.verification.status = "dirty"; p.verification.started_at = null;
    Object.assign(p.verification.checks[0], { status: "skipped", exit_code: null, duration_ms: 0, output_excerpt: "" });
    expect((await post("complete", p)).statusCode).toBe(200);
    expect(row().verification_status).toBe("dirty");
  });
  it.each(["缺报告", "缺 delivered_at", "旧报告"])("%s 不得产生 ready", async kind => {
    if (kind !== "缺报告") await report(kind === "旧报告" ? oldHead : head);
    if (kind === "缺 delivered_at") app.db.$client.prepare("UPDATE tasks SET delivered_at=NULL WHERE id=?").run(taskId);
    const r = await post("complete", body());
    expect(r.statusCode).toBe(200);
    expect(r.json().review_packet_status).toBe(kind === "旧报告" ? "integrity_blocked" : "incomplete");
    expect(issueStatus()).toBe(kind === "旧报告" ? "in_review" : "in_progress");
  });
  it("重放不增加 Run/Checks/评论/广播，修改有效载荷冲突", async () => {
    await report(); const spy = vi.spyOn(app.hub, "broadcast");
    const first = await post("complete", body()); const before = { task: row(), comments: count("comments"), broadcasts: spy.mock.calls.length };
    const second = await post("complete", body());
    expect(second.statusCode).toBe(200); expect(second.json()).toEqual(first.json());
    expect(row()).toEqual(before.task); expect(count("verification_runs")).toBe(1); expect(count("verification_checks")).toBe(1);
    expect(count("comments")).toBe(before.comments); expect(spy).toHaveBeenCalledTimes(before.broadcasts);
    const changed = body(); changed.verification.checks[0].duration_ms++;
    const conflict = await post("complete", changed);
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe("idempotency_conflict");
  });
  it.each(["base_commit", "branch", "work_dir"])("拒绝与 start 不一致的 %s", async field => {
    const p: any = body(); p[field] = field === "base_commit" ? oldHead : "other";
    const r = await post("complete", p); expect(r.statusCode).toBe(409); expect(r.json().code).toBe("base_mismatch");
    expect(row().status).toBe("running"); expect(count("verification_runs")).toBe(0);
  });
  const invalid: [string, (p: any) => void, string?][] = [
    ["缺验证", p => delete p.verification], ["缺 HEAD", p => delete p.head_commit],
    ["缺基线", p => delete p.base_commit], ["缺分支", p => delete p.branch], ["缺工作目录", p => delete p.work_dir],
    ["未知版本", p => p.verification.schema_version = 2, "invalid_schema"],
    ["未知枚举", p => p.verification.status = "legacy", "invalid_schema"],
    ["未知字段", p => p.verification.claimed_pass = true, "invalid_schema"],
    ["必选失败谎报通过", p => Object.assign(p.verification.checks[0], { status: "failed", exit_code: 2 })],
    ["单条状态与退出码矛盾", p => p.verification.checks[0].exit_code = 2],
    ["clean 为 false 谎报通过", p => p.worktree_clean = false],
    ["验证 SHA 过期谎报通过", p => p.verification.verification_sha = oldHead],
    ["缺验证 SHA", p => p.verification.verification_sha = null],
    ["重复 ID", p => p.verification.checks.push({ ...p.verification.checks[0] })],
    ["超过 8 条", p => p.verification.checks = Array.from({ length: 9 }, (_, i) => ({ ...p.verification.checks[0], id: `c${i}` }))],
    ["非法 bool", p => p.verification.checks[0].required = "true"],
    ["负耗时", p => p.verification.checks[0].duration_ms = -1],
    ["缺结束时间", p => delete p.verification.completed_at],
    ["结束早于开始", p => p.verification.completed_at = "2025-01-01T00:00:00.000Z"],
    ["无策略却含检查", p => p.verification.policy_source = "none"],
    ["空检查伪造 passed", p => p.verification.checks = []],
    ["有执行检查却缺开始时间", p => { p.verification.error_code = "verification_error"; p.verification.status = "failed"; p.verification.started_at = null; }],
    ["有执行检查却缺验证 SHA", p => { p.verification.error_code = "verification_error"; p.verification.status = "failed"; p.verification.verification_sha = null; }],
    ["单条输出超限", p => p.verification.checks[0].output_excerpt = "中".repeat(2731), "payload_too_large"],
    ["总 JSON 超限", p => p.verification.checks = Array.from({ length: 8 }, (_, i) => ({ ...p.verification.checks[0], id: `c${i}`, output_excerpt: "a".repeat(8192) })), "payload_too_large"],
  ];
  it.each(invalid)("拒绝非法证据：%s", async (_name, mutate, code = "invalid_verification") => {
    const p = body(); mutate(p); const before = row(); const spy = vi.spyOn(app.hub, "broadcast");
    const r = await post("complete", p); expect(r.statusCode).toBe(400); expect(r.json().code).toBe(code);
    expect(row()).toEqual(before); expect(count("verification_runs")).toBe(0); expect(spy).not.toHaveBeenCalled();
  });
  it.each([
    "BEFORE INSERT ON verification_runs",
    "BEFORE INSERT ON verification_checks WHEN NEW.seq=1",
    "BEFORE UPDATE OF verification_run_id ON tasks",
    "BEFORE UPDATE OF complete_payload_hash ON tasks",
    "BEFORE INSERT ON comments",
  ])("SQL 强制失败时全部回滚：%s", async clause => {
    await report(); const before = row(); const comments = count("comments"); const spy = vi.spyOn(app.hub, "broadcast");
    app.db.$client.exec(`CREATE TRIGGER abort_evidence ${clause} BEGIN SELECT RAISE(ABORT, '测试回滚'); END;`);
    const p = body(); p.verification.checks.push({ ...p.verification.checks[0], id: "second" });
    const r = await post("complete", p); expect(r.statusCode).toBe(500);
    expect(row()).toEqual(before); expect(count("verification_runs")).toBe(0); expect(count("verification_checks")).toBe(0);
    expect(count("comments")).toBe(comments); expect(issueStatus()).toBe("in_progress"); expect(spy).not.toHaveBeenCalled();
    expect((app.db.$client.prepare("SELECT status FROM agents WHERE id=?").get(before.agent_id) as any).status).toBe("working");
    app.db.$client.exec("DROP TRIGGER abort_evidence");
    expect((await post("complete", p)).statusCode).toBe(200);
  });
  it("task token 和其他 daemon 均不能写证据", async () => {
    expect((await post("complete", body(), taskToken)).statusCode).toBe(401);
    expect((await post("complete", { ...body(), daemon_id: "other" })).statusCode).toBe(403);
    expect(row().status).toBe("running"); expect(count("verification_runs")).toBe(0);
  });
  it("验证文本脱敏后写入所有快照，重放仍命中", async () => {
    const p = body(); const marker = "atk_FAKE_VERIFICATION_TOKEN";
    Object.assign(p.verification.checks[0], { label: marker, command: `echo ${marker}`, output_excerpt: `Bearer fake/token+tail== ${marker}` });
    const a = await post("complete", p); expect(a.statusCode).toBe(200);
    const snapshot = JSON.stringify([row(), app.db.$client.prepare("SELECT * FROM verification_checks").all()]);
    expect(snapshot).not.toContain(marker); expect(snapshot).not.toContain("fake/token+tail=="); expect(snapshot).toContain("[REDACTED]");
    expect((await post("complete", p)).json()).toEqual(a.json());
  });
  it("URL task branch push 失败记录 pushed=false，不把 Issue 标为 done", async () => {
    await report(); const r = await post("complete", { ...body(), pushed: false });
    expect(r.statusCode).toBe(200); expect(JSON.parse(row().result_json).pushed).toBe(false); expect(issueStatus()).toBe("in_review");
  });
  it("required 超时与后续 skipped 原样落库为失败", async () => {
    await report(); const p = body(); p.verification.status = "failed";
    Object.assign(p.verification.checks[0], { status: "timed_out", exit_code: null, duration_ms: 1000 });
    p.verification.checks.push({ ...p.verification.checks[0], id: "next", status: "skipped", duration_ms: 0, output_excerpt: "" });
    expect((await post("complete", p)).json().review_packet_status).toBe("verification_blocked");
    expect(app.db.$client.prepare("SELECT status FROM verification_checks ORDER BY seq").all()).toEqual([{ status: "timed_out" }, { status: "skipped" }]);
  });
  it("空策略 commands 是 not_configured，保留文件 hash", async () => {
    const p = body(run({ status: "not_configured", checks: [], verification_sha: null, started_at: null }));
    expect((await post("complete", p)).statusCode).toBe(200);
    expect(row().verification_status).toBe("not_configured");
    expect((app.db.$client.prepare("SELECT policy_hash FROM verification_runs").get() as any).policy_hash).toBe(p.verification.policy_hash);
  });
  it("无 Git 锚点的 v2 完成保持 incomplete，不伪造验证记录", async () => {
    app.db.$client.prepare("UPDATE tasks SET task_branch=NULL,target_branch=NULL,base_commit=NULL WHERE id=?").run(taskId);
    const forged = await post("complete", body()); expect(forged.statusCode).toBe(400);
    const r = await post("complete", { daemon_id: "d1", work_dir: "/work" });
    expect(r.statusCode).toBe(200); expect(r.json().review_packet_status).toBe("incomplete");
    expect(row().verification_run_id).toBeNull(); expect(row().verification_status).toBeNull(); expect(count("verification_runs")).toBe(0);
    expect(issueStatus()).toBe("in_progress");
  });
  it.each(["blocked", "done"])("完整 v2 交付不抢占 Issue.%s", async status => {
    await report(); app.db.$client.prepare("UPDATE issues SET status=? WHERE id=?").run(status, issueId);
    expect((await post("complete", body())).statusCode).toBe(200);
    expect(issueStatus()).toBe(status);
  });
});
