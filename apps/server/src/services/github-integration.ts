import { canonicalJsonHash, parseRepositorySnapshot, withGitLock, type BindRepositoryRequest, type DeliveryOperation,
  type GitHubCheck, type IntegrationActionRequest, type PullRequestRecord, type Repository, type ReviewGate } from "@anvil/core";
import { newId, type Db } from "../db/client.js";
import { git } from "../lib/git.js";
import { readGitRepositoryIdentity, sameGitRepository } from "../lib/git-repository.js";
import { GhClient, GitHubError, githubRepositoryPath, parseGitHubRepository, type GitHubClient } from "../lib/github.js";
import type { Hub } from "../ws/hub.js";
import { addComment, getIssue } from "./issues.js";
import { integrationDiagnostic } from "./integration-attempts.js";
import { acceptSource, bindRepository, fetchSource, getIssueSource, getRepository, importIssue, listRepositories,
  readRemoteRepository, repositoryError, requireRepository, storeSource, type RepositoryOptions } from "./repositories.js";

interface RemotePullRequest {
  id: number; number: number; html_url: string; state: "open" | "closed"; merged?: boolean; merged_at?: string | null;
  merge_commit_sha: string | null; body: string | null;
  head: { ref: string; sha: string; repo: { id: number } | null };
  base: { ref: string; repo: { id: number } };
}
interface PullRequestIntent {
  schema_version: 1; issue_id: string; branch: string; target_branch: string; head: string; evidence_version: string;
  repository: { id: string; host: string; external_id: string; full_name: string; clone_url: string; identity: Repository["identity"] };
  marker: string; recovery_of?: string;
  stable_evidence_version?: string;
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const time = (now: () => number) => new Date(now()).toISOString();
const authGit = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];

export function getTaskPullRequest(db: Db, taskId: string): PullRequestRecord | null {
  const row = db.$client.prepare("SELECT * FROM pull_request_links WHERE task_id=?").get(taskId) as any;
  if (!row) return null;
  const { checks_json, ...rest } = row;
  return { ...rest, checks: JSON.parse(checks_json) };
}
function operationFromRow(row: any): DeliveryOperation {
  const { payload_hash: _hash, intent_json, ...rest } = row;
  const intent = JSON.parse(intent_json) as PullRequestIntent;
  return { ...rest, expected_version: intent.evidence_version };
}
function operation(db: Db, id: string): DeliveryOperation {
  return operationFromRow(db.$client.prepare("SELECT * FROM delivery_operations WHERE id=?").get(id));
}
function taskRow(db: Db, id: string): any {
  const task = db.$client.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  if (!task) throw repositoryError("任务不存在", 404, "task_not_found");
  return task;
}

