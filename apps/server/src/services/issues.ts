import { eq } from "drizzle-orm";
import { newId, type Db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { DELIVERY_CONTRACT_CURRENT_VERSION, priorityWeight, type CreateIssueRequest, type Issue, type IssueWithTask, type LatestTaskSummary, type RepositorySnapshot, type Task, type UpdateIssueRequest } from "@anvil/core";

function invalidRepository(message: string, code = "invalid_repository", http = 400): never {
  throw Object.assign(new Error(message), { http, statusCode: http, code });
}

function normalizedRepoPath(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") invalidRepository("仓库路径必须是文本", "invalid_repo_path");
  return value.trim() || null;
}

function resolveRepository(db: Db, workspaceId: string, repositoryId: unknown) {
  if (typeof repositoryId !== "string" || !repositoryId.trim() || repositoryId !== repositoryId.trim()) {
    invalidRepository("repository_id 必须是非空标识");
  }
  const repository = db.select().from(schema.repositories).where(eq(schema.repositories.id, repositoryId)).get();
  if (!repository || repository.workspace_id !== workspaceId) invalidRepository("仓库不存在或不属于当前工作区", "repository_not_found", 404);
  return repository;
}

function snapshotForIssue(db: Db, issue: Issue): RepositorySnapshot | null {
  if (!issue.repository_id) return null;
  const repository = resolveRepository(db, issue.workspace_id, issue.repository_id);
  let identity: RepositorySnapshot["identity"];
  try { identity = JSON.parse(repository.identity_json); }
  catch { invalidRepository("仓库身份记录无效，请重新绑定", "repository_identity_invalid", 409); }
  if (!identity || typeof identity.real_path !== "string" || !identity.real_path
    || typeof identity.dev !== "string" || !/^\d+$/.test(identity.dev)
    || typeof identity.ino !== "string" || !/^\d+$/.test(identity.ino)) {
    invalidRepository("仓库身份记录无效，请重新绑定", "repository_identity_invalid", 409);
  }
  const source = db.select().from(schema.externalIssues).where(eq(schema.externalIssues.local_issue_id, issue.id)).get();
  if (source && source.repository_id !== repository.id) invalidRepository("来源与绑定仓库不一致", "source_repository_mismatch", 409);
  const sourceSnapshotId = source?.accepted_snapshot_id ?? issue.source_snapshot_id ?? null;
  if (sourceSnapshotId) {
    const accepted = db.select().from(schema.sourceSnapshots).where(eq(schema.sourceSnapshots.id, sourceSnapshotId)).get();
    if (!accepted || accepted.repository_id !== repository.id || source && accepted.external_id !== source.external_id) {
      invalidRepository("接受的来源版本不属于当前仓库/Issue", "source_repository_mismatch", 409);
    }
  }
  return {
    schema_version: 1, repository_id: repository.id, mode: repository.mode,
    host: repository.host, external_id: repository.external_id, full_name: repository.full_name,
    clone_url: repository.clone_url, target_branch: repository.target_branch,
    checkout_path: repository.checkout_path,
    identity: { real_path: identity.real_path, dev: identity.dev, ino: identity.ino },
    source_snapshot_id: sourceSnapshotId,
    input: { title: issue.title, description: issue.description, acceptance: issue.acceptance },
  };
}

function rowToIssue(r: typeof schema.issues.$inferSelect): Issue {
  return r as unknown as Issue;
}

export function getIssue(db: Db, id: string): Issue | null {
  const rows = db.select().from(schema.issues).where(eq(schema.issues.id, id)).all();
  return rows[0] ? rowToIssue(rows[0]) : null;
}

export function listIssues(db: Db, workspaceId: string): IssueWithTask[] {
  const issues = db.select().from(schema.issues).where(eq(schema.issues.workspace_id, workspaceId)).all()
    .map(rowToIssue)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
  // 看板卡片摘要：每个 issue 的最新一条任务。v1 数据量小，N+1 可接受；量大后改窗口函数 JOIN。
  // rowid 作 created_at 同毫秒的决胜序，保证取到最新插入的任务。
  const latest = db.$client
    .prepare(`SELECT id, status, attempt, max_attempts, failure_reason, error, result_json FROM tasks
              WHERE issue_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  return issues.map((issue) => ({
    ...issue,
    latest_task: (latest.get(issue.id) as LatestTaskSummary | undefined) ?? null,
  }));
}

/** 入队判定（POST/PATCH/rerun 三入口共用）：assignee 是 agent 且状态活跃（非 backlog/done/cancelled）才入队；守卫与 enqueueForComment 一致。 */
export function enqueueForIssue(db: Db, issue: Issue, trigger: string): Task | null {
  if (issue.assignee_type !== "agent" || !issue.assignee_id) return null;
  if (issue.status === "backlog" || issue.status === "done" || issue.status === "cancelled") return null;
  return insertQueuedTask(db, issue, trigger);
}

export type CommentEnqueueResult =
  | { enqueued: true; task: Task }
  | { enqueued: false; reason: "assignee_not_agent" | "status_inactive" | "merged_into_pending" };

/** 评论触发入队（评论即指令）：与 enqueueForIssue 同一组守卫，但返回可判别的原因供路由回传。 */
export function enqueueForComment(db: Db, issue: Issue): CommentEnqueueResult {
  if (issue.assignee_type !== "agent" || !issue.assignee_id) return { enqueued: false, reason: "assignee_not_agent" };
  if (issue.status === "backlog" || issue.status === "done" || issue.status === "cancelled") return { enqueued: false, reason: "status_inactive" };
  const task = insertQueuedTask(db, issue, "comment");
  if (!task) return { enqueued: false, reason: "merged_into_pending" };
  return { enqueued: true, task };
}

/** 插入 queued 任务并写系统时间线；已有 pending 任务（部分唯一索引冲突）时返回 null。
 *  A02 · D-007:所有 v2 创建入口必须显式写 delivery_contract_version=DELIVERY_CONTRACT_CURRENT_VERSION,
 *  不依赖 DB 默认值。评论接力和 rerun 都走本入口,故本函数是 v2 写路径的唯一公共点。 */
function insertQueuedTask(db: Db, issue: Issue, trigger: string): Task | null {
  return db.$client.transaction(() => {
    // 来源接受、Issue 修改和入队使用同一 SQLite 快照，避免混合两个版本的输入。
    const current = getIssue(db, issue.id);
    if (!current || current.assignee_type !== "agent" || !current.assignee_id
      || ["backlog", "done", "cancelled"].includes(current.status)) return null;
    const snapshot = snapshotForIssue(db, current);
    const now = new Date().toISOString();
    const id = newId();
    try {
      db.insert(schema.tasks).values({
        id, workspace_id: current.workspace_id, issue_id: current.id,
        agent_id: current.assignee_id, status: "queued",
        priority: priorityWeight(current.priority), attempt: 1, max_attempts: 3,
        delivery_contract_version: DELIVERY_CONTRACT_CURRENT_VERSION,
        repository_id: snapshot?.repository_id ?? null,
        repository_snapshot_json: snapshot ? JSON.stringify(snapshot) : null,
        source_snapshot_id: snapshot?.source_snapshot_id ?? null,
        created_at: now,
      }).run();
    } catch (e: any) {
      // 部分唯一索引冲突表示合并进现有 pending Task；不得改写其已冻结输入。
      const msg = String(e?.message);
      if (msg.includes("tasks_one_pending_per_issue") || msg.includes("UNIQUE constraint failed: tasks.issue_id")) return null;
      throw e;
    }
    const freshReason = snapshot ? "；绑定任务使用新工作树，避免继承旧基线和来源版本" : "";
    addComment(db, current.id, { author_type: "system", author_id: "system", type: "system", body: `任务已入队（触发：${trigger}${freshReason}）` });
    return db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).all()[0] as unknown as Task;
  }).immediate();
}

export function addComment(
  db: Db, issueId: string,
  c: { author_type: string; author_id: string; type: string; body: string },
) {
  const id = newId();
  db.insert(schema.comments).values({
    id, issue_id: issueId, author_type: c.author_type, author_id: c.author_id,
    type: c.type, body: c.body, created_at: new Date().toISOString(),
  }).run();
  return id;
}

export function createIssueRow(db: Db, workspaceId: string, userId: string, req: CreateIssueRequest & { status?: string }): Issue {
  return db.$client.transaction(() => createIssueInTransaction(db, workspaceId, userId, req)).immediate();
}

function createIssueInTransaction(db: Db, workspaceId: string, userId: string, req: CreateIssueRequest & { status?: string }): Issue {
  const now = new Date().toISOString();
  const id = newId();
  const status = (req.status as any) ?? "todo";
  const repository = req.repository_id !== undefined ? resolveRepository(db, workspaceId, req.repository_id) : null;
  if (repository && req.repo_path !== undefined && normalizedRepoPath(req.repo_path) !== repository.checkout_path) {
    invalidRepository("repo_path 与绑定仓库的 checkout_path 不一致", "repository_path_mismatch", 409);
  }
  const repoPath = repository?.checkout_path ?? normalizedRepoPath(req.repo_path);
  db.insert(schema.issues).values({
    id, workspace_id: workspaceId, title: req.title, description: req.description ?? null,
    acceptance: req.acceptance ?? null,
    status, priority: req.priority ?? "medium",
    assignee_type: req.assignee_type ?? null, assignee_id: req.assignee_id ?? null,
    creator_type: "member", creator_id: userId,
    repo_path: repoPath,
    repository_id: repository?.id ?? null,
    position: Date.now(), created_at: now, updated_at: now,
  }).run();
  if (repoPath) recordRecentRepo(db, workspaceId, repoPath);
  return getIssue(db, id)!;
}

const MAX_RECENT_REPOS = 8;

/** 从 workspace settings_json 解析 recent_repos（非法 JSON / 非数组 → []）。 */
export function parseRecentRepos(settingsJson: string): string[] {
  try {
    const s = JSON.parse(settingsJson || "{}");
    return Array.isArray(s?.recent_repos)
      ? s.recent_repos.filter((x: unknown): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/** 把 repo_path 记入 workspace.settings_json 的 recent_repos（去重置顶，cap 8），供创建模态框快捷选择。 */
function recordRecentRepo(db: Db, workspaceId: string, repoPath: string): void {
  const ws = db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).all()[0];
  if (!ws) return;
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(ws.settings_json || "{}"); } catch { settings = {}; }
  const next = [repoPath, ...parseRecentRepos(ws.settings_json).filter((x) => x !== repoPath)].slice(0, MAX_RECENT_REPOS);
  db.update(schema.workspaces)
    .set({ settings_json: JSON.stringify({ ...settings, recent_repos: next }) })
    .where(eq(schema.workspaces.id, workspaceId))
    .run();
}

export function updateIssueRow(db: Db, id: string, req: UpdateIssueRequest): Issue | null {
  return db.$client.transaction(() => updateIssueInTransaction(db, id, req)).immediate();
}

function updateIssueInTransaction(db: Db, id: string, req: UpdateIssueRequest): Issue | null {
  const cur = getIssue(db, id);
  if (!cur) return null;
  const repositoryId = req.repository_id !== undefined ? req.repository_id : cur.repository_id ?? null;
  const repository = repositoryId !== null ? resolveRepository(db, cur.workspace_id, repositoryId) : null;
  const source = db.select().from(schema.externalIssues).where(eq(schema.externalIssues.local_issue_id, id)).get();
  if (source && repositoryId !== source.repository_id) {
    invalidRepository("已导入的 Issue 不能改绑或解除来源仓库", "source_repository_locked", 409);
  }
  if (repository && req.repo_path !== undefined && normalizedRepoPath(req.repo_path) !== repository.checkout_path) {
    invalidRepository("repo_path 与绑定仓库的 checkout_path 不一致", "repository_path_mismatch", 409);
  }
  const bindingChanged = repositoryId !== (cur.repository_id ?? null);
  const repoPath = repository ? repository.checkout_path
    : req.repo_path !== undefined ? normalizedRepoPath(req.repo_path)
    : bindingChanged ? null : cur.repo_path;
  db.update(schema.issues).set({
    title: req.title ?? cur.title,
    description: req.description !== undefined ? req.description : cur.description,
    acceptance: req.acceptance !== undefined ? req.acceptance : cur.acceptance,
    status: (req.status as any) ?? cur.status,
    priority: req.priority ?? cur.priority,
    assignee_type: req.assignee_type !== undefined ? req.assignee_type : cur.assignee_type,
    assignee_id: req.assignee_id !== undefined ? req.assignee_id : cur.assignee_id,
    repo_path: repoPath,
    repository_id: repository?.id ?? null,
    source_snapshot_id: bindingChanged ? null : cur.source_snapshot_id ?? null,
    updated_at: new Date().toISOString(),
  }).where(eq(schema.issues.id, id)).run();
  return getIssue(db, id);
}

export function listTasksForIssue(db: Db, issueId: string): Task[] {
  return db.select().from(schema.tasks).where(eq(schema.tasks.issue_id, issueId)).all() as unknown as Task[];
}
