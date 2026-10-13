import fs from "node:fs";
import path from "node:path";
import { canonicalJsonHash, parseRepositorySnapshot, withGitLock } from "@anvil/core";
import type { GateBlocker, ReviewGate, ReviewDecision, SubmitDecisionRequest, IntegrationActionRequest, DeliveryOperation, TaskIntegration, RepositorySnapshot, PullRequestRecord } from "@anvil/core";
import type { Db } from "../db/client.js";
import { newId, seed } from "../db/client.js";
import { git, ensureGitAvailable } from "../lib/git.js";
import { readGitRepositoryIdentity, sameGitRepository } from "../lib/git-repository.js";
import { getTask } from "./tasks.js";
import { getIssue, addComment, enqueueForIssue } from "./issues.js";
import { getDeliveryReport } from "./delivery.js";
import { getRepository, getIssueSource } from "./repositories.js";
import { integrationDiagnostic } from "./integration-attempts.js";
import { excludeReviewMeasurement } from "./review-measurements.js";

export function integrationError(code: string, message: string, http = 409): never {
  throw Object.assign(new Error(message), { code, http, retryable: false });
}
const fullSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
export function requestKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) integrationError("idempotency_key_required", "请提供 8–128 位操作标识", 400);
  return value;
}
export function readDecision(db: Db, taskId: string): ReviewDecision | null {
  const row = db.$client.prepare("SELECT id,task_id,actor_id,result,reason,head_commit,evidence_version,request_key,created_at FROM review_decisions WHERE task_id=?").get(taskId);
  return row as ReviewDecision | undefined ?? null;
}
export function readOperations(db: Db, taskId: string): DeliveryOperation[] {
  return (db.$client.prepare("SELECT id,task_id,repository_id,decision_id,action,state,expected_head,request_key,result_json,error,created_at,updated_at,intent_json FROM delivery_operations WHERE task_id=? ORDER BY created_at DESC,rowid DESC").all(taskId) as any[])
    .map(({ intent_json, ...row }) => { const intent = JSON.parse(intent_json); return { ...row, expected_version: intent.expected_version ?? intent.evidence_version }; });
}
export function readPullRequest(db: Db, taskId: string): PullRequestRecord | null {
  const row = db.$client.prepare("SELECT * FROM pull_request_links WHERE task_id=?").get(taskId) as any;
  if (!row) return null;
  const { checks_json, ...data } = row;
  return { ...data, checks: JSON.parse(checks_json) };
}
export async function currentCommit(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}
async function operationInProgress(repo: string): Promise<boolean> {
  const directory = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
  return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer", "index.lock", "BISECT_LOG"]
    .some(name => fs.existsSync(path.join(directory, name)));
}

