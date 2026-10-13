import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Issue, RepositorySnapshot, Task, TaskPackage } from "@anvil/core";
import { buildApp } from "../src/app.js";
import { failTaskInternal } from "../src/services/tasks.js";
import { enqueueForIssue, getIssue, updateIssueRow } from "../src/services/issues.js";

let app: FastifyInstance;
let workspaceId: string;
let agentId: string;
let daemonToken: string;
const identity = { real_path: "D:/repo/.git", dev: "18446744073709551615", ino: "9007199254740993123" };

function repository(id = "repo-1", workspace = workspaceId): void {
  app.db.prepare(`INSERT INTO repositories
    (id,workspace_id,mode,host,external_id,full_name,clone_url,target_branch,checkout_path,identity_json,connection_status,created_at,updated_at)
    VALUES (?,?,'github_pr','github.com',?,?,'https://github.com/owner/repo.git','main',?,?,'connected',?,?)`)
    .run(id, workspace, `external-${id}`, `owner/${id}`, `D:/${id}`, JSON.stringify(identity), new Date().toISOString(), new Date().toISOString());
}

function source(id: string, repo = "repo-1"): void {
  app.db.prepare(`INSERT INTO source_snapshots
    (id,repository_id,external_id,issue_number,url,title,body,state,source_updated_at,hash,created_at)
    VALUES (?,?,'external-issue',7,'https://github.com/owner/repo/issues/7',?,'正文','open',?,?,?)`)
    .run(id, repo, `来源 ${id}`, new Date().toISOString(), `hash-${id}`, new Date().toISOString());
}

async function createIssue(payload: Record<string, unknown> = {}): Promise<Issue> {
  const response = await app.inject({ method: "POST", url: "/api/issues", payload: {
    title: "初始目标", description: "初始描述", acceptance: "初始标准", repository_id: "repo-1",
    assignee_type: "agent", assignee_id: agentId, ...payload,
  } });
  expect(response.statusCode).toBe(201);
  return response.json();
}

function taskForIssue(issueId: string): Task {
  return app.db.prepare("SELECT * FROM tasks WHERE issue_id=? ORDER BY rowid DESC LIMIT 1").get(issueId) as Task;
}