export function createGitHubService(db: Db, hub: Hub, client: GitHubClient = new GhClient(), options: RepositoryOptions = {}) {
  const runGit = options.git ?? git, now = options.now ?? Date.now;
  const serials = new Map<string, Promise<unknown>>(), manualRefresh = new Map<string, number>();
  const issueCursors = new Map<string, number>(), prCursors = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null, polling = false, stopped = false;
  const serial = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    const prior = serials.get(id) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(action); serials.set(id, next);
    try { return await next; } finally { if (serials.get(id) === next) serials.delete(id); }
  };
  const broadcastIssue = (id: string) => hub.broadcast({ type: "issue.updated", data: getIssue(db, id) });
  function recordSyncFailure(repositoryId: string, error: unknown): void {
    const row = db.$client.prepare("SELECT sync_failures FROM repositories WHERE id=?").get(repositoryId) as any;
    const failures = Math.min((row?.sync_failures ?? 0) + 1, 10);
    const delay = Math.max(Math.min(60_000 * 2 ** (failures - 1), 60 * 60_000), error instanceof GitHubError ? error.retryAfterMs : 0);
    const status = error instanceof GitHubError && error.code === "repository_renamed" ? "renamed"
      : error instanceof GitHubError && error.code === "github_permission_denied" ? "permission_denied" : "unavailable";
    db.$client.prepare("UPDATE repositories SET connection_status=?,error=?,next_sync_at=?,sync_failures=?,updated_at=? WHERE id=?")
      .run(status, integrationDiagnostic(error instanceof Error ? error.message : String(error)), new Date(now() + delay).toISOString(), failures, time(now), repositoryId);
  }
  function checkBackoff(repository: Repository): void {
    const row = db.$client.prepare("SELECT sync_failures FROM repositories WHERE id=?").get(repository.id) as any;
    if (row.sync_failures > 0 && repository.next_sync_at && Date.parse(repository.next_sync_at) > now()) {
      throw new GitHubError("同步正在退避，请等待下次同步时间", 429, "sync_backoff", true, Date.parse(repository.next_sync_at) - now());
    }
  }

  function validateGate(taskId: string, request: IntegrationActionRequest, gate: ReviewGate): Repository {
    if (!request || !sha(request.expected_head) || typeof request.expected_version !== "string" || !request.expected_version) {
      throw repositoryError("必须提交当前 HEAD 与证据版本", 400, "invalid_request");
    }
    if (gate.task_id !== taskId || gate.expected_head !== request.expected_head || gate.evidence_version !== request.expected_version) {
      throw repositoryError("任务证据或 HEAD 已变化，请重新审查", 409, "evidence_changed");
    }
    if (gate.mode !== "github_pr" || !gate.repository) throw repositoryError("任务没有 GitHub 仓库绑定", 409, "repository_mismatch");
    const blocker = gate.blockers.find(item => item.kind === "integrity");
    if (blocker) throw repositoryError(blocker.message, 409, blocker.code);
    const repository = requireRepository(db, gate.repository.id);
    if (!repository.can_push || repository.connection_status !== "connected") throw repositoryError("GitHub 连接或写权限不可用", 403, "github_permission_denied");
    if (repository.version !== gate.repository.version || repository.external_id !== gate.repository.external_id || repository.host !== gate.repository.host) {
      throw repositoryError("仓库绑定已变化，请重新审查", 409, "repository_mismatch");
    }
    return repository;
  }

  async function assertIdentity(repository: Repository): Promise<void> {
    if (!sameGitRepository(repository.identity, await readGitRepositoryIdentity(repository.checkout_path))) {
      throw repositoryError("本地仓库身份已变化", 409, "repository_mismatch");
    }
  }
  async function assertRemoteWrite(repository: Repository): Promise<void> {
    const remote = await readRemoteRepository(db, client, repository);
    const user = (await client.request<{ login: string }>(repository.host, "GET", "/user")).data;
    const canPush = remote.permissions?.push === true && !remote.archived && !remote.disabled;
    db.$client.prepare("UPDATE repositories SET connection_login=?,can_push=?,connection_status=?,error=?,updated_at=? WHERE id=?")
      .run(user?.login ?? null, Number(canPush), canPush ? "connected" : "permission_denied", canPush ? null : "当前 GitHub 身份没有推送权限", time(now), repository.id);
    if (!user?.login || !canPush) throw repositoryError("当前 GitHub 身份没有推送权限", 403, "github_permission_denied");
  }
  async function assertTransportTarget(repository: Repository, push: boolean): Promise<void> {
    // Git 仍会对显式 URL 应用 insteadOf/pushInsteadOf，解析有效地址后再确认稳定 ID。
    let effective = (await runGit(repository.checkout_path, ["ls-remote", "--get-url", repository.clone_url])).trim();
    if (push) {
      let configured = "";
      try { configured = await runGit(repository.checkout_path, ["config", "--null", "--get-regexp", "^url\\..*\\.pushinsteadof$"]); }
      catch (error: any) { if (error.code !== 1) throw error; }
      const rewrites = configured.split("\0").filter(Boolean).map(entry => {
        const split = entry.indexOf("\n"), key = entry.slice(0, split), prefix = entry.slice(split + 1);
        return { target: key.slice(4, -14), prefix };
      }).filter(rule => rule.prefix && repository.clone_url.startsWith(rule.prefix)).sort((a, b) => b.prefix.length - a.prefix.length);
      if (rewrites[0]) effective = rewrites[0].target + repository.clone_url.slice(rewrites[0].prefix.length);
    }
    const parsed = parseGitHubRepository(effective);
    if (parsed.host !== repository.host) throw repositoryError("Git 有效地址与绑定主机不一致", 409, "repository_mismatch");
    if (parsed.fullName !== repository.full_name) {
      const value = (await client.request<{ id: number }>(repository.host, "GET", githubRepositoryPath(parsed.fullName))).data;
      if (String(value?.id) !== repository.external_id) throw repositoryError("Git 地址重写指向其他仓库", 409, "repository_mismatch");
    }
  }
  async function fetchTarget(repository: Repository): Promise<void> {
    await assertTransportTarget(repository, false);
    await runGit(repository.checkout_path, ["check-ref-format", `refs/heads/${repository.target_branch}`]);
    // 仅更新远端跟踪引用；显式地址避免 origin 配置被替换，+ 允许如实观察远端回退。
    await runGit(repository.checkout_path, [...authGit, "fetch", "--no-tags", "--", repository.clone_url,
      `+refs/heads/${repository.target_branch}:refs/remotes/origin/${repository.target_branch}`]);
  }
  async function refreshGitFacts(repositoryId: string, taskId?: string): Promise<void> {
    return serial(repositoryId, async () => {
      const repository = requireRepository(db, repositoryId);
      checkBackoff(repository);
      try {
        await assertIdentity(repository);
        if (repository.mode !== "github_pr") return;
        await assertRemoteWrite(repository);
        await withGitLock(repository.identity.real_path, async () => { await assertIdentity(repository); await fetchTarget(repository); });
        if (taskId) {
          const link = getTaskPullRequest(db, taskId);
          if (link) {
            const remote = (await client.request<RemotePullRequest>(repository.host, "GET", `${githubRepositoryPath(repository.full_name)}/pulls/${link.number}`)).data;
            if (String(remote?.id) !== link.external_id) throw repositoryError("PR 稳定标识已变化", 409, "pull_request_mismatch");
            validatePull(repository, remote);
            savePull(taskId, repository, remote, await readChecks(repository, remote.head.sha));
          }
        }
        db.$client.prepare("UPDATE repositories SET last_synced_at=?,next_sync_at=?,sync_failures=0,error=NULL WHERE id=?")
          .run(time(now), new Date(now() + 60_000).toISOString(), repository.id);
      } catch (error) {
        recordSyncFailure(repositoryId, error);
        throw error;
      }
    });
  }
  function buildIntent(task: any, repository: Repository, request: IntegrationActionRequest): PullRequestIntent {
    const snapshot = parseRepositorySnapshot(task.repository_snapshot_json);
    if (!snapshot || snapshot.repository_id !== repository.id || snapshot.host !== repository.host || snapshot.external_id !== repository.external_id
      || repository.mode !== "github_pr" || snapshot.mode !== "github_pr" || getIssue(db, task.issue_id)?.repository_id !== repository.id
      || !sameGitRepository(snapshot.identity, repository.identity)
      || snapshot.target_branch !== repository.target_branch || !sameGitRepository(snapshot.identity, repository.identity)
      || task.repository_id !== repository.id || task.head_commit !== request.expected_head || task.target_branch !== snapshot.target_branch
      || typeof task.task_branch !== "string" || !task.task_branch || task.task_branch === task.target_branch) {
      throw repositoryError("任务与不可变仓库快照不一致", 409, "repository_mismatch");
    }
    return { schema_version: 1, issue_id: task.issue_id, branch: task.task_branch, target_branch: snapshot.target_branch,
      head: request.expected_head, evidence_version: request.expected_version,
      repository: { id: repository.id, host: repository.host, external_id: repository.external_id, full_name: repository.full_name,
        clone_url: repository.clone_url, identity: repository.identity }, marker: `<!-- anvil:issue:${task.issue_id} -->` };
  }
  function validatePull(repository: Repository, remote: RemotePullRequest, intent?: PullRequestIntent): void {
    if (!remote || !Number.isSafeInteger(remote.id) || !Number.isSafeInteger(remote.number) || remote.number <= 0
      || !sha(remote.head?.sha) || String(remote.base?.repo?.id) !== repository.external_id
      || String(remote.head?.repo?.id) !== repository.external_id || !["open", "closed"].includes(remote.state)
      || remote.base.ref !== (intent?.target_branch ?? repository.target_branch)
      || (intent && remote.head.ref !== intent.branch)) throw repositoryError("PR 身份、分支或仓库不一致", 409, "pull_request_mismatch");
    const url = new URL(remote.html_url);
    if (url.protocol !== "https:" || url.host !== repository.host || url.username || url.password) throw repositoryError("PR 链接无效", 502, "invalid_github_response");
  }
  async function findPull(repository: Repository, intent: PullRequestIntent): Promise<RemotePullRequest | null> {
    const endpoint = githubRepositoryPath(repository.full_name), candidates: RemotePullRequest[] = [];
    // 查询全部状态，否则请求成功后立即被关闭/合并会被误当成不存在并重复创建。
    for (let page = 1; page <= 5; page++) {
      const query = new URLSearchParams({ state: "all", head: `${repository.full_name.split("/")[0]}:${intent.branch}`, base: intent.target_branch, per_page: "100", page: String(page) });
      const list = (await client.request<RemotePullRequest[]>(repository.host, "GET", `${endpoint}/pulls?${query}`)).data;
      if (!Array.isArray(list)) throw repositoryError("PR 查询结果无效", 502, "invalid_github_response");
      for (const entry of list) {
        validatePull(repository, entry, intent);
        // 固定分支对应的其他用途 PR 也阻塞，不借 Anvil marker 覆盖它。
        candidates.push(entry);
      }
      if (list.length < 100) break;
      if (page === 5) throw repositoryError("PR 查询超过上限，无法确认唯一结果", 409, "pull_request_ambiguous");
    }
    if (candidates.length > 1) throw repositoryError("同一分支存在多个 PR，需人工确认关联", 409, "pull_request_ambiguous");
    const found = candidates[0];
    if (found && !found.body?.includes(intent.marker)) throw repositoryError("任务分支已有其他来源的 PR，停止自动关联", 409, "pull_request_conflict");
    return found ?? null;
  }
  async function readHead(repository: Repository, branch: string): Promise<string | null> {
    try {
      const value = (await client.request<{ object: { sha: string } }>(repository.host, "GET", `${githubRepositoryPath(repository.full_name)}/git/ref/heads/${encodeURIComponent(branch)}`)).data;
      if (!sha(value?.object?.sha)) throw repositoryError("远端分支响应无效", 502, "invalid_github_response");
      return value.object.sha;
    } catch (error) { if (error instanceof GitHubError && error.http === 404) return null; throw error; }
  }
  function savePull(taskId: string, repository: Repository, remote: RemotePullRequest, checks: GitHubCheck[] = []): PullRequestRecord {
    validatePull(repository, remote);
    const previous = getTaskPullRequest(db, taskId);
    if (previous && previous.external_id !== String(remote.id)) throw repositoryError("任务已经关联其他 PR", 409, "pull_request_conflict");
    const record: PullRequestRecord = { id: previous?.id ?? newId(), repository_id: repository.id, task_id: taskId, external_id: String(remote.id),
      number: remote.number, url: remote.html_url, head_ref: remote.head.ref, head_sha: remote.head.sha, base_ref: remote.base.ref,
      state: remote.merged === true || remote.merged_at ? "merged" : remote.state, merge_commit: remote.merge_commit_sha,
      last_synced_at: time(now), checks };
    db.$client.prepare(`INSERT INTO pull_request_links(id,repository_id,task_id,external_id,number,url,head_ref,head_sha,base_ref,state,merge_commit,last_synced_at,checks_json)
      VALUES (@id,@repository_id,@task_id,@external_id,@number,@url,@head_ref,@head_sha,@base_ref,@state,@merge_commit,@last_synced_at,@checks_json)
      ON CONFLICT(task_id) DO UPDATE SET head_sha=excluded.head_sha,state=excluded.state,merge_commit=excluded.merge_commit,last_synced_at=excluded.last_synced_at,checks_json=excluded.checks_json`)
      .run({ ...record, checks_json: JSON.stringify(checks) });
    return record;
  }

  async function performPull(taskId: string, request: IntegrationActionRequest, key: string, checkGate: () => Promise<ReviewGate>, recoveryId?: string): Promise<DeliveryOperation> {
    if (typeof key !== "string" || key.length < 1 || key.length > 200 || /[\r\n]/.test(key)) throw repositoryError("需要有效的幂等键", 400, "invalid_request");
    const task = taskRow(db, taskId), repository = requireRepository(db, task.repository_id);
    return serial(repository.id, async () => {
      await assertIdentity(repository);
      return withGitLock(repository.identity.real_path, async () => {
        await assertIdentity(repository);
        const payloadHash = canonicalJsonHash({ request, repository_id: repository.id, recovery_of: recoveryId ?? null });
        const sameKey = db.$client.prepare("SELECT * FROM delivery_operations WHERE task_id=? AND action='pull_request' AND request_key=?").get(taskId, key) as any;
        if (sameKey) {
          if (sameKey.payload_hash !== payloadHash) throw repositoryError("幂等键已经用于不同请求", 409, "idempotency_conflict");
          return operationFromRow(sameKey);
        }
        checkBackoff(requireRepository(db, repository.id));
        try { await assertRemoteWrite(repository); await fetchTarget(repository); }
        catch (error) { recordSyncFailure(repository.id, error); throw error; }
        let checked = await checkGate();
        if (recoveryId) {
          const priorRecovery = db.$client.prepare("SELECT * FROM delivery_operations WHERE id=? AND task_id=? AND action='pull_request'").get(recoveryId, taskId) as any;
          if (priorRecovery) {
            const original = JSON.parse(priorRecovery.intent_json) as PullRequestIntent;
            const remote = await findPull(repository, original);
            // 响应丢失后 PR 可能已合并。只查询已存在的同版本对象，可豁免由本次合并造成的目标前进。
            if (remote && remote.head.sha === original.head && (remote.state === "closed" || remote.merged || remote.merged_at)
              && request.expected_version === original.evidence_version
              && (checked.stable_evidence_version ?? checked.evidence_version) === (original.stable_evidence_version ?? original.evidence_version)) {
              checked = { ...checked, evidence_version: request.expected_version,
                blockers: checked.blockers.filter(blocker => !["base_advanced", "pull_request_closed"].includes(blocker.code)) };
            }
          }
        }
        const currentRepository = validateGate(taskId, request, checked);
        const currentTask = taskRow(db, taskId), intent = buildIntent(currentTask, currentRepository, request);
        intent.stable_evidence_version = checked.stable_evidence_version ?? checked.evidence_version;
        if (recoveryId) {
          const saved = db.$client.prepare("SELECT intent_json FROM delivery_operations WHERE id=? AND task_id=? AND action='pull_request'").get(recoveryId, taskId) as any;
          if (!saved) throw repositoryError("恢复操作不存在", 404, "operation_not_found");
          const original = JSON.parse(saved.intent_json) as PullRequestIntent;
          intent.branch = original.branch;
          intent.marker = original.marker;
        }
        const previousLink = db.$client.prepare(`SELECT p.* FROM pull_request_links p JOIN tasks t ON t.id=p.task_id
          WHERE t.issue_id=? AND p.repository_id=? AND p.state='open' ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1`).get(task.issue_id, repository.id) as any;
        if (!recoveryId && previousLink && previousLink.task_id !== taskId) {
          const previousRemote = (await client.request<RemotePullRequest>(repository.host, "GET", `${githubRepositoryPath(repository.full_name)}/pulls/${previousLink.number}`)).data;
          validatePull(currentRepository, previousRemote);
          if (String(previousRemote.id) !== previousLink.external_id) throw repositoryError("返工 PR 的稳定身份发生变化", 409, "pull_request_mismatch");
          if (previousRemote.state === "open" && !previousRemote.merged && !previousRemote.merged_at) {
            if (!previousRemote.body?.includes(intent.marker)) throw repositoryError("已有 PR 不属于此工作项", 409, "pull_request_conflict");
            try { await runGit(repository.checkout_path, ["merge-base", "--is-ancestor", previousRemote.head.sha, intent.head]); }
            catch { throw repositoryError("返工提交没有包含开放 PR 的最新版本，请重新执行并整合该分支；不会强制推送", 409, "rework_history_conflict"); }
            intent.branch = previousRemote.head.ref;
          }
        }
        await runGit(repository.checkout_path, ["check-ref-format", `refs/heads/${intent.branch}`]);
        const otherActive = db.$client.prepare("SELECT intent_json FROM delivery_operations WHERE repository_id=? AND task_id<>? AND action='pull_request' AND state IN ('prepared','unknown')").all(repository.id, taskId) as any[];
        if (otherActive.some(row => (JSON.parse(row.intent_json) as PullRequestIntent).branch === intent.branch)) {
          throw repositoryError("同一分支的历史任务仍有未确认操作", 409, "recovery_required");
        }
        const prior = db.$client.prepare("SELECT * FROM delivery_operations WHERE task_id=? AND action='pull_request' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId) as any;
        let recovery: any;
        if (recoveryId) {
          recovery = db.$client.prepare("SELECT * FROM delivery_operations WHERE id=? AND task_id=? AND action='pull_request'").get(recoveryId, taskId) as any;
          if (!recovery || !["unknown", "failed", "prepared"].includes(recovery.state) || prior?.id !== recovery.id) throw repositoryError("只能恢复最近一次未完成操作", 409, "operation_conflict");
          const original = JSON.parse(recovery.intent_json) as PullRequestIntent;
          if (original.head !== intent.head || original.evidence_version !== intent.evidence_version || original.branch !== intent.branch
            || original.target_branch !== intent.target_branch || original.repository.host !== intent.repository.host
            || original.repository.external_id !== intent.repository.external_id || !sameGitRepository(original.repository.identity, intent.repository.identity)) {
            throw repositoryError("旧操作绑定的 HEAD、证据或仓库已变化，不能重放", 409, "operation_stale");
          }
          intent.recovery_of = recovery.id;
        } else if (prior && prior.state !== "succeeded") {
          throw repositoryError("上次操作尚需明确恢复，不能用新幂等键绕过", 409, "recovery_required");
        } else if (prior?.state === "succeeded") return operationFromRow(prior);
        // 在新操作落盘前只查询。查询失败时不释放旧 unknown 守卫。
        let found = await findPull(currentRepository, intent);
        const remoteHead = await readHead(currentRepository, intent.branch);
        if (found && found.head.sha !== intent.head && (found.state !== "open" || found.merged_at || found.merged)) {
          throw repositoryError("原 PR 已关闭且版本不同，不能改写关联", 409, "pull_request_conflict");
        }
        const id = newId(), created = time(now);
        const decision = db.$client.prepare("SELECT id FROM review_decisions WHERE task_id=? AND head_commit=? AND evidence_version=?").get(taskId, intent.head, intent.evidence_version) as any;
        db.$client.transaction(() => {
          if (recovery) db.$client.prepare("UPDATE delivery_operations SET state='failed',error=?,updated_at=? WHERE id=?")
            .run(integrationDiagnostic(`${recovery.error ?? "原操作未完成"}；已查询远端，恢复操作 ${id}`), created, recovery.id);
          db.$client.prepare(`INSERT INTO delivery_operations(id,task_id,repository_id,decision_id,action,state,expected_head,request_key,payload_hash,intent_json,result_json,error,created_at,updated_at)
            VALUES (?,?,?,?,'pull_request','prepared',?,?,?,?,NULL,NULL,?,?)`)
            .run(id, taskId, repository.id, decision?.id ?? null, intent.head, key, payloadHash, JSON.stringify(intent), created, created);
        }).immediate();
        let wrote = false;
        try {
          const terminalMatch = found && (found.state === "closed" || found.merged || found.merged_at) && found.head.sha === intent.head;
          if (remoteHead !== intent.head && !terminalMatch) {
            if (found && (found.merged || found.merged_at || found.state !== "open")) throw repositoryError("PR 已关闭，禁止推送后续版本", 409, "pull_request_closed");
            // SHA 是唯一写入源，不使用会浮动的本地分支；没有 force 参数。
            await runGit(repository.checkout_path, ["cat-file", "-e", `${intent.head}^{commit}`]);
            await assertTransportTarget(currentRepository, true);
            validateGate(taskId, request, await checkGate());
            buildIntent(taskRow(db, taskId), requireRepository(db, repository.id), request);
            wrote = true;
            await runGit(repository.checkout_path, [...authGit, "push", "--porcelain", "--", currentRepository.clone_url, `${intent.head}:refs/heads/${intent.branch}`]);
            if (await readHead(currentRepository, intent.branch) !== intent.head) throw repositoryError("推送后的远端 HEAD 尚不能确认", 409, "remote_head_unknown");
          }
          // push 超时重试时永远再次查询 PR，响应丢失不会直接重复 POST。
          found = await findPull(currentRepository, intent);
          if (!found) {
            validateGate(taskId, request, await checkGate());
            buildIntent(taskRow(db, taskId), requireRepository(db, repository.id), request);
            wrote = true;
            const issue = getIssue(db, intent.issue_id);
            found = (await client.request<RemotePullRequest>(repository.host, "POST", `${githubRepositoryPath(repository.full_name)}/pulls`, {
              title: (issue?.title ?? `Anvil 任务 ${taskId}`).slice(0, 240), head: intent.branch, base: intent.target_branch,
              body: `Anvil 任务 ${taskId}\n\n${intent.marker}\n<!-- anvil:task:${taskId} -->`,
            })).data;
          } else found = (await client.request<RemotePullRequest>(repository.host, "GET", `${githubRepositoryPath(repository.full_name)}/pulls/${found.number}`)).data;
          validatePull(currentRepository, found, intent);
          if (found.head.sha !== intent.head) throw repositoryError("PR HEAD 与固定交付版本不一致", 409, "remote_head_unknown");
          db.$client.transaction(() => {
            const record = savePull(taskId, currentRepository, found!);
            db.$client.prepare("UPDATE delivery_operations SET state='succeeded',result_json=?,updated_at=? WHERE id=?")
              .run(JSON.stringify(record), time(now), id);
          }).immediate();
        } catch (error) {
          // 凡已尝试远端写入均保守为 unknown；恢复查询明确后才产生新的尝试。
          db.$client.prepare("UPDATE delivery_operations SET state=?,error=?,updated_at=? WHERE id=?")
            .run(wrote ? "unknown" : "failed", integrationDiagnostic(error instanceof Error ? error.message : String(error)), time(now), id);
        }
        return operation(db, id);
      });
    });
  }

  async function readChecks(repository: Repository, head: string): Promise<GitHubCheck[]> {
    const endpoint = `${githubRepositoryPath(repository.full_name)}/commits/${head}`;
    const runs = (await client.request<{ check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }> }>(repository.host, "GET", `${endpoint}/check-runs?per_page=100`)).data;
    const status = (await client.request<{ statuses: Array<{ context: string; state: string; target_url: string | null }> }>(repository.host, "GET", `${endpoint}/status?per_page=100`)).data;
    if (!Array.isArray(runs?.check_runs) || !Array.isArray(status?.statuses)) throw repositoryError("GitHub 检查响应无效", 502, "invalid_github_response");
    return [...runs.check_runs.map(item => ({ name: item.name, status: item.status, conclusion: item.conclusion, url: item.html_url })),
      ...status.statuses.map(item => ({ name: item.context, status: item.state, conclusion: item.state === "pending" ? null : item.state, url: item.target_url }))];
  }

  async function completeMerged(repository: Repository, link: PullRequestRecord, remote: RemotePullRequest): Promise<void> {
    if (link.state !== "merged" || !sha(link.merge_commit)) return;
    const task = taskRow(db, link.task_id), snapshot = parseRepositorySnapshot(task.repository_snapshot_json);
    const decision = db.$client.prepare("SELECT * FROM review_decisions WHERE task_id=?").get(task.id) as any;
    const latestTask = () => (db.$client.prepare("SELECT id FROM tasks WHERE issue_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(task.issue_id) as any)?.id;
    if (!snapshot || snapshot.repository_id !== repository.id || snapshot.host !== repository.host || snapshot.external_id !== repository.external_id
      || repository.mode !== "github_pr" || snapshot.mode !== "github_pr" || getIssue(db, task.issue_id)?.repository_id !== repository.id
      || !sameGitRepository(snapshot.identity, repository.identity)
      || snapshot.target_branch !== link.base_ref || task.head_commit !== link.head_sha || !decision || !["approved", "overridden"].includes(decision.result)
      || decision.repository_id !== repository.id || decision.head_commit !== link.head_sha || latestTask() !== task.id) return;
    validatePull(repository, remote);
    await assertIdentity(repository);
    await withGitLock(repository.identity.real_path, async () => {
      await assertIdentity(repository);
      // 从显式绑定地址取目标分支，不信任可能被改写的 origin，也不修改用户当前工作树。
      const targetRef = `refs/anvil/remote-target/${repository.id}`;
      await assertTransportTarget(repository, false);
      await runGit(repository.checkout_path, [...authGit, "fetch", "--no-tags", "--", repository.clone_url, `+refs/heads/${link.base_ref}:${targetRef}`]);
      await runGit(repository.checkout_path, ["merge-base", "--is-ancestor", link.merge_commit!, targetRef]);
      const changed = db.$client.transaction(() => {
        if (latestTask() !== task.id) return false;
        const issue = getIssue(db, task.issue_id);
        if (!issue || issue.status === "done") return false;
        db.$client.prepare("UPDATE issues SET status='done',updated_at=? WHERE id=?").run(time(now), task.issue_id);
        addComment(db, task.issue_id, { author_type: "system", author_id: "system", type: "status_change",
          body: `已核实 PR #${link.number} 合并到 ${link.base_ref}，人工裁决对应 ${link.head_sha.slice(0, 12)}。` });
        return true;
      }).immediate();
      if (changed) broadcastIssue(task.issue_id);
    });
  }

  async function refresh(repositoryId: string, manual: boolean): Promise<Repository> {
    if (manual) {
      const last = manualRefresh.get(repositoryId);
      if (last !== undefined && now() - last < 10_000) throw new GitHubError("手动同步过于频繁，请稍后重试", 429, "sync_cooldown", true, 10_000 - (now() - last));
      manualRefresh.set(repositoryId, now());
    }
    return serial(repositoryId, async () => {
      const repository = requireRepository(db, repositoryId);
      const row = db.$client.prepare("SELECT sync_failures FROM repositories WHERE id=?").get(repositoryId) as any;
      // rate-limit 的 next_sync_at 对手动刷新同样有效，不能靠按钮绕过服务端退避。
      if (row.sync_failures > 0 && repository.next_sync_at && Date.parse(repository.next_sync_at) > now()) {
        if (manual) throw new GitHubError("同步正在退避，请等待下次同步时间", 429, "sync_backoff", true, Date.parse(repository.next_sync_at) - now());
        return repository;
      }
      try {
        await assertIdentity(repository);
        let login = repository.connection_login, canPush = repository.can_push;
        if (repository.mode === "github_pr") {
          const remote = await readRemoteRepository(db, client, repository);
          const user = (await client.request<{ login: string }>(repository.host, "GET", "/user")).data;
          login = user?.login ?? null; canPush = remote.permissions?.push === true && !remote.archived && !remote.disabled && !!login;
          const sources = db.$client.prepare("SELECT * FROM external_issues WHERE repository_id=? ORDER BY local_issue_id").all(repository.id) as any[];
          const issueOffset = issueCursors.get(repository.id) ?? 0;
          for (let index = 0; index < Math.min(sources.length, 20); index++) {
            const source = sources[(issueOffset + index) % sources.length];
            const latest = await fetchSource(client, repository, source.issue_number);
            if (latest.external_id !== source.external_id) throw repositoryError("Issue 稳定标识已变化", 409, "source_mismatch");
            db.$client.transaction(() => {
              const saved = storeSource(db, latest);
              db.$client.prepare("UPDATE external_issues SET latest_snapshot_id=?,url=? WHERE repository_id=? AND external_id=?")
                .run(saved.id, saved.url, repository.id, source.external_id);
            }).immediate();
            broadcastIssue(source.local_issue_id);
          }
          issueCursors.set(repository.id, sources.length ? (issueOffset + 20) % sources.length : 0);
          const links = db.$client.prepare("SELECT * FROM pull_request_links WHERE repository_id=? ORDER BY task_id").all(repository.id) as any[];
          const prOffset = prCursors.get(repository.id) ?? 0;
          for (let index = 0; index < Math.min(links.length, 10); index++) {
            const link = links[(prOffset + index) % links.length];
            const pull = (await client.request<RemotePullRequest>(repository.host, "GET", `${githubRepositoryPath(repository.full_name)}/pulls/${link.number}`)).data;
            if (String(pull?.id) !== link.external_id) throw repositoryError("PR 稳定标识已变化", 409, "pull_request_mismatch");
            validatePull(repository, pull);
            const saved = savePull(link.task_id, repository, pull, await readChecks(repository, pull.head.sha));
            await completeMerged(repository, saved, pull);
          }
          prCursors.set(repository.id, links.length ? (prOffset + 10) % links.length : 0);
        }
        db.$client.prepare("UPDATE repositories SET connection_login=?,can_push=?,connection_status=?,last_synced_at=?,next_sync_at=?,error=?,sync_failures=0,updated_at=? WHERE id=?")
          .run(login, Number(canPush), canPush ? "connected" : "permission_denied", time(now), new Date(now() + 60_000).toISOString(), canPush ? null : "当前 GitHub 身份没有推送权限", time(now), repositoryId);
      } catch (error) {
        recordSyncFailure(repositoryId, error);
      }
      return requireRepository(db, repositoryId);
    });
  }

  const service = {
    listRepositories: () => listRepositories(db), getRepository: (id: string) => getRepository(db, id),
    bindRepository: (request: BindRepositoryRequest) => serial("binding", () => bindRepository(db, client, request, options)),
    importIssue: (id: string, request: { issue_number: number; source_updated_at?: string }) => serial(id, async () => {
      const result = await importIssue(db, client, id, request); broadcastIssue(result.issue_id); return result;
    }),
    getIssueSource: (id: string) => getIssueSource(db, id),
    acceptSource: (id: string, snapshotId: string) => { const result = acceptSource(db, id, snapshotId); broadcastIssue(id); return result; },
    getTaskPullRequest: (id: string) => getTaskPullRequest(db, id),
    refreshRepository: (id: string) => refresh(id, true),
    refreshGitFacts,
    createPullRequest: (id: string, request: IntegrationActionRequest, key: string, checkGate: () => Promise<ReviewGate>) => performPull(id, request, key, checkGate),
    recoverPullRequest: (id: string, operationId: string, request: IntegrationActionRequest, key: string, checkGate: () => Promise<ReviewGate>) => performPull(id, request, key, checkGate, operationId),
    start: () => {
      if (timer) return; stopped = false;
      timer = setInterval(() => {
        if (polling || stopped) return; polling = true;
        void (async () => {
          for (const repository of listRepositories(db)) {
            if (stopped) break;
            if (!repository.next_sync_at || Date.parse(repository.next_sync_at) <= now()) await refresh(repository.id, false);
          }
        })().catch(() => { /* 单仓错误保存在仓库连接状态；关闭期间不制造未处理拒绝。 */ }).finally(() => { polling = false; });
      }, 60_000);
      timer.unref();
    },
    stop: async () => { stopped = true; if (timer) clearInterval(timer); timer = null; await Promise.allSettled([...serials.values()]); },
  };
  return service;
}
export type GitHubService = ReturnType<typeof createGitHubService>;
