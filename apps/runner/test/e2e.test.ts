import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "@anvil/server";
import type { FastifyInstance } from "fastify";
import { ApiClient } from "../src/client.js";
import { Daemon } from "../src/poller.js";
import { executeTask } from "../src/executor.js";
import type { AgentBackend } from "../src/agents/backend.js";
import type { AgentMessage } from "@anvil/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createKimiBackend } from "../src/agents/kimi.js";

let app: FastifyInstance;
let daemon: Daemon | null = null;
const evidenceRoots: string[] = [];

afterEach(async () => {
  await daemon?.stop(); daemon = null; await app?.close();
  for (const root of evidenceRoots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("anvil-evidence-e2e-")) throw new Error("测试清理路径越界");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

/** E2E happy path：创建 issue 并指派 → daemon 自动认领执行 → completed。 */
it("create issue → daemon claims → completes end to end", async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;

  const tk = await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} });
  const daemonToken = tk.json().token;
  const a = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "bot", provider: "kimi" } });
  const issue = await app.inject({
    method: "POST", url: "/api/issues",
    payload: { title: "E2E 任务", assignee_type: "agent", assignee_id: a.json().id },
  });
  // A05: e2e happy path 走 v1 路径(issue-status=in_review 回调),保留旧契约。
  // 在 daemon claim 前,直接 UPDATE 任务为 v1,executor 走 v1 路径不追问 Delivery Report。
  app.db.$client.prepare(
    `UPDATE tasks SET delivery_contract_version = 1 WHERE issue_id = ? AND status = 'queued'`,
  ).run(issue.json().id);

  const fakeBackend: AgentBackend = {
    provider: "kimi",
    execute(opts) {
      const messages = (async function* (): AsyncGenerator<AgentMessage> {
        yield { type: "text", content: "e2e working" };
        yield { type: "tool_use", tool: "Bash", input: { command: "echo hi" } };
      })();
      // 好 Agent：进程退出前按目标契约回调推进 issue（否则 executor 会发起未交付追问）
      const result = (async () => {
        await fetch(`${opts.env.ANVIL_SERVER_URL}/api/daemon/tasks/${opts.env.ANVIL_TASK_ID}/issue-status`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.env.ANVIL_TOKEN}` },
          body: JSON.stringify({ status: "in_review" }),
        });
        return { status: "completed" as const, exitCode: 0 };
      })();
      return {
        messages,
        result,
        kill: () => {},
      };
    },
  };

  const client = new ApiClient(url, daemonToken);
  const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-e2e-"));
  daemon = new Daemon(client, {
    daemonId: "e2e-daemon",
    providers: [{ provider: "kimi", version: "e2e" }],
    pollMs: 50,
    heartbeatMs: 1000,
    executor: (pkg) => executeTask({ client, backend: fakeBackend, runnerRoot, cancelPollMs: 100, daemonId: 'e2e-daemon' }, pkg),
  });
  await daemon.start();

  // 等待任务完成（最多 5s）
  let task: any = null;
  for (let i = 0; i < 50; i++) {
    const tasks = (await app.inject({ method: "GET", url: `/api/issues/${issue.json().id}/tasks` })).json();
    if (tasks[0]?.status === "completed") { task = tasks[0]; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(task?.status).toBe("completed");

  const msgs = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/messages` })).json();
  expect(msgs.map((m: any) => m.type)).toEqual(["text", "tool_use"]);

  const runtimes = (await app.inject({ method: "GET", url: "/api/runtimes" })).json();
  expect(runtimes[0].status).toBe("online");
}, 10000);

it.each([0, 7])("v2 真实 Fake CLI 提交 Report，独立终检退出 %i 原子落库", async exitCode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-evidence-e2e-")); evidenceRoots.push(root);
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "测试"); git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "ANVIL.verify.json"), JSON.stringify({ version: 1, commands: [
    { id: "test", label: "真实检查", command: `"${process.execPath}" -e "console.log('独立验证输出');process.exit(${exitCode})"`, required: true, timeout_ms: 5000 },
  ] }));
  git("add", "."); git("commit", "-m", "验证基线"); const base = git("rev-parse", "HEAD");
  const fakeCli = path.join(root, "delivery-cli.mjs");
  fs.writeFileSync(fakeCli, `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
fs.writeFileSync('feature.txt', '实际产物');
execFileSync('git', ['add', 'feature.txt']);
execFileSync('git', ['commit', '-m', '完成任务']);
const head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
const response = await fetch(process.env.ANVIL_SERVER_URL + '/api/daemon/tasks/' + process.env.ANVIL_TASK_ID + '/delivery-report', {
  method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.ANVIL_TOKEN },
  body: JSON.stringify({ schema_version: 1, report_head_commit: head, problem_understanding: '端到端交付', solution_summary: 'Agent 声称测试全部通过', changed_areas: [{ path: 'feature.txt', summary: '实现' }], risks: [], unresolved: [] })
});
if (!response.ok) throw new Error('report_' + response.status);
console.log(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Agent 声称测试全部通过' }] }));
`);
  app = await buildApp({ dbPath: ":memory:", logger: false }); await app.listen({ host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const token = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  const agent = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "v2-bot", provider: "kimi" } })).json();
  const issue = (await app.inject({ method: "POST", url: "/api/issues", payload: { title: "v2 端到端证据", repo_path: repo, assignee_type: "agent", assignee_id: agent.id } })).json();
  const client = new ApiClient(url, token); const backend = createKimiBackend({ command: process.execPath, argsPrefix: [fakeCli] });
  daemon = new Daemon(client, { daemonId: "evidence-daemon", providers: [{ provider: "kimi", version: "test" }], pollMs: 100, heartbeatMs: 1000,
    executor: pkg => executeTask({ client, backend, runnerRoot: path.join(root, "runner"), cancelPollMs: 100, daemonId: "evidence-daemon" }, pkg),
  });
  await daemon.start();
  let task: any;
  for (let n = 0; n < 120; n++) {
    task = (await app.inject({ method: "GET", url: `/api/issues/${issue.id}/tasks` })).json()[0];
    if (["completed", "failed", "cancelled"].includes(task?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  expect(task.status).toBe("completed");
  const result = JSON.parse(task.result_json);
  expect(task.base_commit).toBe(base); expect(task.head_commit).not.toBe(base); expect(task.worktree_clean).toBe(true);
  expect(task.verification_status).toBe(exitCode === 0 ? "passed" : "failed");
  expect(result.review_packet_status).toBe(exitCode === 0 ? "ready" : "verification_blocked");
  expect(result.undelivered).toBeUndefined();
  const report = app.db.$client.prepare("SELECT report_head_commit FROM task_delivery_reports WHERE task_id=?").get(task.id) as any;
  const run = app.db.$client.prepare("SELECT * FROM verification_runs WHERE id=?").get(task.verification_run_id) as any;
  const checks = app.db.$client.prepare("SELECT * FROM verification_checks WHERE verification_run_id=? ORDER BY seq").all(run.id) as any[];
  expect(report.report_head_commit).toBe(task.head_commit); expect(run.verification_sha).toBe(task.head_commit);
  expect(checks).toHaveLength(1); expect(checks[0].exit_code).toBe(exitCode); expect(checks[0].output_excerpt).toContain("独立验证输出");
  expect((await app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).json().issue.status).toBe("in_review");
  expect(git("rev-parse", "HEAD")).toBe(base);
}, 20000);
