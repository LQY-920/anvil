import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, Issue, Task, TaskDiffResponse } from "@anvil/core";
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
import { useServerEvents } from "../ws.js";
import { TASK_STATUS_LABELS } from "../labels.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Msg { seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null; created_at?: string | null; }

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

/** 单条日志：时间戳 + 类型图标 + 内容；tool_result 默认折叠成摘要，长输出截断 200px 可展开 */
function LogRow({ msg }: { msg: Msg }) {
  const [full, setFull] = useState(false);
  const text = msg.content ?? msg.output ?? msg.input_json ?? "";
  const meta = LOG_TYPE_META[msg.type] ?? { icon: MessageSquare, className: "text-zinc-400", label: msg.type };
  const Icon = meta.icon;
  const long = text.length > 400 || text.split("\n").length > 8;
  const body = (
    <>
      <pre className={cn(
        "m-0 mt-0.5 whitespace-pre-wrap break-all font-mono",
        msg.type === "error" ? "text-red-400" : msg.type === "tool_result" ? "text-zinc-400" : "text-zinc-300",
        long && !full && "max-h-[200px] overflow-hidden",
      )}>{text}</pre>
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
        <span className="text-[11px]">{msg.type === "tool_use" && msg.tool ? msg.tool : meta.label}</span>
      </span>
      <div className="min-w-0">
        {msg.type === "tool_result" ? (
          <details className="group">
            <summary className="cursor-pointer list-none text-zinc-500 before:content-['▸_'] hover:text-zinc-300 group-open:before:content-['▾_']">
              {text.split("\n")[0] || "(无输出)"}
            </summary>
            {body}
          </details>
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
  const [diff, setDiff] = useState<TaskDiffResponse | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const [merged, setMerged] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
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
    setDiff(null); setShowDiff(false); setMerged(null); setMergeError(""); setFeedback(""); setDraft("");
    lastSeq.current = -1;
  }, [taskId]);

  useEffect(() => { reload().catch(console.error); }, [reload]);
  useServerEvents(useCallback((e) => {
    const data = e.data as any;
    if (e.type === "task.message" && data?.task_id === taskId) scheduleReload();
    if (e.type === "task.updated" && data?.id === taskId) scheduleReload();
  }, [taskId, scheduleReload]));
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ behavior: "smooth" }); }, [messages.length]);

  // 交付区：completed 且 issue 未 done 时拉 diff；404（无分支）则整区不显示
  const taskStatus = task?.status;
  const issueStatus = issue?.status;
  useEffect(() => {
    if (!taskId || taskStatus !== "completed" || issueStatus === "done" || !issueStatus) return;
    let cancelled = false;
    api.getTaskDiff(taskId)
      .then((d) => { if (!cancelled) setDiff(d); })
      .catch(() => { /* 无分支 → 不显示交付区 */ });
    return () => { cancelled = true; };
  }, [taskId, taskStatus, issueStatus]);

  if (!task || !issue) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
        <div className="p-5 text-sm text-muted-foreground">加载中…</div>
      </div>
    );
  }
  const active = ["queued", "dispatched", "running"].includes(task.status);
  const showDelivery = task.status === "completed" && issue.status !== "done" && (diff !== null || merged !== null);
  const statusMeta = TASK_STATUS_META[task.status];
  const StatusIcon = statusMeta?.icon;

  const doMerge = async () => {
    setMergeError("");
    try {
      const res = await api.mergeTask(task.id);
      setMerged(res.merged_branch);
      props.onChanged?.();
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    }
  };

  const rejectAndRerun = async () => {
    if (!feedback.trim()) return;
    await api.addComment(issue.id, feedback);
    const t = await api.rerunIssue(issue.id);
    setFeedback("");
    props.onChanged?.();
    if (t?.id) props.onSelectTask?.(t.id);
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
        {task.error && (
          <div className="whitespace-pre-wrap rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-600 dark:text-rose-400">
            [{task.failure_reason}] {task.error}
          </div>
        )}
        {showDelivery && (
          <section aria-label="交付">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">交付</h3>
            <div className="space-y-2 rounded-lg border bg-card p-3">
              {merged ? (
                <div className="text-sm text-emerald-600 dark:text-emerald-400">✓ 已合入 {merged}</div>
              ) : diff && (
                <>
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <code className="rounded border bg-muted px-1.5 py-0.5">{diff.branch}</code>
                    <span className="text-muted-foreground">→</span>
                    <code className="rounded border bg-muted px-1.5 py-0.5 text-amber-600 dark:text-amber-400">{diff.base}</code>
                  </div>
                  <DiffStat stat={diff.diff_stat} />
                  {!showDiff && (
                    <Button variant="outline" size="sm" onClick={() => setShowDiff(true)}>查看 diff</Button>
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
                  <div className="flex items-center gap-2 pt-1">
                    <Button size="sm" onClick={doMerge}>合入 {diff.base}</Button>
                  </div>
                  {mergeError && <div className="whitespace-pre-wrap text-sm text-rose-600 dark:text-rose-400">{mergeError}</div>}
                  <div className="flex flex-col gap-2 pt-1">
                    <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="打回意见…" />
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-end border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                      onClick={rejectAndRerun}
                    >
                      提交意见并重跑
                    </Button>
                  </div>
                </>
              )}
            </div>
          </section>
        )}
        <section aria-label="执行日志">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">执行日志</h3>
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
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="追加指令或评论…" />
            <Button
              size="sm"
              className="self-end"
              onClick={async () => { if (!draft.trim()) return; await api.addComment(issue.id, draft); setDraft(""); reload(); }}
            >
              发送
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
