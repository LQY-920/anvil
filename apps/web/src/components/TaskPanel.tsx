import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, Issue, Task, ReviewMeasurementFailure } from "@anvil/core";
import {
  AlertCircle,
  Ban,
  Bot,
  CheckCircle2,
  Clock,
  CornerDownRight,
  GitCommit,
  Loader2,
  MessageSquare,
  Sparkles,
  Terminal,
  User,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import * as api from "../api.js";
import type { CommentTrigger, ReviewDiffResponse } from "../api.js";
import { useServerEvents } from "../ws.js";
import { useReviewTimer } from "../hooks/useReviewTimer.js";
import { TASK_STATUS_LABELS } from "../labels.js";
import { cn } from "@/lib/utils";
import { messageToEntry, summarizeProgress } from "@/lib/trace-presenter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import IntegrationPanel from "./IntegrationPanel.js";

interface Msg { seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null; created_at?: string | null; }

function errorMessage(error: unknown): string {
  if (error instanceof api.ApiError && error.detail) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

/** 任务状态徽章配色（徽章公式：10% 底 + 20% 描边 + 实色字） */
const TASK_STATUS_META: Record<string, { icon: LucideIcon; className: string }> = {
  queued: { icon: Clock, className: "border-zinc-500/20 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400" },
  dispatched: { icon: Loader2, className: "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  running: { icon: Loader2, className: "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  completed: { icon: CheckCircle2, className: "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  failed: { icon: XCircle, className: "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  cancelled: { icon: Ban, className: "border-zinc-500/20 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400" },
};

/** 日志类型 → 终端内的图标与配色（深色常驻，故用 400 档） */
const LOG_TYPE_META: Record<string, { icon: LucideIcon; className: string; label: string }> = {
  text: { icon: MessageSquare, className: "text-emerald-400", label: "agent" },
  thinking: { icon: Sparkles, className: "text-purple-400", label: "thinking" },
  tool_use: { icon: Terminal, className: "text-blue-400", label: "tool" },
  tool_result: { icon: CornerDownRight, className: "text-zinc-500", label: "result" },
  error: { icon: AlertCircle, className: "text-red-400", label: "error" },
};

const COMMENT_AUTHOR_META: Record<string, { icon: LucideIcon; className: string }> = {
  agent: { icon: Bot, className: "text-blue-500" },
  system: { icon: GitCommit, className: "text-purple-500" },
  member: { icon: User, className: "text-zinc-500" },
};

function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 评论发送后的触发结果提示（trigger 缺省 = 旧 server，不提示） */
function triggerHint(t?: CommentTrigger): string {
  if (!t) return "";
  if (t.enqueued) return "已触发新任务（排队接力）";
  switch (t.reason) {
    case "merged_into_pending": return "已合并进排队任务，认领时生效";
    case "assignee_not_agent": return "未指派 Agent，评论仅记录不触发执行";
    case "status_inactive": return "当前状态不触发执行（收集箱/已完成/已取消）";
    default: return "";
  }
}

/** diff_stat 里的 +++/--- 分段上色（符号 + 红绿双编码） */
function DiffStat({ stat }: { stat: string }) {
  return (
    <div className="whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground">
      {stat.split(/(\++|-+)/).map((part, i) =>
        /^\++$/.test(part) ? <span key={i} className="text-emerald-600 dark:text-emerald-400">{part}</span>
        : /^-+$/.test(part) ? <span key={i} className="text-rose-600 dark:text-rose-400">{part}</span>
        : part,
      )}
    </div>
  );
}

/** 单条日志：时间戳 + 类型图标 + presenter 渲染条目；可折叠条目（tool_use/thinking/tool_result）收成摘要行，长输出截断 200px 可展开 */
function LogRow({ msg }: { msg: Msg }) {
  const [full, setFull] = useState(false);
  const entry = messageToEntry(msg);
  const meta = LOG_TYPE_META[msg.type] ?? { icon: MessageSquare, className: "text-zinc-400", label: msg.type };
  const Icon = meta.icon;
  const bodyText = entry.body ?? entry.title;
  const long = bodyText.length > 400 || bodyText.split("\n").length > 8;
  const body = (
    <>
      <pre className={cn(
        "m-0 mt-0.5 whitespace-pre-wrap break-all font-mono",
        entry.tone === "destructive" ? "text-red-400" : entry.tone === "muted" ? "text-zinc-400" : "text-zinc-300",
        long && !full && "max-h-[200px] overflow-hidden",
      )}>{bodyText}</pre>
      {long && !full && (
        <button type="button" className="mt-0.5 text-[11px] text-zinc-500 hover:text-zinc-300" onClick={() => setFull(true)}>展开全部</button>
      )}
    </>
  );
  return (
    <div className="grid grid-cols-[56px_auto_1fr] items-baseline gap-2 py-0.5">
      <span className="text-zinc-600">{fmtTime(msg.created_at)}</span>
      <span className={cn("flex items-center gap-1 whitespace-nowrap", meta.className)}>
        <Icon className="size-3.5" aria-hidden="true" />
        <span className="text-[11px]">{meta.label}</span>
      </span>
      <div className="min-w-0">
        {entry.defaultCollapsed ? (
          entry.body ? (
            <details className="group">
              <summary className="cursor-pointer list-none text-zinc-500 before:content-['▸_'] hover:text-zinc-300 group-open:before:content-['▾_']">
                {entry.title || "(无内容)"}
              </summary>
              {body}
            </details>
          ) : (
            <span className="text-zinc-500">{entry.title || "(无内容)"}</span>
          )
        ) : body}
      </div>
    </div>
  );
}

export default function TaskPanel(props: { taskId: string; onClose?: () => void; onChanged?: () => void; onSelectTask?: (id: string) => void }) {
  const { taskId } = props;
  const [task, setTask] = useState<Task | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [diff, setDiff] = useState<ReviewDiffResponse | null>(null);
  const [diffError, setDiffError] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [merged, setMerged] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [commentHint, setCommentHint] = useState("");
  const [commentError, setCommentError] = useState("");
  const [sending, setSending] = useState(false);
  const [merging, setMerging] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  // 打回可能立即切到接续任务；警告保留到用户关闭，避免随切换瞬间消失。
  const [measurementWarning, setMeasurementWarning] = useState("");
  // 同步在途守卫：state 经 React 批量刷新有间隙，同帧双击会穿透 state 判断（state 仍保留用于 disabled 渲染）
  const sendingRef = useRef(false);
  const mergingRef = useRef(false);
  const rejectingRef = useRef(false);
  const lastSeq = useRef(-1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const genRef = useRef(0);
  const prevTaskId = useRef<string | null>(null);

  const reload = useCallback(async () => {
    if (!taskId || inFlight.current) return;
    inFlight.current = true;
    const gen = genRef.current;
    try {
      const [detail, msgs] = await Promise.all([api.getTask(taskId), api.getTaskMessages(taskId, lastSeq.current)]);
      if (gen !== genRef.current) return; // 任务已切换，丢弃旧结果
      setTask(detail.task);
      setIssue(detail.issue);
      const fresh = msgs.filter((m) => m.seq > lastSeq.current);
      if (fresh.length > 0) {
        setMessages((prev) => [...prev, ...fresh]);
        lastSeq.current = fresh[fresh.length - 1].seq;
      }
      const d = await api.getIssueDetail(detail.issue.id);
      if (gen !== genRef.current) return;
      setComments(d.comments);
    } finally {
      inFlight.current = false;
    }
  }, [taskId]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { reload().catch(() => {}); }, 300);
  }, [reload]);

  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  // 切换任务时清空状态，避免串任务；升 generation 使在途旧拉取失效，并清掉去抖定时器。
  // taskId 不变的重跑（StrictMode 双跑）直接跳过：否则第二次升 gen 会丢弃首次 reload 的结果，
  // 而第二次 reload 又被 inFlight 挡掉，dev 下永远停在“加载中…”。
  useEffect(() => {
    if (prevTaskId.current === taskId) return;
    prevTaskId.current = taskId;
    genRef.current += 1;
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    setTask(null); setIssue(null); setMessages([]); setComments([]);
    setDiff(null); setDiffError(""); setShowDiff(false); setMerged(null); setMergeError(""); setRecoveryError(""); setFeedback(""); setDraft(""); setCommentHint(""); setCommentError("");
    lastSeq.current = -1;
  }, [taskId]);

  useEffect(() => { reload().catch(console.error); }, [reload]);
  useServerEvents(useCallback((e) => {
    const data = e.data as any;
    if (e.type === "task.message" && data?.task_id === taskId) scheduleReload();
    if (e.type === "task.updated" && data?.id === taskId) scheduleReload();
  }, [taskId, scheduleReload]));
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ behavior: "smooth" }); }, [messages.length]);

  // 历史服务端无分支的 404 继续隐藏；固定版本证据错误必须明确展示。
  const taskStatus = task?.status;
  const issueStatus = issue?.status;
  const hasRepositorySnapshot = Boolean(task?.repository_snapshot_json);
  const legacyReview = task?.delivery_contract_version !== 2 && !hasRepositorySnapshot && !issue?.repository_id;
  useEffect(() => {
    if (!taskId || taskStatus !== "completed" || (issueStatus === "done" && !hasRepositorySnapshot) || !issueStatus) return;
    let cancelled = false;
    api.getTaskDiff(taskId)
      .then((d) => { if (!cancelled) { setDiff(d); setDiffError(""); } })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof api.ApiError && error.status === 404 && !error.code)) return;
        setDiffError(errorMessage(error));
      });
    return () => { cancelled = true; };
  }, [taskId, taskStatus, issueStatus, hasRepositorySnapshot]);

  const reviewTimer = useReviewTimer(taskId, task?.id === taskId && taskStatus === "completed" && Boolean(issueStatus) && issueStatus !== "done" && (diff !== null || hasRepositorySnapshot) && merged === null);

  if (!task || !issue) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <div className="p-5 text-sm text-muted-foreground">加载中…</div>
      </div>
    );
  }
  const active = ["queued", "dispatched", "running"].includes(task.status);
  const showDelivery = task.status === "completed" && (issue.status !== "done" || hasRepositorySnapshot) && (diff !== null || merged !== null || Boolean(diffError));
  const statusMeta = TASK_STATUS_META[task.status];
  const StatusIcon = statusMeta?.icon;
  const progress = summarizeProgress(messages);

  const saveMeasurement = async (): Promise<ReviewMeasurementFailure | undefined> => {
    reviewTimer.pause();
    try {
      const measurement = reviewTimer.snapshot();
      const saved = await api.saveReviewMeasurement(task.id, measurement);
      if (measurement.active_review_ms !== null && saved.active_review_ms !== null) return;
    } catch { /* 计时失败不能吞掉原有裁决；随裁决请求持久化失效标记。 */ }
    reviewTimer.invalidate();
    setMeasurementWarning(`“${issue.title}”的计时未能完整保存，本任务不计入验收耗时样本。合入或打回操作继续执行。`);
    return { review_measurement_failed_for: task.id };
  };

  const doMerge = async () => {
    if (!legacyReview || mergingRef.current || rejectingRef.current || recoveryError) return;
    mergingRef.current = true;
    setMergeError("");
    setMerging(true);
    const gen = genRef.current;
    try {
      const failure = await saveMeasurement();
      const res = failure ? await api.mergeTask(task.id, failure) : await api.mergeTask(task.id);
      reviewTimer.finish();
      if (gen === genRef.current) setMerged(res.merged_branch);
      props.onChanged?.();
    } catch (e) {
      reviewTimer.resume();
      if (gen === genRef.current) {
        if (e instanceof api.ApiError && e.code === "recovery_required") setRecoveryError(errorMessage(e));
        else setMergeError(errorMessage(e));
      }
    } finally {
      mergingRef.current = false;
      setMerging(false);
    }
  };

  const rejectAndRerun = async () => {
    if (!feedback.trim() || rejectingRef.current || mergingRef.current) return;
    rejectingRef.current = true;
    setRejecting(true);
    setMergeError("");
    const gen = genRef.current;
    try {
      const failure = await saveMeasurement();
      const res = failure ? await api.addComment(issue.id, feedback, failure) : await api.addComment(issue.id, feedback);
      let nextTaskId: string | undefined;
      // 评论已入队或合并进 pending 时直接接续，避免重复 rerun。
      if (res.trigger?.enqueued && res.trigger.task_id) nextTaskId = res.trigger.task_id;
      else if (res.trigger?.reason !== "merged_into_pending") nextTaskId = (await api.rerunIssue(issue.id))?.id;
      reviewTimer.finish();
      if (gen === genRef.current) setFeedback("");
      props.onChanged?.();
      if (nextTaskId && gen === genRef.current) props.onSelectTask?.(nextTaskId);
    } catch (e) {
      reviewTimer.resume();
      if (gen === genRef.current) setMergeError(errorMessage(e));
    } finally {
      rejectingRef.current = false;
      setRejecting(false);
    }
  };

  // 发送评论：成功后按 trigger 给一行触发结果提示；失败时红字提示且保留草稿
  const sendComment = async () => {
    if (!draft.trim() || sendingRef.current) return;
    sendingRef.current = true;
    setCommentHint("");
    setCommentError("");
    setSending(true);
    try {
      const res = await api.addComment(issue.id, draft);
      setDraft("");
      setCommentHint(triggerHint(res.trigger));
      reload();
    } catch (e) {
      setCommentError(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{issue.title}</h1>
        {statusMeta && StatusIcon && (
          <Badge variant="outline" className={cn("shrink-0", statusMeta.className)}>
            <StatusIcon />
            {TASK_STATUS_LABELS[task.status] ?? task.status}
          </Badge>
        )}
        {active && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
            onClick={async () => { await api.cancelTask(task.id); reload(); }}
          >
            取消任务
          </Button>
        )}
        {props.onClose && (
          <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="关闭" onClick={props.onClose}>
            <X />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {measurementWarning && (
          <div role="alert" className="rounded-md border border-destructive/30 bg-muted px-3 py-2 text-sm">
            <p>{measurementWarning}</p>
            <Button variant="ghost" size="sm" onClick={() => setMeasurementWarning("")}>知道了</Button>
          </div>
        )}
        {task.error && (
          <div className="whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
            [{task.failure_reason}] {task.error}
          </div>
        )}
        {hasRepositorySnapshot && <IntegrationPanel key={task.id} task={task} onChanged={props.onChanged} onSelectTask={props.onSelectTask} onBeforeDecision={saveMeasurement} onDecisionSaved={() => reviewTimer.finish()} onDecisionError={() => reviewTimer.resume()} />}
        {!hasRepositorySnapshot && !legacyReview && (
          <div className="space-y-2 rounded-lg border bg-muted p-3 text-sm">
            <p>此历史任务缺少原始仓库快照。请绑定仓库后重新执行，用新任务审查与交付；已有 Task 的输入和证据不会回写。</p>
            <a className="text-primary underline" href={`/?issue=${encodeURIComponent(issue.id)}`}>配置 Issue 仓库并重新执行</a>
          </div>
        )}
        {showDelivery && (
          <section aria-label="交付">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">交付</h3>
            <div className="space-y-2 rounded-lg border bg-card p-3">
              {merged ? (
                <div className="text-sm text-emerald-600 dark:text-emerald-400">✓ 已合入 {merged}</div>
              ) : (
                <>
                  {diff && (
                    <>
                      <div className="flex items-center gap-2 font-mono text-[11px]">
                        <code className="rounded border bg-muted px-1.5 py-0.5">{diff.branch}</code>
                        <span className="text-muted-foreground">→</span>
                        <code className="rounded border bg-muted px-1.5 py-0.5 text-amber-600 dark:text-amber-400">{diff.base}</code>
                      </div>
                      {diff.delivery_contract_version === 2 ? (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>固定版本比较</span>
                            <code title={diff.base_commit ?? undefined}>{diff.base_commit?.slice(0, 12) ?? "基线缺失"}</code>
                            <span>→</span>
                            <code title={diff.head_commit ?? undefined}>{diff.head_commit?.slice(0, 12) ?? "交付版本缺失"}</code>
                          </div>
                          <p className="m-0">此 diff 展示存档版本，合入前仍需核对当前仓库与交付证据。</p>
                        </div>
                      ) : (
                        <p className="m-0 text-xs text-muted-foreground">历史任务比较（v1），未绑定固定提交版本。</p>
                      )}
                      <DiffStat stat={diff.diff_stat} />
                      {!showDiff && (
                        <Button variant="outline" size="sm" onClick={() => { reviewTimer.markFullDiff(); setShowDiff(true); }}>查看 diff</Button>
                      )}
                      {showDiff && (
                        <>
                          {diff.truncated && <div className="text-sm text-rose-600 dark:text-rose-400">内容过长已截断</div>}
                          <pre className="m-0 max-h-[400px] overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 py-1.5 font-mono text-xs leading-[18px]">
                            {diff.diff_text.split("\n").map((line, i) => {
                              const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@") ? "hunk" : "ctx";
                              return (
                                <div
                                  key={i}
                                  className={cn(
                                    "flex min-w-max",
                                    kind === "add" && "bg-emerald-500/10",
                                    kind === "del" && "bg-rose-500/10",
                                    kind === "hunk" && "bg-blue-500/10",
                                  )}
                                >
                                  <span className={cn(
                                    "w-[22px] shrink-0 select-none text-center",
                                    kind === "add" ? "text-emerald-400" : kind === "del" ? "text-rose-400" : "text-zinc-600",
                                  )}>
                                    {kind === "add" ? "+" : kind === "del" ? "-" : ""}
                                  </span>
                                  <span className={cn(
                                    "whitespace-pre pr-3",
                                    kind === "hunk" ? "text-blue-400" : "text-zinc-300",
                                  )}>
                                    {kind === "add" || kind === "del" ? line.slice(1) : line}
                                  </span>
                                </div>
                              );
                            })}
                          </pre>
                        </>
                      )}
                      {legacyReview && <div className="flex items-center gap-2 pt-1">
                        <Button size="sm" onClick={doMerge} disabled={merging || rejecting || Boolean(recoveryError)}>合入 {diff.base}</Button>
                      </div>}
                    </>
                  )}
                  {diffError && <div role="alert" className="whitespace-pre-wrap text-sm text-destructive">{diffError}</div>}
                  {recoveryError && (
                    <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-muted px-3 py-2 text-sm">
                      <p className="m-0 whitespace-pre-wrap">{recoveryError}</p>
                      <p className="m-0 text-muted-foreground">合入结果待恢复确认，普通合入已停用。仍可查看 diff 或提交意见。</p>
                    </div>
                  )}
                  {mergeError && <div className="whitespace-pre-wrap text-sm text-rose-600 dark:text-rose-400">{mergeError}</div>}
                  {legacyReview && <div className="flex flex-col gap-2 pt-1">
                    <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="打回意见…" />
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-end border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                      onClick={rejectAndRerun}
                      disabled={rejecting || merging}
                    >
                      提交意见并重跑
                    </Button>
                  </div>}
                </>
              )}
            </div>
          </section>
        )}
        <section aria-label="执行日志">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">执行日志</h3>
          {messages.length > 0 && (
            <div className="mb-1.5 truncate font-mono text-[11px] text-muted-foreground">
              工具调用 {progress.toolCalls} 次 · 错误 {progress.errors} · 最近：{progress.latest || "—"}
            </div>
          )}
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300">
            {messages.length === 0 && <div className="text-zinc-600">暂无日志</div>}
            {messages.map((m) => <LogRow key={m.seq} msg={m} />)}
            <div ref={bottomRef} />
          </div>
        </section>
        <section aria-label="评论">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">评论</h3>
          <div className="space-y-3 border-l border-border pl-4">
            {comments.map((c) => {
              const meta = COMMENT_AUTHOR_META[c.author_type] ?? COMMENT_AUTHOR_META.member;
              const AuthorIcon = meta.icon;
              return (
                <div key={c.id} className="relative">
                  <span className={cn("absolute -left-[23px] top-0.5 flex size-4 items-center justify-center rounded-full bg-background", meta.className)}>
                    <AuthorIcon className="size-3.5" aria-hidden="true" />
                  </span>
                  <div className="text-xs text-muted-foreground">{c.type}</div>
                  <p className="m-0 mt-0.5 whitespace-pre-wrap text-sm">{c.body}</p>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter 提交、Shift+Enter 换行；isComposing 防输入法候选确认误触发
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendComment();
                }
              }}
              rows={2}
              placeholder="追加指令或评论…"
            />
            {commentError
              ? <div className="text-[11px] text-rose-600 dark:text-rose-400">发送失败：{commentError}</div>
              : commentHint && <div className="text-[11px] text-muted-foreground">{commentHint}</div>}
            <Button
              size="sm"
              className="self-end"
              onClick={sendComment}
              disabled={sending}
            >
              发送
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
