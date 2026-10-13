import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { canonicalJsonHash, withGitLock, type BindRepositoryRequest, type Repository, type IssueSource, type SourceSnapshot } from "@anvil/core";
import { newId, seed, type Db } from "../db/client.js";
import { ensureGitAvailable, git } from "../lib/git.js";
import { readGitRepositoryIdentity, sameGitRepository, gitRepositoryKey } from "../lib/git-repository.js";
import { GitHubError, githubRepositoryPath, parseGitHubRepository, type GitHubClient } from "../lib/github.js";
import { createIssueRow, getIssue } from "./issues.js";

export interface RepositoryOptions { git?: typeof git; runnerRoot?: string; now?: () => number; }
export const repositoryError = (message: string, http = 409, code = "repository_conflict", retryable = false) => new GitHubError(message, http, code, retryable);

export function repositoryFromRow(row: any): Repository {
  const { identity_json, sync_failures: _failures, ...rest } = row;
  return { ...rest, can_push: Boolean(row.can_push), identity: JSON.parse(identity_json) } as Repository;
}
export function getRepository(db: Db, id: string): Repository | null {
  const row = db.$client.prepare("SELECT * FROM repositories WHERE id=?").get(id);
  return row ? repositoryFromRow(row) : null;
}
export function listRepositories(db: Db): Repository[] {
  return db.$client.prepare("SELECT * FROM repositories ORDER BY created_at,id").all().map(repositoryFromRow);
}
export function requireRepository(db: Db, id: string): Repository {
  const repository = getRepository(db, id);
  if (!repository) throw repositoryError("仓库不存在", 404, "repository_not_found");
  return repository;
}
function stableId(value: unknown): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw repositoryError("远端未返回有效的稳定标识", 502, "invalid_github_response");
}
export interface RemoteRepository {
  id: number | string; full_name: string; clone_url: string; default_branch: string;
  permissions?: { push?: boolean; pull?: boolean }; archived?: boolean; disabled?: boolean;
}

/** 返回名称变化，但不在后台替用户接受重命名或重绑定。 */
export async function readRemoteRepository(db: Db, client: GitHubClient, repository: Repository): Promise<RemoteRepository> {
  const remote = (await client.request<RemoteRepository>(repository.host, "GET", githubRepositoryPath(repository.full_name))).data;
  if (!remote || stableId(remote.id) !== repository.external_id) throw repositoryError("远端仓库身份已变化，停止操作", 409, "repository_mismatch");
  if (remote.full_name !== repository.full_name) {
    db.$client.prepare("UPDATE repositories SET connection_status='renamed',error=?,updated_at=? WHERE id=?")
      .run("远端仓库已重命名，请在绑定时明确确认", new Date().toISOString(), repository.id);
    throw repositoryError("远端仓库已重命名，请明确确认后继续", 409, "repository_renamed");
  }
  return remote;
}

