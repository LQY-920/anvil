import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionResult, DeliveryOperation, IntegrationActionRequest, RepositorySnapshot, ReviewMeasurementFailure, SubmitDecisionRequest, Task, TaskIntegration } from "@anvil/core";
import * as api from "../api.js";
import { Button } from "./ui/button.js";
import { Textarea } from "./ui/textarea.js";
import { DECISION_RESULT_LABELS as resultLabels, DELIVERY_OPERATION_LABELS as operationLabels, VERIFICATION_STATUS_LABELS as verificationLabels } from "../labels.js";

function webUrl(value: string): string | undefined { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? value : undefined; } catch { return undefined; } }
function ShortSha({ value }: { value: string | null }) { return <code title={value ?? undefined}>{value?.slice(0, 12) ?? "尚未生成"}</code>; }

export interface IntegrationPanelProps {
  task: Task; onChanged?: () => void; onSelectTask?: (id: string) => void;
  onBeforeDecision: () => Promise<ReviewMeasurementFailure | undefined>;
  onDecisionSaved: () => void; onDecisionError: () => void;
}

/** 父组件按 Task ID 挂载，幂等请求与恢复状态不会流入另一个任务。 */
export default function IntegrationPanel(props: IntegrationPanelProps) {
  const { task } = props;
  const [integration, setIntegration] = useState<TaskIntegration | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [decisionPending, setDecisionPending] = useState(false);
  const [operationUncertain, setOperationUncertain] = useState(false);
  const decisionRequest = useRef<{ key: string; body: SubmitDecisionRequest } | null>(null);
  const operationRequests = useRef(new Map<string, { key: string; body: IntegrationActionRequest }>());
  const reload = useCallback(async () => {
    const generation = ++sequence.current;
    const current = await api.getTaskIntegration(task.id);
    if (mounted.current && generation === sequence.current) {
      setIntegration(current);
      if (current.operations.length) setOperationUncertain(false);
    }
    return current;
  }, [task.id]);
  useEffect(() => {
    mounted.current = true;
    void reload().catch(e => { if (mounted.current) setError(api.apiErrorText(e)); });
    return () => { mounted.current = false; sequence.current++; };
  }, [reload]);
  const begin = () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); setError(""); return true; };
  const end = () => { busyRef.current = false; if (mounted.current) setBusy(false); };
  const fail = (e: unknown) => { if (mounted.current) setError(api.apiErrorText(e)); };

  const decide = async (result: DecisionResult) => {
    if (!begin()) return;
    try {
      let request = decisionRequest.current;
      if (!request) {
        const latest = await reload();
        if (!mounted.current) return;
        if (latest.decision) { props.onDecisionSaved(); return; }
        const gate = latest.gate;
        if (!gate.expected_head) throw new Error("尚无可裁决的交付提交，请等待任务完成。");
        if (result === "approved" && (!gate.can_approve || gate.blockers.length)) throw new Error("最新合入检查未通过，请先处理阻塞项。");
        if (result === "overridden" && (!gate.can_override || gate.blockers.some(b => b.kind === "integrity") || !reason.trim() || !confirmed)) throw new Error("仅质量问题可覆盖，必须填写理由并再次确认；完整性问题不可覆盖。");
        if (result === "rejected" && !reason.trim()) throw new Error("请填写打回理由。");
        const measurementFailure = await props.onBeforeDecision();
        if (!mounted.current) return;
        request = { key: crypto.randomUUID(), body: { result, reason: reason.trim(), ...(result === "overridden" ? { confirmed: true } : {}), expected_head: gate.expected_head, expected_version: gate.evidence_version, ...measurementFailure } };
        decisionRequest.current = request; setDecisionPending(true);
      }
      const response = await api.submitTaskDecision(task.id, request.body, request.key);
      if (!mounted.current) return;
      decisionRequest.current = null; setDecisionPending(false); props.onDecisionSaved(); props.onChanged?.();
      await reload();
      if (mounted.current && response.next_task_id) props.onSelectTask?.(response.next_task_id);
    } catch (e) {
      fail(e); props.onDecisionError();
      // 确定拒绝的请求可重新审查；网络或服务端未知结果继续沿用原键及原载荷。
      if (e instanceof api.ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) {
        decisionRequest.current = null; if (mounted.current) setDecisionPending(false);
      }
    } finally { end(); }
  };

  const operate = async (recover?: DeliveryOperation) => {
    if (!begin()) return;
    const action = recover ? `recover:${recover.id}` : "deliver";
    try {
      let request = operationRequests.current.get(action);
      if (!request) {
        const latest = await reload();
        if (!mounted.current) return;
        const originalVersion = recover ? (recover as DeliveryOperation & { expected_version?: string }).expected_version ?? latest.decision?.evidence_version : undefined;
        if ((!recover && !latest.gate.expected_head) || (recover && !originalVersion)) throw new Error("交付 HEAD 或原始操作证据版本缺失，请刷新状态后再恢复。");
        if (!recover && (task.status !== "completed" || latest.operations.length || latest.gate.blockers.some(b => b.kind === "integrity"))) throw new Error("Git 完整性状态已变化，请刷新并处理已有操作。");
        if (!recover && latest.gate.mode !== "github_pr") {
          if (!latest.decision || latest.decision.result === "rejected" || latest.decision.head_commit !== latest.gate.expected_head) throw new Error("本地交付需要当前 HEAD 的有效裁决。");
          if (!(latest.gate.can_approve || (latest.decision.result === "overridden" && latest.gate.can_override))) throw new Error("最新质量检查未通过，当前裁决不允许执行本地交付。");
        }
        request = { key: crypto.randomUUID(), body: { expected_head: recover ? recover.expected_head : latest.gate.expected_head!, expected_version: recover ? originalVersion! : latest.gate.evidence_version } };
        operationRequests.current.set(action, request);
      }
      const operation = recover
        ? await api.recoverTaskOperation(task.id, recover.id, request.body, request.key)
        : integration?.gate.mode === "github_pr"
          ? await api.createTaskPullRequest(task.id, request.body, request.key)
          : await api.integrateTask(task.id, request.body, request.key);
      if (!mounted.current) return;
      operationRequests.current.delete(action);
      setIntegration(previous => previous ? { ...previous, operations: [...previous.operations.filter(o => o.id !== operation.id), operation] } : previous);
      setOperationUncertain(false); props.onChanged?.();
      await reload();
    } catch (e) {
      fail(e);
      if (mounted.current && !(e instanceof api.ApiError && e.status >= 400 && e.status < 500 && e.status !== 408)) setOperationUncertain(true);
      try { await reload(); } catch { /* 保留原失败说明，未知结果不能再次创建操作。 */ }
    } finally { end(); }
  };
  const refresh = async () => {
    if (!begin()) return;
    try { if (integration?.gate.repository) await api.syncRepository(integration.gate.repository.id); await reload(); }
    catch (e) { fail(e); try { await reload(); } catch { /* 保留错误 */ } }
    finally { end(); }
  };
  const acceptSource = async () => {
    if (!integration?.source || !begin()) return;
    try { await api.acceptIssueSource(task.issue_id, integration.source.latest.id); await reload(); props.onChanged?.(); }
    catch (e) { fail(e); } finally { end(); }
  };
  if (!integration) return <section aria-label="Git 交付" className="space-y-2 rounded-lg border p-3"><p>正在读取仓库与交付检查…</p>{error && <p role="alert" className="text-destructive">{error}</p>}<Button variant="outline" disabled={busy} onClick={refresh}>重新读取交付状态</Button></section>;
  const { gate, decision, pull_request: pr, source, operations } = integration;
  let snapshot: RepositorySnapshot | null = null;
  try { snapshot = JSON.parse(task.repository_snapshot_json ?? "null"); } catch { /* Gate 展示无效快照的阻塞原因。 */ }
  const integrityBlocked = gate.blockers.some(b => b.kind === "integrity");
  const canDeliver = task.status === "completed" && gate.expected_head && !integrityBlocked && (gate.mode === "github_pr" || (decision && decision.result !== "rejected" && decision.head_commit === gate.expected_head && (gate.can_approve || (decision.result === "overridden" && gate.can_override))));
  const decisionDisabled = busy || task.status !== "completed" || !gate.expected_head || Boolean(decision) || decisionPending;
  const pendingOperation = operations.length > 0 && operations[0].state !== "succeeded";
  return <section aria-label="Git 交付" className="space-y-3 rounded-lg border bg-card p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{gate.mode === "github_pr" ? "GitHub PR 交付" : "本地 Git 交付"}</h3><Button variant="outline" size="sm" disabled={busy} onClick={refresh}>刷新交付状态</Button></div>
    <p className="break-all">{gate.repository?.full_name ?? "仓库身份未确认"} → {gate.repository?.target_branch ?? task.target_branch ?? "未确认"}</p>
    <p>固定基线 <ShortSha value={task.base_commit} /> → 交付 <ShortSha value={task.head_commit} /></p>
    {snapshot?.input && <p className="text-xs text-muted-foreground">本 Task 固定输入：{snapshot.input.title} · 来源快照：{snapshot.source_snapshot_id ?? "本地输入"}</p>}
    <p>Runner 验证：{verificationLabels[task.verification_status ?? ""] ?? "尚无验证记录"} · {task.worktree_clean === true ? "工作区已记录为干净" : "工作区状态未确认"}</p>
    <p className="text-xs text-muted-foreground">存档验证、当前合入检查、人类裁决与远端状态分别记录。</p>
    {source && <details className="space-y-2 rounded border p-2" open={source.changed}>
      <summary>来源 Issue #{source.issue_number} · {source.changed ? "上游内容已变化" : "已接受当前来源版本"}</summary>
      <a href={webUrl(source.url)} target="_blank" rel="noreferrer" className="text-primary underline">查看 GitHub Issue</a>
      <div className="grid gap-2"><div><strong>已接受：{source.accepted.title}</strong><p className="whitespace-pre-wrap">{source.accepted.body}</p></div>{source.changed && <div><strong>最新：{source.latest.title}</strong><p className="whitespace-pre-wrap">{source.latest.body}</p></div>}</div>
      {source.changed && <><p className="text-xs text-muted-foreground">接受更新只影响后续新任务，当前 Task 输入和证据保持原版本。</p><Button variant="outline" size="sm" disabled={busy} onClick={acceptSource}>接受最新来源用于新任务</Button></>}
    </details>}
    <div aria-label="当前合入检查" className="space-y-1 border-t pt-2"><h4 className="font-medium">当前合入检查</h4>{gate.blockers.length ? gate.blockers.map((b, i) => <p key={`${b.code}-${i}`} className="text-destructive">{b.kind === "integrity" ? "完整性阻塞（不可覆盖）" : "质量阻塞"}：{b.message}</p>) : <p>{gate.can_approve ? "当前检查通过，可提交人类裁决。" : "当前尚不可批准，请刷新检查结果。"}</p>}</div>
    {decision ? <div className="space-y-1 border-t pt-2"><h4 className="font-medium">人类裁决：{resultLabels[decision.result]}</h4><p>绑定提交 <ShortSha value={decision.head_commit} /></p><p className="whitespace-pre-wrap">{decision.reason || "无补充理由"}</p><p className="text-xs text-muted-foreground">裁决已保存，不能改判；操作重试不会产生新的批准。</p>{decision.head_commit !== gate.expected_head && <p className="text-destructive">交付 HEAD 已变化，旧裁决不能用于新版本，请重新执行并审查。</p>}</div> : <div className="space-y-2 border-t pt-2">
      <label className="grid gap-1">裁决理由<Textarea aria-label="裁决理由" disabled={decisionPending || busy} value={reason} onChange={e => setReason(e.target.value)} placeholder="打回或质量覆盖必须填写理由" /></label>
      {gate.can_override && !integrityBlocked && <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={decisionPending || busy} onChange={e => setConfirmed(e.target.checked)} /><span>我已审查验证失败或未配置的风险，确认以此理由覆盖质量检查。完整性问题不可覆盖。</span></label>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={decisionDisabled || !gate.can_approve || gate.blockers.length > 0} onClick={() => decide("approved")}>批准当前交付</Button><Button variant="outline" size="sm" disabled={decisionDisabled || !gate.can_override || integrityBlocked || !reason.trim() || !confirmed} onClick={() => decide("overridden")}>确认质量覆盖</Button><Button variant="outline" size="sm" disabled={decisionDisabled || !reason.trim()} onClick={() => decide("rejected")}>打回并创建新任务</Button></div>
      {decisionPending && <div className="space-y-1"><p>裁决响应未确认，请重试同一裁决；不会重新计时或创建另一份决定。</p><Button variant="outline" disabled={busy} onClick={() => decide(decisionRequest.current!.body.result)}>重试保存裁决</Button></div>}
    </div>}
    {!operations.length && !operationUncertain && <Button size="sm" disabled={busy || !canDeliver} onClick={() => operate()}>{gate.mode === "github_pr" ? "创建或关联 PR" : "执行本地交付"}</Button>}
    {gate.mode === "github_pr" && !decision && <p className="text-xs text-muted-foreground">可先创建 PR 供审阅；创建或打开 PR 不代表批准，质量检查失败时仍需打回或明确覆盖。</p>}
    {operations.map(operation => <div key={operation.id} className="space-y-1 rounded border p-2"><p>{operation.action === "pull_request" ? "PR 操作" : "本地交付"}：{operationLabels[operation.state]}</p>{operation.error && <p className="whitespace-pre-wrap text-destructive">{operation.error}</p>}{operation.id === operations[0]?.id && ["prepared", "failed", "unknown"].includes(operation.state) && <><p className="text-xs text-muted-foreground">先查询已有结果再恢复，不重复运行 Agent，不强推或自动回退。</p><Button variant="outline" size="sm" disabled={busy} onClick={() => operate(operation)}>查询并恢复操作</Button></>}</div>)}
    {(operationUncertain || pendingOperation) && <p role="status" className="text-muted-foreground">操作结果尚未确认。请刷新状态，在已准备、失败或未知操作的恢复入口继续。</p>}
    {pr && <div className="space-y-2 border-t pt-2"><h4 className="font-medium">GitHub PR #{pr.number} · {pr.state === "merged" ? "远端已合入" : pr.state === "closed" ? "已关闭，未合入" : "等待 GitHub 审查与合入"}</h4><a href={webUrl(pr.url)} target="_blank" rel="noreferrer" className="text-primary underline">在 GitHub 审查或合入</a>{pr.state === "closed" && <p className="text-destructive">关闭 PR 不等于交付完成。请在 GitHub 核对并处理此 PR，再刷新。</p>}{pr.head_sha !== decision?.head_commit && <p className="text-destructive">PR HEAD 与批准版本不一致，不能确认远端交付。</p>}<h5>GitHub checks（与 Runner 验证分别记录）</h5>{pr.checks.length ? pr.checks.map((check, i) => <p key={`${check.name}-${i}`}>{check.name}：{check.status} / {check.conclusion ?? "尚无结论"}{check.url && <a href={webUrl(check.url)} target="_blank" rel="noreferrer" className="ml-2 text-primary underline">查看</a>}</p>) : <p className="text-muted-foreground">GitHub 暂未返回 checks。</p>}</div>}
    <p className="text-xs text-muted-foreground">上次同步：{integration.last_synced_at ?? "尚无记录"} · 下次同步：{integration.next_sync_at ?? "尚无记录"}</p>
    {(error || integration.sync_error) && <div role="alert" className="whitespace-pre-wrap text-destructive">{error || integration.sync_error}<p className="text-muted-foreground">请核对阻塞说明、连接权限或网络，再刷新状态。结果未知时从已有操作恢复。</p></div>}
  </section>;
}