/** 每次请求读取 Git 事实；保存过的 ready/Decision 都不能替代这里的实时结果。 */
export async function getReviewGate(db: Db, taskId: string): Promise<ReviewGate> {
  const task = getTask(db, taskId);
  if (!task) integrationError("task_not_found", "任务不存在", 404);
  const blockers: GateBlocker[] = [];
  const block = (code: string, message: string, kind: GateBlocker["kind"] = "integrity") => blockers.push({ code, message, kind });
  let snapshot: RepositorySnapshot | null = null;
  try { snapshot = parseRepositorySnapshot(task.repository_snapshot_json); }
  catch { block("repository_snapshot_invalid", "原始仓库快照已损坏，不能使用当前 Issue 替代"); }
  if (!snapshot) block("repository_binding_required", "历史任务缺少原始仓库快照，请绑定仓库后重新执行");
  const repository = snapshot ? getRepository(db, snapshot.repository_id) : null;
  const report = getDeliveryReport(db, taskId);
  const run = task.verification_run_id ? db.$client.prepare("SELECT * FROM verification_runs WHERE id=? AND task_id=?").get(task.verification_run_id, taskId) as any : null;
  const checks = run ? db.$client.prepare("SELECT * FROM verification_checks WHERE verification_run_id=? ORDER BY seq").all(run.id) as any[] : [];
  const facts: Record<string, unknown> = {};
  const pull = readPullRequest(db, taskId);
  if (pull) {
    if (pull.head_sha !== task.head_commit) block("pr_head_changed", "GitHub PR 的 HEAD 已变化，旧交付不能继续批准");
    if (snapshot && (pull.repository_id !== snapshot.repository_id || pull.base_ref !== snapshot.target_branch)) block("pr_target_changed", "PR 仓库或目标与原始快照不符");
    if (pull.state === "closed") block("pull_request_closed", "PR 已关闭且未合并，请明确重新执行");
  }
  if (task.status !== "completed" || task.delivery_contract_version !== 2) block("task_not_reviewable", "只有完成的 v2 任务可提交新版裁决");
  if (!fullSha(task.base_commit) || !fullSha(task.head_commit) || !task.task_branch || !task.target_branch || !task.work_dir) block("anchors_missing", "任务的分支、工作区或完整提交锚点缺失");
  if (!task.delivered_at || !report || report.schema_version !== 1) block("report_missing", "缺少已提交的交付报告");
  else if (report.report_head_commit.toLowerCase() !== task.head_commit?.toLowerCase()) block("report_head_mismatch", "交付报告不属于当前交付提交");
  if (task.worktree_clean !== true) block("worktree_was_dirty", "Runner 完成时工作区不是干净状态");
  if (!run) block("verification_missing", "缺少 Runner 验证记录");
  else {
    if (run.base_commit !== task.base_commit || run.status !== task.verification_status) block("verification_mismatch", "验证记录与任务锚点不一致");
    if (run.verification_sha && run.verification_sha !== task.head_commit) block("verification_stale", "验证提交与交付提交不一致");
    if (["dirty", "stale", "legacy"].includes(run.status)) block("verification_integrity", "验证存在工作区或提交完整性问题");
    else if (["failed", "partial", "not_configured"].includes(run.status)) {
      let errorCode: unknown;
      try { errorCode = JSON.parse(task.result_json ?? "{}").verification?.error_code; } catch { /* 下方按实际 Run 检查 */ }
      if (errorCode) block("verification_invalid", "验证策略或执行器出错，须修复并重新执行");
      else block("verification_quality", `Runner 验证状态为 ${run.status}，普通批准不可用`, "quality");
    } else if (run.status !== "passed" || run.verification_sha !== task.head_commit || !run.policy_hash
      || !checks.length || checks.some(check => check.status !== "passed" || check.exit_code !== 0)) {
      block("verification_invalid", "通过记录缺少完整检查或与检查结果矛盾");
    }
  }
  if (snapshot) {
    const issue = getIssue(db, task.issue_id);
    if (!repository || task.repository_id !== snapshot.repository_id || issue?.repository_id !== snapshot.repository_id) block("repository_changed", "仓库绑定已变化，旧任务不能继续裁决");
    if (repository && (repository.mode !== snapshot.mode || repository.host !== snapshot.host || repository.external_id !== snapshot.external_id
      || repository.target_branch !== snapshot.target_branch || !sameGitRepository(repository.identity, snapshot.identity))) block("repository_changed", "仓库模式、身份或目标与任务快照不一致");
    if (snapshot.mode === "github_pr" && repository && (repository.connection_status !== "connected" || !repository.can_push)) block("connection_unavailable", repository.error || "GitHub 连接或写权限不可用");
    if (task.target_branch !== snapshot.target_branch) block("target_mismatch", "任务目标与原始快照不一致");
    const latest = db.$client.prepare("SELECT id FROM tasks WHERE issue_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(task.issue_id) as any;
    if (latest?.id !== taskId) block("task_superseded", "已有较新的任务，请审查最新交付");
    try {
      await ensureGitAvailable();
      const identity = await readGitRepositoryIdentity(snapshot.checkout_path);
      facts.repository_identity = identity;
      if (!sameGitRepository(identity, snapshot.identity)) block("repository_mismatch", "实际仓库已被替换，与原始文件身份不符");
      const targetRef = snapshot.mode === "github_pr" ? `refs/remotes/origin/${snapshot.target_branch}` : `refs/heads/${snapshot.target_branch}`;
      facts.target_head = await currentCommit(snapshot.checkout_path, targetRef);
      if (facts.target_head !== task.base_commit) block("base_advanced", "目标分支已前进，请显式重新执行任务，旧验证保持原样");
      if (snapshot.mode === "local_git") {
        facts.target_branch = (await git(snapshot.checkout_path, ["symbolic-ref", "--short", "HEAD"])).trim();
        facts.target_clean = !(await git(snapshot.checkout_path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
        if (facts.target_branch !== snapshot.target_branch || !facts.target_clean) block("target_worktree_invalid", "目标工作区分支不符或存在未提交文件");
      }
      if (await operationInProgress(snapshot.checkout_path)) block("git_operation_in_progress", "目标仓库存在未结束的 Git 操作");
      if (task.work_dir) {
        const taskIdentity = await readGitRepositoryIdentity(task.work_dir);
        if (!sameGitRepository(taskIdentity, snapshot.identity)) block("repository_mismatch", "任务工作区与原始仓库不符");
        facts.task_branch = (await git(task.work_dir, ["symbolic-ref", "--short", "HEAD"])).trim();
        facts.task_head = await currentCommit(task.work_dir, "HEAD");
        facts.task_ref_head = await currentCommit(snapshot.checkout_path, `refs/heads/${task.task_branch}`);
        facts.task_clean = !(await git(task.work_dir, ["status", "--porcelain=v1", "--untracked-files=all"])).trim();
        if (facts.task_branch !== task.task_branch || facts.task_head !== task.head_commit || facts.task_ref_head !== task.head_commit) block("head_changed", "任务分支或 HEAD 已变化，旧交付不能批准");
        if (!facts.task_clean || await operationInProgress(task.work_dir)) block("worktree_dirty", "任务工作区有未提交内容或未结束的 Git 操作");
        for (const sha of [task.base_commit, task.head_commit]) if (fullSha(sha) && (await git(task.work_dir, ["cat-file", "-t", sha])).trim() !== "commit") block("object_missing", "固定提交对象不存在");
        if (fullSha(task.base_commit) && fullSha(task.head_commit)) {
          try { await git(task.work_dir, ["merge-base", "--is-ancestor", task.base_commit, task.head_commit]); }
          catch { block("base_not_in_head", "任务分支尚未包含本次目标基线，请重新执行并解决整合问题"); }
        }
      }
    } catch (error) { block("git_unavailable", `无法确认 Git 现场：${integrationDiagnostic(String((error as Error).message))}`); }
  }
  const evidence = { task: { id: task.id, status: task.status, head: task.head_commit, base: task.base_commit,
    task_branch: task.task_branch, target_branch: task.target_branch, work_dir: task.work_dir, delivered: task.delivered_at,
    clean: task.worktree_clean, repository: task.repository_snapshot_json }, report, run, checks,
    repository_version: repository?.version ?? null, facts };
  const evidenceVersion = canonicalJsonHash(evidence);
  const { target_head: _target, ...stableFacts } = facts;
  return { task_id: taskId, expected_head: task.head_commit, evidence_version: evidenceVersion, mode: snapshot?.mode ?? null,
    repository, blockers, stable_evidence_version: canonicalJsonHash({ ...evidence, facts: stableFacts }), can_approve: blockers.length === 0,
    can_override: blockers.some(b => b.kind === "quality") && !blockers.some(b => b.kind === "integrity") };
}

export function assertExpected(gate: ReviewGate, request: IntegrationActionRequest) {
  if (!request || !fullSha(request.expected_head) || typeof request.expected_version !== "string") integrationError("invalid_request", "缺少预期提交和证据版本", 400);
  if (request.expected_head !== gate.expected_head || request.expected_version !== gate.evidence_version) integrationError("evidence_changed", "证据或 Git 现场已变化，请刷新后重新确认");
}
export async function getTaskIntegration(db: Db, taskId: string): Promise<TaskIntegration> {
  const task = getTask(db, taskId);
  if (!task) integrationError("task_not_found", "任务不存在", 404);
  const gate = await getReviewGate(db, taskId);
  return { gate, decision: readDecision(db, taskId), operations: readOperations(db, taskId), pull_request: readPullRequest(db, taskId),
    source: getIssueSource(db, task.issue_id), last_synced_at: gate.repository?.last_synced_at ?? null,
    next_sync_at: gate.repository?.next_sync_at ?? null, sync_error: gate.repository?.error ?? null };
}

export async function submitDecision(db: Db, taskId: string, body: SubmitDecisionRequest, key: string) {
  requestKey(key);
  if (!body || !["approved", "overridden", "rejected"].includes(body.result)) integrationError("invalid_decision", "裁决类型无效", 400);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > 4000 || ((body.result === "overridden" || body.result === "rejected") && !reason)) integrationError("reason_required", "覆盖或返工必须填写理由，长度不超过 4000 字", 400);
  if (body.result === "overridden" && body.confirmed !== true) integrationError("confirmation_required", "覆盖验证必须再次明确确认", 400);
  const actor = seed(db).user.id;
  const payloadHash = canonicalJsonHash({ ...body, reason, actor });
  const existing = db.$client.prepare("SELECT * FROM review_decisions WHERE task_id=?").get(taskId) as any;
  if (existing) {
    if (existing.request_key !== key || existing.payload_hash !== payloadHash) integrationError("decision_conflict", "该任务已有不可变裁决，返工必须使用新任务");
    const next = db.$client.prepare("SELECT id FROM tasks WHERE parent_task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId) as any;
    return { decision: readDecision(db, taskId)!, ...(next ? { next_task_id: next.id } : {}) };
  }
  const gate = await getReviewGate(db, taskId);
  assertExpected(gate, body);
  if (body.result === "approved" && !gate.can_approve || body.result === "overridden" && !gate.can_override) integrationError("gate_blocked", gate.blockers.map(b => b.message).join("；"));
  const task = getTask(db, taskId)!;
  const snapshot = parseRepositorySnapshot(task.repository_snapshot_json);
  if (!snapshot || !gate.repository) integrationError("repository_binding_required", "缺少可用的原始仓库绑定");
  return withGitLock(snapshot.identity.real_path, async () => {
    const checked = await getReviewGate(db, taskId);
    assertExpected(checked, body);
    if (body.result === "approved" && !checked.can_approve || body.result === "overridden" && !checked.can_override) integrationError("gate_blocked", "裁决前实时校验未通过");
    return db.$client.transaction(() => {
      const prior = db.$client.prepare("SELECT * FROM review_decisions WHERE task_id=?").get(taskId) as any;
      if (prior) {
        if (prior.request_key === key && prior.payload_hash === payloadHash) return { decision: readDecision(db, taskId)! };
        integrationError("decision_conflict", "该任务已有裁决");
      }
      const issue = getIssue(db, task.issue_id)!;
      if (body.result === "rejected" && (issue.assignee_type !== "agent" || !issue.assignee_id)) integrationError("assignee_required", "请先选择返工执行器");
      excludeReviewMeasurement(db, body.review_measurement_failed_for, { taskId });
      const id = newId(), now = new Date().toISOString();
      db.$client.prepare(`INSERT INTO review_decisions(id,task_id,repository_id,actor_id,result,reason,head_commit,evidence_version,request_key,payload_hash,snapshot_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, taskId, snapshot.repository_id, actor, body.result, reason, task.head_commit, checked.evidence_version, key, payloadHash, JSON.stringify(checked), now);
      addComment(db, task.issue_id, { author_type: "member", author_id: actor, type: "system", body: `人工裁决：${body.result === "approved" ? "批准" : body.result === "overridden" ? "明确覆盖验证" : "返工"}；提交 ${task.head_commit}${reason ? `；理由：${reason}` : ""}` });
      let nextTaskId: string | undefined;
      if (body.result === "rejected") {
        db.$client.prepare("UPDATE issues SET status='todo',updated_at=? WHERE id=?").run(now, issue.id);
        const next = enqueueForIssue(db, getIssue(db, issue.id)!, "review_rejected");
        if (!next) integrationError("pending_task_exists", "已有排队任务，请先处理后再返工");
        db.$client.prepare("UPDATE tasks SET parent_task_id=? WHERE id=?").run(taskId, next.id);
        nextTaskId = next.id;
      }
      return { decision: readDecision(db, taskId)!, ...(nextTaskId ? { next_task_id: nextTaskId } : {}) };
    }).immediate();
  });
}

type OperationRow = DeliveryOperation & { payload_hash: string; intent_json: string };
function operationRow(db: Db, id: string): OperationRow | undefined {
  return db.$client.prepare("SELECT * FROM delivery_operations WHERE id=?").get(id) as OperationRow | undefined;
}
function operationDto(db: Db, id: string): DeliveryOperation { return readOperations(db, operationRow(db, id)!.task_id).find(item => item.id === id)!; }
function requireApproval(db: Db, taskId: string, gate: ReviewGate) {
  const decision = readDecision(db, taskId);
  if (!decision || decision.result === "rejected" || decision.head_commit !== gate.expected_head || decision.evidence_version !== gate.evidence_version)
    integrationError("decision_required", "需要对同一提交和证据作出有效的人工批准");
  if (gate.blockers.some(item => item.kind === "integrity") || decision.result === "approved" && !gate.can_approve)
    integrationError("gate_blocked", gate.blockers.map(item => item.message).join("；"));
  return decision;
}
function finishLocal(db: Db, taskId: string, operationId: string, mergeCommit: string) {
  return db.$client.transaction(() => {
    const task = getTask(db, taskId)!, now = new Date().toISOString();
    const row = operationRow(db, operationId)!;
    if (row.state === "succeeded") return operationDto(db, operationId);
    db.$client.prepare("UPDATE delivery_operations SET state='succeeded',result_json=?,error=NULL,updated_at=? WHERE id=?")
      .run(JSON.stringify({ merge_commit: mergeCommit }), now, operationId);
    const latest = db.$client.prepare("SELECT id FROM tasks WHERE issue_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(task.issue_id) as { id: string };
    const issue = getIssue(db, task.issue_id);
    const authoritative = latest?.id === taskId && issue?.repository_id === row.repository_id;
    if (authoritative) db.$client.prepare("UPDATE issues SET status='done',updated_at=? WHERE id=?").run(now, task.issue_id);
    addComment(db, task.issue_id, { author_type: "member", author_id: seed(db).user.id, type: "system",
      body: `${authoritative ? "本地交付完成" : "历史任务已合入本地；当前工作项保留其新任务状态"}：裁决提交 ${task.head_commit}，合入提交 ${mergeCommit}，操作 ${operationId}` });
    return operationDto(db, operationId);
  }).immediate();
}

/** 意图先落库；未知结果保留现场，恢复先核对 Git 事实，不再做第二次裁决。 */
export async function integrateLocal(db: Db, taskId: string, body: IntegrationActionRequest, key: string, recoverId?: string): Promise<DeliveryOperation> {
  requestKey(key);
  const task = getTask(db, taskId);
  if (!task) integrationError("task_not_found", "任务不存在", 404);
  const snapshot = parseRepositorySnapshot(task.repository_snapshot_json);
  if (!snapshot || snapshot.mode !== "local_git") integrationError("local_mode_required", "只有绑定本地 Git 的任务可本地交付");
  const payloadHash = canonicalJsonHash({ ...body, recover_id: recoverId ?? null });
  const existing = db.$client.prepare("SELECT * FROM delivery_operations WHERE task_id=? AND action='local_merge' AND request_key=?").get(taskId, key) as OperationRow | undefined;
  if (existing) {
    if (existing.payload_hash !== payloadHash) integrationError("idempotency_conflict", "同一操作标识不能提交不同参数");
    return operationDto(db, existing.id);
  }
  return withGitLock(snapshot.identity.real_path, async () => {
    const replay = db.$client.prepare("SELECT * FROM delivery_operations WHERE task_id=? AND action='local_merge' AND request_key=?").get(taskId, key) as OperationRow | undefined;
    if (replay) {
      if (replay.payload_hash !== payloadHash) integrationError("idempotency_conflict", "操作参数冲突");
      return operationDto(db, replay.id);
    }
    const prior = recoverId ? operationRow(db, recoverId) : null;
    if (recoverId && (!prior || prior.task_id !== taskId || prior.action !== "local_merge" || prior.state === "succeeded")) integrationError("invalid_recovery", "恢复对象无效或已经成功");
    if (prior) {
      const latest = db.$client.prepare("SELECT id FROM delivery_operations WHERE task_id=? AND action='local_merge' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(taskId) as { id: string };
      if (latest?.id !== prior.id) integrationError("operation_conflict", "只能恢复最新一次未完成操作，历史尝试保留供审计");
    }
    const identity = await readGitRepositoryIdentity(snapshot.checkout_path);
    if (!sameGitRepository(identity, snapshot.identity)) integrationError("repository_mismatch", "原始仓库已被替换");
    const decision = readDecision(db, taskId);
    const gate = await getReviewGate(db, taskId);
    let recoveredCommit: string | null = null;
    if (prior) {
      const intent = JSON.parse(prior.intent_json);
      if (!decision || decision.result === "rejected" || decision.id !== prior.decision_id || body.expected_head !== prior.expected_head
        || body.expected_version !== intent.expected_version) integrationError("recovery_conflict", "恢复必须对应原裁决和原操作意图");
      const head = await currentCommit(snapshot.checkout_path, `refs/heads/${snapshot.target_branch}`);
      if (head !== intent.target_head) {
        // 只认直接、准确的合入结果；不以祖先关系猜测其他人完成的交付。
        const parents = (await git(snapshot.checkout_path, ["show", "-s", "--format=%P", head])).trim().split(/\s+/);
        const recorded = prior.result_json ? JSON.parse(prior.result_json).merge_commit : null;
        if (recorded === head || parents.length === 2 && parents[0] === intent.target_head && parents[1] === prior.expected_head) recoveredCommit = head;
        else integrationError("recovery_ambiguous", "目标分支已变化，无法证明是本次合入结果，请保留现场人工核对");
        if ((await git(snapshot.checkout_path, ["symbolic-ref", "--short", "HEAD"])).trim() !== snapshot.target_branch
          || (await git(snapshot.checkout_path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()
          || await operationInProgress(snapshot.checkout_path)) integrationError("git_operation_in_progress", "恢复前请先处理目标仓库未完成的 Git 操作");
        const remaining = gate.blockers.filter(item => item.code !== "base_advanced");
        if (remaining.some(item => item.kind === "integrity") || decision.result === "approved" && remaining.length) integrationError("gate_blocked", remaining.map(item => item.message).join("；"));
      } else {
        assertExpected(gate, body);
        requireApproval(db, taskId, gate);
      }
    } else {
      assertExpected(gate, body);
      requireApproval(db, taskId, gate);
    }
    const operationId = newId(), now = new Date().toISOString();
    const intent = { expected_version: decision!.evidence_version, target_head: task.base_commit,
      target_branch: snapshot.target_branch, expected_head: task.head_commit, repository: snapshot, recovered_from: recoverId ?? null };
    db.$client.transaction(() => {
      const busy = db.$client.prepare("SELECT id FROM delivery_operations WHERE repository_id=? AND action='local_merge' AND state IN ('prepared','unknown') AND id<>?").get(snapshot.repository_id, prior?.id ?? "");
      if (busy) integrationError("recovery_required", "此仓库已有未确认的交付操作，请先恢复");
      if (prior) db.$client.prepare("UPDATE delivery_operations SET state='failed',error=?,updated_at=? WHERE id=?").run(`已核对现场，后续由恢复操作 ${operationId} 处理`, now, prior.id);
      db.$client.prepare(`INSERT INTO delivery_operations(id,task_id,repository_id,decision_id,action,state,expected_head,request_key,payload_hash,intent_json,created_at,updated_at)
        VALUES (?,?,?,?,'local_merge','prepared',?,?,?,?,?,?)`).run(operationId, taskId, snapshot.repository_id, decision!.id, task.head_commit, key, payloadHash, JSON.stringify(intent), now, now);
    }).immediate();
    try {
      let mergeCommit = recoveredCommit;
      if (!mergeCommit) {
        const checked = await getReviewGate(db, taskId);
        assertExpected(checked, body);
        requireApproval(db, taskId, checked);
        await git(snapshot.checkout_path, ["merge", "--no-ff", "--no-edit", "-m", `Anvil 本地交付 ${operationId}`, task.head_commit!]);
        mergeCommit = await currentCommit(snapshot.checkout_path, "HEAD");
        const parents = (await git(snapshot.checkout_path, ["show", "-s", "--format=%P", mergeCommit])).trim().split(/\s+/);
        if (mergeCommit !== task.base_commit && (parents.length !== 2 || parents[0] !== task.base_commit || parents[1] !== task.head_commit))
          integrationError("merge_result_mismatch", "实际合入提交不属于已保存的操作意图");
        await git(snapshot.checkout_path, ["merge-base", "--is-ancestor", task.head_commit!, mergeCommit]);
        if ((await git(snapshot.checkout_path, ["symbolic-ref", "--short", "HEAD"])).trim() !== snapshot.target_branch
          || (await git(snapshot.checkout_path, ["status", "--porcelain=v1", "--untracked-files=all"])).trim()
          || await operationInProgress(snapshot.checkout_path)) integrationError("git_state_changed", "Git 返回后现场已变化，需要核对结果");
        db.$client.prepare("UPDATE delivery_operations SET result_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ merge_commit: mergeCommit }), new Date().toISOString(), operationId);
      }
      return finishLocal(db, taskId, operationId, mergeCommit);
    } catch (error) {
      db.$client.prepare("UPDATE delivery_operations SET state='unknown',error=?,updated_at=? WHERE id=?")
        .run(integrationDiagnostic((error as Error).message), new Date().toISOString(), operationId);
      return operationDto(db, operationId);
    }
  });
}