export async function bindRepository(db: Db, client: GitHubClient, request: BindRepositoryRequest, options: RepositoryOptions = {}): Promise<Repository> {
  if (!request || !["local_git", "github_pr"].includes(request.mode) || typeof request.repo !== "string" || !request.repo.trim()) {
    throw repositoryError("请选择仓库模式并填写地址", 400, "invalid_request");
  }
  if (request.checkout_path !== undefined && (typeof request.checkout_path !== "string" || !request.checkout_path.trim())) throw repositoryError("本地目录不能为空", 400, "invalid_request");
  if (request.target_branch !== undefined && (typeof request.target_branch !== "string" || !request.target_branch.trim())) throw repositoryError("目标分支不能为空", 400, "invalid_request");
  await ensureGitAvailable();
  const runGit = options.git ?? git;
  const now = new Date(options.now?.() ?? Date.now()).toISOString();
  const { workspace } = seed(db);
  let host = "local", externalId: string, fullName: string, cloneUrl: string, checkout: string;
  let login: string | null = null, canPush = true, target: string;
  let remote: RemoteRepository | null = null;
  if (request.mode === "github_pr") {
    const input = parseGitHubRepository(request.repo.trim()); host = input.host;
    const user = (await client.request<{ login: string }>(host, "GET", "/user")).data;
    if (!user || typeof user.login !== "string" || !user.login) throw repositoryError("无法确认 GitHub 登录身份", 403, "github_permission_denied");
    login = user.login;
    remote = (await client.request<RemoteRepository>(host, "GET", githubRepositoryPath(input.fullName))).data;
    externalId = stableId(remote?.id); fullName = remote.full_name;
    githubRepositoryPath(fullName);
    const remoteAddress = parseGitHubRepository(remote.clone_url);
    if (remoteAddress.host !== host || remoteAddress.fullName.toLowerCase() !== fullName.toLowerCase()) throw repositoryError("远端克隆地址与仓库身份不一致", 502, "invalid_github_response");
    cloneUrl = remote.clone_url;
    canPush = remote.permissions?.push === true && !remote.archived && !remote.disabled;
    target = request.target_branch ?? remote.default_branch;
    if (typeof target !== "string" || !target) throw repositoryError("远端未提供目标分支", 502, "invalid_github_response");
    await client.request(host, "GET", `${githubRepositoryPath(fullName)}/branches/${encodeURIComponent(target)}`);
    const existing = db.$client.prepare("SELECT * FROM repositories WHERE host=? AND external_id=?").get(host, externalId) as any;
    if (existing && existing.full_name !== fullName && request.confirm_rename !== true) {
      db.$client.prepare("UPDATE repositories SET connection_status='renamed',error=?,updated_at=? WHERE id=?")
        .run("仓库名称发生变化，需要明确确认", now, existing.id);
      throw repositoryError("此稳定仓库已重命名，请确认后重新绑定", 409, "repository_renamed");
    }
    const root = options.runnerRoot ?? process.env.ANVIL_RUNNER_ROOT ?? path.join(os.homedir(), ".anvil");
    checkout = request.checkout_path ? path.resolve(request.checkout_path) : existing?.checkout_path
      ?? path.join(root, "repos", createHash("sha256").update(`${host}:${externalId}`).digest("hex").slice(0, 16));
    if (!fs.existsSync(checkout)) {
      if (request.checkout_path) throw repositoryError("指定的本地仓库不存在", 400, "repository_not_found");
      fs.mkdirSync(path.dirname(checkout), { recursive: true });
      // 固定 helper 字符串由平台提供；凭据只在 gh/Git 进程之间传递，不读取到 Node 或任务环境。
      await withGitLock(path.dirname(checkout), async () => {
        if (!fs.existsSync(checkout)) await runGit(path.dirname(checkout), ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "clone", "--", cloneUrl, checkout]);
      });
    }
    const origin = (await runGit(checkout, ["remote", "get-url", "origin"])).trim();
    const originAddress = parseGitHubRepository(origin);
    if (originAddress.host !== host) throw repositoryError("本地 origin 主机与绑定不一致", 409, "repository_mismatch");
    const originRepo = (await client.request<RemoteRepository>(host, "GET", githubRepositoryPath(originAddress.fullName))).data;
    if (stableId(originRepo?.id) !== externalId) throw repositoryError("本地 origin 指向其他仓库", 409, "repository_mismatch");
  } else {
    checkout = path.resolve(request.checkout_path ?? request.repo);
    const identity = await readGitRepositoryIdentity(checkout);
    externalId = gitRepositoryKey(identity); fullName = path.basename(checkout); cloneUrl = checkout;
    target = request.target_branch ?? (await runGit(checkout, ["symbolic-ref", "--short", "HEAD"])).trim();
  }
  await runGit(checkout, ["check-ref-format", `refs/heads/${target}`]);
  const identity = await readGitRepositoryIdentity(checkout);
  if (request.mode === "local_git") await runGit(checkout, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${target}^{commit}`]);
  const connectionStatus = canPush ? "connected" : "permission_denied";
  const previous = db.$client.prepare("SELECT identity_json FROM repositories WHERE host=? AND external_id=?").get(host, externalId) as any;
  const directories = [...new Set([identity.real_path, ...(previous ? [JSON.parse(previous.identity_json).real_path as string].filter(directory => fs.existsSync(directory)) : [])])].sort();
  const save = async (index: number): Promise<Repository> => index < directories.length
    ? withGitLock(directories[index], () => save(index + 1))
    : (async () => {
      if (!sameGitRepository(identity, await readGitRepositoryIdentity(checkout))) throw repositoryError("绑定前仓库现场已变化", 409, "repository_mismatch");
      return db.$client.transaction(() => {
    const existing = db.$client.prepare("SELECT * FROM repositories WHERE host=? AND external_id=?").get(host, externalId) as any;
    if (existing && existing.mode !== request.mode) throw repositoryError("同一仓库已经按其他模式绑定", 409, "repository_mode_conflict");
    if (existing && !sameGitRepository(JSON.parse(existing.identity_json), identity) && !request.checkout_path) {
      throw repositoryError("绑定的本地仓库身份发生变化，请明确提供新的 checkout 后重新绑定", 409, "repository_mismatch");
    }
    const error = canPush ? null : "当前 GitHub 身份没有推送权限，远端写入已停用";
    if (existing) {
      const changed = existing.full_name !== fullName || existing.clone_url !== cloneUrl || existing.target_branch !== target
        || existing.checkout_path !== checkout || !sameGitRepository(JSON.parse(existing.identity_json), identity);
      db.$client.prepare(`UPDATE repositories SET full_name=?,clone_url=?,target_branch=?,checkout_path=?,identity_json=?,connection_login=?,can_push=?,
        connection_status=?,last_synced_at=?,next_sync_at=?,error=?,sync_failures=0,version=version+?,updated_at=? WHERE id=?`)
        .run(fullName, cloneUrl, target, checkout, JSON.stringify(identity), login, Number(canPush), connectionStatus, now,
          new Date(Date.parse(now) + 60_000).toISOString(), error, Number(changed), now, existing.id);
      return requireRepository(db, existing.id);
    }
    const id = newId();
    db.$client.prepare(`INSERT INTO repositories
      (id,workspace_id,mode,host,external_id,full_name,clone_url,target_branch,checkout_path,identity_json,connection_login,can_push,connection_status,last_synced_at,next_sync_at,error,sync_failures,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1,?,?)`)
      .run(id, workspace.id, request.mode, host, externalId, fullName, cloneUrl, target, checkout, JSON.stringify(identity), login,
        Number(canPush), connectionStatus, now, new Date(Date.parse(now) + 60_000).toISOString(), error, now, now);
    return requireRepository(db, id);
      }).immediate();
    })();
  return save(0);
}

interface RemoteIssue { id: number | string; number: number; html_url: string; title: string; body: string | null; state: "open" | "closed"; updated_at: string; pull_request?: unknown; }
export async function fetchSource(client: GitHubClient, repository: Repository, issueNumber: number): Promise<Omit<SourceSnapshot, "id" | "created_at">> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw repositoryError("Issue 编号必须是正整数", 400, "invalid_request");
  const remote = (await client.request<RemoteIssue>(repository.host, "GET", `${githubRepositoryPath(repository.full_name)}/issues/${issueNumber}`)).data;
  if (!remote || remote.pull_request) throw repositoryError("请选择 Issue，不能把 PR 当作工作项导入", 400, "not_an_issue");
  if (remote.number !== issueNumber || typeof remote.title !== "string" || !remote.title || remote.title.length > 1024
    || (remote.body !== null && typeof remote.body !== "string") || Buffer.byteLength(remote.body ?? "") > 256 * 1024
    || !["open", "closed"].includes(remote.state) || !Number.isFinite(Date.parse(remote.updated_at))) {
    throw repositoryError("Issue 响应缺少必要来源信息或超过大小限制", 502, "invalid_github_response");
  }
  let sourceUrl: URL;
  try { sourceUrl = new URL(remote.html_url); } catch { throw repositoryError("Issue 来源链接无效", 502, "invalid_github_response"); }
  if (sourceUrl.protocol !== "https:" || sourceUrl.host !== repository.host || sourceUrl.username || sourceUrl.password) {
    throw repositoryError("Issue 来源链接与仓库主机不一致", 502, "invalid_github_response");
  }
  const data = { repository_id: repository.id, external_id: stableId(remote.id), issue_number: issueNumber,
    url: remote.html_url, title: remote.title, body: remote.body ?? "", state: remote.state, source_updated_at: remote.updated_at };
  return { ...data, hash: canonicalJsonHash(data) };
}

export function storeSource(db: Db, source: Omit<SourceSnapshot, "id" | "created_at">): SourceSnapshot {
  const previous = db.$client.prepare("SELECT * FROM source_snapshots WHERE repository_id=? AND external_id=? AND hash=?")
    .get(source.repository_id, source.external_id, source.hash) as SourceSnapshot | undefined;
  if (previous) return previous;
  const snapshot: SourceSnapshot = { ...source, id: newId(), created_at: new Date().toISOString() };
  db.$client.prepare(`INSERT INTO source_snapshots(id,repository_id,external_id,issue_number,url,title,body,state,source_updated_at,hash,created_at)
    VALUES (@id,@repository_id,@external_id,@issue_number,@url,@title,@body,@state,@source_updated_at,@hash,@created_at)`).run(snapshot);
  return snapshot;
}

export function getIssueSource(db: Db, issueId: string): IssueSource | null {
  const link = db.$client.prepare("SELECT * FROM external_issues WHERE local_issue_id=?").get(issueId) as any;
  if (!link) return null;
  const read = (id: string) => db.$client.prepare("SELECT * FROM source_snapshots WHERE id=?").get(id) as SourceSnapshot;
  const accepted = read(link.accepted_snapshot_id), latest = read(link.latest_snapshot_id);
  return { repository_id: link.repository_id, external_id: link.external_id, issue_number: link.issue_number, url: link.url,
    accepted, latest, changed: accepted.hash !== latest.hash };
}

export async function importIssue(db: Db, client: GitHubClient, repositoryId: string, request: { issue_number: number; source_updated_at?: string }) {
  const repository = requireRepository(db, repositoryId);
  if (repository.mode !== "github_pr") throw repositoryError("本地 Git 仓库没有 GitHub Issue", 400, "invalid_repository_mode");
  await readRemoteRepository(db, client, repository);
  const source = await fetchSource(client, repository, request?.issue_number);
  if (request.source_updated_at !== undefined && source.source_updated_at !== request.source_updated_at) throw repositoryError("来源 Issue 已变化，请先刷新确认", 409, "source_changed");
  return db.$client.transaction(() => {
    const snapshot = storeSource(db, source);
    const existing = db.$client.prepare("SELECT * FROM external_issues WHERE repository_id=? AND external_id=?").get(repositoryId, source.external_id) as any;
    if (existing) {
      db.$client.prepare("UPDATE external_issues SET latest_snapshot_id=?,url=? WHERE repository_id=? AND external_id=?")
        .run(snapshot.id, snapshot.url, repositoryId, source.external_id);
      return { issue_id: existing.local_issue_id as string, source_snapshot_id: existing.accepted_snapshot_id as string, disposition: "existing" as const };
    }
    const { user } = seed(db);
    const issue = createIssueRow(db, repository.workspace_id, user.id, { title: snapshot.title, description: snapshot.body, status: "backlog", repo_path: repository.checkout_path });
    db.$client.prepare("UPDATE issues SET repository_id=?,source_snapshot_id=? WHERE id=?").run(repository.id, snapshot.id, issue.id);
    db.$client.prepare(`INSERT INTO external_issues(repository_id,external_id,local_issue_id,issue_number,url,accepted_snapshot_id,latest_snapshot_id)
      VALUES (?,?,?,?,?,?,?)`).run(repositoryId, source.external_id, issue.id, source.issue_number, source.url, snapshot.id, snapshot.id);
    return { issue_id: issue.id, source_snapshot_id: snapshot.id, disposition: "imported" as const };
  }).immediate();
}

export function acceptSource(db: Db, issueId: string, snapshotId: string) {
  if (typeof snapshotId !== "string" || !snapshotId) throw repositoryError("请选择要接受的来源版本", 400, "invalid_request");
  return db.$client.transaction(() => {
    const source = getIssueSource(db, issueId);
    if (!source) throw repositoryError("该 Issue 没有关联外部来源", 404, "source_not_found");
    if (source.latest.id !== snapshotId) throw repositoryError("来源版本已经变化，请刷新后确认", 409, "source_changed");
    db.$client.prepare("UPDATE external_issues SET accepted_snapshot_id=? WHERE local_issue_id=?").run(snapshotId, issueId);
    db.$client.prepare("UPDATE issues SET title=?,description=?,source_snapshot_id=?,updated_at=? WHERE id=?")
      .run(source.latest.title, source.latest.body, snapshotId, new Date().toISOString(), issueId);
    // 不调用 enqueue：在途 Task 使用已保存的输入，只有未来派发消费新接受版本。
    return { issue: getIssue(db, issueId), source: getIssueSource(db, issueId) };
  }).immediate();
}