async function claim(): Promise<TaskPackage[]> {
  const response = await app.inject({ method: "POST", url: "/api/daemon/claim", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1" } });
  expect(response.statusCode).toBe(200);
  return response.json().tasks;
}

function markCompleted(taskId: string): void {
  app.db.prepare(`UPDATE tasks SET status='completed',work_dir='D:/prior',task_branch='task/old',target_branch='main',base_commit=?,head_commit=?,
    verification_status='passed',complete_payload_hash='旧完成摘要',complete_response_json='{"ok":true}' WHERE id=?`)
    .run("a".repeat(40), "b".repeat(40), taskId);
  app.db.prepare("UPDATE agents SET status='idle' WHERE id=?").run(agentId);
}

beforeEach(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  workspaceId = (await app.inject({ method: "GET", url: "/api/bootstrap" })).json().workspace.id;
  agentId = (await app.inject({ method: "POST", url: "/api/agents", payload: { name: "测试执行器", provider: "kimi" } })).json().id;
  daemonToken = (await app.inject({ method: "POST", url: "/api/daemon-tokens", payload: {} })).json().token;
  await app.inject({ method: "POST", url: "/api/daemon/register", headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", runtimes: [{ provider: "kimi", version: "1" }] } });
  repository();
  repository("repo-2");
});

afterEach(async () => {
  await app.close();
  app.db.$client.close();
});

describe("T01 绑定 Issue 与不可变 Task 输入", () => {
  it("绑定仓库固定 checkout 与完整仓库/输入快照，文件身份无损", async () => {
    const issue = await createIssue();
    expect(issue.repo_path).toBe("D:/repo-1");
    const task = taskForIssue(issue.id);
    expect(task.repository_id).toBe("repo-1");
    expect(JSON.parse(task.repository_snapshot_json!)).toEqual({
      schema_version: 1, repository_id: "repo-1", mode: "github_pr", host: "github.com",
      external_id: "external-repo-1", full_name: "owner/repo-1", clone_url: "https://github.com/owner/repo.git",
      target_branch: "main", checkout_path: "D:/repo-1", identity,
      source_snapshot_id: null, input: { title: "初始目标", description: "初始描述", acceptance: "初始标准" },
    } satisfies RepositorySnapshot);
    expect(task.target_branch).toBeNull();
    expect(task.base_commit).toBeNull();
  });

  it("请求不能用另一个 repo_path 覆盖绑定 checkout，失败不写 Issue", async () => {
    const response = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "错误绑定", repository_id: "repo-1", repo_path: "D:/other" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("repository_path_mismatch");
    expect(app.db.prepare("SELECT id FROM issues").all()).toEqual([]);
    const issue = await createIssue({ repo_path: " D:/repo-1 " });
    const patched = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { repo_path: null } });
    expect(patched.statusCode).toBe(409);
    expect((app.db.prepare("SELECT repo_path FROM issues WHERE id=?").get(issue.id) as { repo_path: string }).repo_path).toBe("D:/repo-1");
  });

  it("未知/其他工作区仓库不可绑定", async () => {
    const now = new Date().toISOString();
    app.db.prepare("INSERT INTO workspaces (id,name,slug,created_at) VALUES ('other','其他工作区','other',?)").run(now);
    repository("other-repo", "other");
    for (const repositoryId of ["missing", "other-repo"]) {
      const response = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "禁止绑定", repository_id: repositoryId } });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("repository_not_found");
    }
    expect(app.db.prepare("SELECT id FROM issues").all()).toEqual([]);
  });

  it("Issue 改绑和仓库配置变更不会影响 queued Task 的 claim 输入", async () => {
    const issue = await createIssue();
    const original = taskForIssue(issue.id);
    const patched = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: {
      title: "后续目标", description: "后续描述", acceptance: "后续标准", repository_id: "repo-2",
    } });
    expect(patched.statusCode).toBe(200);
    app.db.prepare("UPDATE repositories SET target_branch='develop',checkout_path='D:/changed',identity_json=? WHERE id='repo-1'")
      .run(JSON.stringify({ real_path: "D:/changed/.git", dev: "7", ino: "8" }));
    const [pkg] = await claim();
    expect(pkg.task.id).toBe(original.id);
    expect(pkg.task.repository_snapshot_json).toBe(original.repository_snapshot_json);
    expect(pkg.issue).toMatchObject({ title: "初始目标", description: "初始描述", acceptance: "初始标准", repository_id: "repo-1", repo_path: "D:/repo-1" });
    expect(pkg.prior_work_dir).toBeNull();
    expect(JSON.parse(pkg.task.repository_snapshot_json!).target_branch).toBe("main");
  });

  it("来源只冻结 accepted，不用 latest 覆盖；后续接受版本仅影响新 Task", async () => {
    const issue = await createIssue({ assignee_type: "member", assignee_id: "owner" });
    source("accepted");
    source("latest");
    app.db.prepare(`INSERT INTO external_issues
      (repository_id,external_id,local_issue_id,issue_number,url,accepted_snapshot_id,latest_snapshot_id)
      VALUES ('repo-1','external-issue',?,7,'https://github.com/owner/repo/issues/7','accepted','latest')`).run(issue.id);
    app.db.prepare("UPDATE issues SET source_snapshot_id='accepted' WHERE id=?").run(issue.id);
    expect((await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { assignee_type: "agent", assignee_id: agentId } })).statusCode).toBe(200);
    const first = taskForIssue(issue.id);
    expect(first.source_snapshot_id).toBe("accepted");
    app.db.prepare("UPDATE external_issues SET accepted_snapshot_id='latest' WHERE local_issue_id=?").run(issue.id);
    app.db.prepare("UPDATE issues SET source_snapshot_id='latest',title='已接受新目标' WHERE id=?").run(issue.id);
    const [pkg] = await claim();
    expect(pkg.issue.source_snapshot_id).toBe("accepted");
    expect(pkg.issue.title).toBe("初始目标");
    markCompleted(first.id);
    expect((await app.inject({ method: "POST", url: `/api/issues/${issue.id}/rerun` })).statusCode).toBe(201);
    const next = taskForIssue(issue.id);
    expect(next.source_snapshot_id).toBe("latest");
    expect(JSON.parse(next.repository_snapshot_json!).input.title).toBe("已接受新目标");
    expect((app.db.prepare("SELECT repository_snapshot_json FROM tasks WHERE id=?").get(first.id) as Task).repository_snapshot_json).toBe(first.repository_snapshot_json);
  });

  it.each([null, "repo-2"])("已导入来源的 Issue 不能改绑为 %s", async (repositoryId) => {
    const issue = await createIssue({ assignee_type: "member", assignee_id: "owner" });
    source("accepted");
    app.db.prepare(`INSERT INTO external_issues
      (repository_id,external_id,local_issue_id,issue_number,url,accepted_snapshot_id,latest_snapshot_id)
      VALUES ('repo-1','external-issue',?,7,'url','accepted','accepted')`).run(issue.id);
    const response = await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { repository_id: repositoryId } });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("source_repository_locked");
  });

  it("评论合并进 pending Task 时不改写已冻结目标", async () => {
    const issue = await createIssue();
    const task = taskForIssue(issue.id);
    await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { title: "后续目标" } });
    const comment = await app.inject({ method: "POST", url: `/api/issues/${issue.id}/comments`, payload: { body: "补充说明" } });
    expect(comment.statusCode).toBe(201);
    expect(comment.json().trigger).toMatchObject({ enqueued: false, reason: "merged_into_pending" });
    expect(taskForIssue(issue.id).repository_snapshot_json).toBe(task.repository_snapshot_json);
    const [pkg] = await claim();
    expect(pkg.issue.title).toBe("初始目标");
    expect(pkg.comments.some(item => item.body === "补充说明")).toBe(true);
  });

  it.each(["rerun", "comments"])("绑定任务通过 %s 接力采用新工作树，不继承旧 Git/完成证据", async (action) => {
    const issue = await createIssue();
    const original = taskForIssue(issue.id);
    markCompleted(original.id);
    const response = await app.inject({ method: "POST", url: `/api/issues/${issue.id}/${action}`, ...(action === "comments" ? { payload: { body: "下一步" } } : {}) });
    expect(response.statusCode).toBe(201);
    const [pkg] = await claim();
    expect(pkg.task.id).not.toBe(original.id);
    expect(pkg.prior_work_dir).toBeNull();
    for (const key of ["task_branch", "target_branch", "base_commit", "head_commit", "verification_status", "complete_payload_hash", "complete_response_json"] as const) expect(pkg.task[key]).toBeNull();
    expect(pkg.comments.some(item => item.body.includes("绑定任务使用新工作树"))).toBe(true);
  });

  it.each(["internal", "daemon"])("%s 自动重试保持父任务不可变输入并 fresh，不读取新 Issue", async (mode) => {
    const issue = await createIssue();
    const [pkg] = await claim();
    app.db.prepare("UPDATE tasks SET task_branch='task/old',target_branch='main',base_commit=?,work_dir='D:/prior' WHERE id=?").run("a".repeat(40), pkg.task.id);
    await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { title: "后续目标", repository_id: "repo-2" } });
    if (mode === "internal") failTaskInternal(app.db, pkg.task.id, "non_zero_exit", "进程失败", "D:/prior");
    else {
      const response = await app.inject({ method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/fail`, headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", failure_reason: "non_zero_exit", error: "进程失败", work_dir: "D:/prior" } });
      expect(response.statusCode).toBe(200);
    }
    const child = taskForIssue(issue.id);
    expect(child.parent_task_id).toBe(pkg.task.id);
    expect(child.repository_snapshot_json).toBe(pkg.task.repository_snapshot_json);
    const [retry] = await claim();
    expect(retry.task.id).toBe(child.id);
    expect(retry.prior_work_dir).toBeNull();
    expect(retry.issue).toMatchObject({ title: "初始目标", repo_path: "D:/repo-1", repository_id: "repo-1" });
    expect([retry.task.task_branch, retry.task.target_branch, retry.task.base_commit]).toEqual([null, null, null]);
  });

  it("旧 queued Task 后绑定仓库时不回填身份：旧任务失败、新 rerun 正常冻结", async () => {
    const legacyResponse = await app.inject({ method: "POST", url: "/api/issues", payload: { title: "旧任务", repo_path: "D:/legacy", assignee_type: "agent", assignee_id: agentId } });
    const issue = legacyResponse.json() as Issue;
    const legacy = taskForIssue(issue.id);
    expect(legacy.repository_snapshot_json).toBeNull();
    await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { repository_id: "repo-1" } });
    expect(await claim()).toEqual([]);
    const failed = taskForIssue(issue.id);
    expect(failed).toMatchObject({ status: "failed", failure_reason: null, error: "旧任务缺仓库快照，请重新执行", repository_snapshot_json: null });
    expect((await app.inject({ method: "POST", url: `/api/issues/${issue.id}/rerun` })).statusCode).toBe(201);
    expect((await claim())[0].task.repository_id).toBe("repo-1");
  });

  it("快照损坏不能回退到可变 Issue 或阻断其他任务认领", async () => {
    const first = await createIssue();
    const firstTask = taskForIssue(first.id);
    app.db.prepare("UPDATE tasks SET repository_snapshot_json='invalid-json' WHERE id=?").run(firstTask.id);
    const second = await createIssue();
    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0].issue.id).toBe(second.id);
    expect(taskForIssue(first.id)).toMatchObject({ status: "failed", failure_reason: null });
  });

  it("来源不能跨仓库引用，拒绝入队而不生成错误快照", async () => {
    const issue = await createIssue({ assignee_type: "member", assignee_id: "owner" });
    source("other-source", "repo-2");
    app.db.prepare("UPDATE issues SET source_snapshot_id='other-source' WHERE id=?").run(issue.id);
    const assigned = updateIssueRow(app.db, issue.id, { assignee_type: "agent", assignee_id: agentId })!;
    expect(() => enqueueForIssue(app.db, assigned, "assign")).toThrow("接受的来源版本不属于当前仓库/Issue");
    expect(app.db.prepare("SELECT id FROM tasks WHERE issue_id=?").all(issue.id)).toEqual([]);
  });

  it("入队时间线写入失败会回滚 Task 及其快照", async () => {
    const issue = await createIssue({ assignee_type: "member", assignee_id: "owner" });
    updateIssueRow(app.db, issue.id, { assignee_type: "agent", assignee_id: agentId });
    app.db.$client.exec(`CREATE TRIGGER reject_enqueue_comment BEFORE INSERT ON comments
      BEGIN SELECT RAISE(ABORT,'入队时间线不可写'); END;`);
    expect(() => enqueueForIssue(app.db, getIssue(app.db, issue.id)!, "assign")).toThrow("入队时间线不可写");
    expect(app.db.prepare("SELECT id FROM tasks WHERE issue_id=?").all(issue.id)).toEqual([]);
  });

  it("普通 Issue 解除绑定后的新任务不复用以前的绑定工作树", async () => {
    const issue = await createIssue();
    markCompleted(taskForIssue(issue.id).id);
    expect((await app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: { repository_id: null, repo_path: "D:/unbound" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/issues/${issue.id}/rerun` })).statusCode).toBe(201);
    const [pkg] = await claim();
    expect(pkg.task.repository_snapshot_json).toBeNull();
    expect(pkg.prior_work_dir).toBeNull();
    expect(pkg.issue.repo_path).toBe("D:/unbound");
  });

  it("绑定 Task 的 start 必须包含完整锚点且目标等于入队快照", async () => {
    await createIssue();
    const [pkg] = await claim();
    const start = (extra: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/daemon/tasks/${pkg.task.id}/start`, headers: { authorization: `Bearer ${daemonToken}` }, payload: { daemon_id: "d1", work_dir: "D:/worktree", ...extra } });
    expect((await start({})).statusCode).toBe(400);
    const anchors = { delivery_contract_version: 2, task_branch: "task/new", target_branch: "develop", base_commit: "a".repeat(40) };
    const mismatch = await start(anchors);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().code).toBe("base_mismatch");
    expect((await start({ ...anchors, target_branch: "main" })).statusCode).toBe(200);
  });
});
