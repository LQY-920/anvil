import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, Issue, Task, TaskDiffResponse } from "@anvil/core";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";

interface Msg { seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null; created_at?: string | null; }

const STATUS_ICONS: Record<string, string> = {
  queued: "⟳", dispatched: "▶", running: "▶", completed: "✓", failed: "✗", cancelled: "⊘",
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
    <div className="diff-stat">
      {stat.split(/(\++|-+)/).map((part, i) =>
        /^\++$/.test(part) ? <span key={i} className="stat-add">{part}</span>
        : /^-+$/.test(part) ? <span key={i} className="stat-del">{part}</span>
        : part,
      )}
    </div>
  );
}

/** 单条日志：时间戳 + 类型徽章 + 内容；tool_result 默认折叠成摘要，长输出截断 200px 可展开 */
function LogRow({ msg }: { msg: Msg }) {
  const [full, setFull] = useState(false);
  const text = msg.content ?? msg.output ?? msg.input_json ?? "";
  const label = msg.type === "text" ? "agent" : msg.type;
  const long = text.length > 400 || text.split("\n").length > 8;
  const body = (
    <>
      <pre className={`log-content${long && !full ? " is-clipped" : ""}`}>{text}</pre>
      {long && !full && (
        <button type="button" className="log-expand" onClick={() => setFull(true)}>展开全部</button>
      )}
    </>
  );
  return (
    <div className="log-row">
      <span className="log-time">{fmtTime(msg.created_at)}</span>
      <span className="log-badge" data-type={msg.type}>{label}{msg.tool ? `:${msg.tool}` : ""}</span>
      <div className="log-body">
        {msg.type === "tool_result" ? (
          <details className="log-detail">
            <summary>{text.split("\n")[0] || "(无输出)"}</summary>
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

  if (!task || !issue) return <div className="panel"><div className="panel-loading">加载中…</div></div>;
  const active = ["queued", "dispatched", "running"].includes(task.status);
  const showDelivery = task.status === "completed" && issue.status !== "done" && (diff !== null || merged !== null);

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
    <div className="panel">
      <header className="panel-header">
        <h1 className="panel-title">{issue.title}</h1>
        <span className="status-badge" data-status={task.status}>{STATUS_ICONS[task.status] ?? "•"} {task.status}</span>
        {active && <button className="btn-destructive" onClick={async () => { await api.cancelTask(task.id); reload(); }}>取消任务</button>}
        {props.onClose && <button className="icon-btn" aria-label="关闭" onClick={props.onClose}>✕</button>}
      </header>
      <div className="panel-body">
        {task.error && <div className="error-banner">[{task.failure_reason}] {task.error}</div>}
        {showDelivery && (
          <section className="forge-section" aria-label="交付">
            <h3 className="forge-h">交付</h3>
            <div className="delivery">
              {merged ? (
                <div className="merge-ok">✓ 已合入 {merged}</div>
              ) : diff && (
                <>
                  <div className="branch-line">
                    <code>{diff.branch}</code>
                    <span className="branch-arrow">→</span>
                    <code className="branch-base">{diff.base}</code>
                  </div>
                  <DiffStat stat={diff.diff_stat} />
                  {!showDiff && <button onClick={() => setShowDiff(true)}>查看 diff</button>}
                  {showDiff && (
                    <>
                      {diff.truncated && <div className="merge-error">内容过长已截断</div>}
                      <pre className="diff-view">
                        {diff.diff_text.split("\n").map((line, i) => {
                          const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@") ? "hunk" : "ctx";
                          return (
                            <div key={i} className="diff-line" data-kind={kind}>
                              <span className="diff-g">{kind === "add" ? "+" : kind === "del" ? "-" : ""}</span>
                              <span className="diff-c">{kind === "add" || kind === "del" ? line.slice(1) : line}</span>
                            </div>
                          );
                        })}
                      </pre>
                    </>
                  )}
                  <div className="forge-actions">
                    <button className="primary" onClick={doMerge}>合入 {diff.base}</button>
                  </div>
                  {mergeError && <div className="merge-error">{mergeError}</div>}
                  <div className="comment-form">
                    <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="打回意见…" />
                    <button className="btn-destructive" onClick={rejectAndRerun}>提交意见并重跑</button>
                  </div>
                </>
              )}
            </div>
          </section>
        )}
        <section className="forge-section" aria-label="执行日志">
          <h3 className="forge-h">执行日志</h3>
          <div className="log">
            {messages.map((m) => <LogRow key={m.seq} msg={m} />)}
            <div ref={bottomRef} />
          </div>
        </section>
        <section className="forge-section" aria-label="评论">
          <h3 className="forge-h">评论</h3>
          {comments.map((c) => (
            <div key={c.id} className="comment">
              <div className="comment-meta">
                <span className="comment-author" data-author={c.author_type}>
                  {c.author_type === "agent" ? "🤖" : c.author_type === "system" ? "⚙" : "🤵"} {c.type}
                </span>
              </div>
              <p>{c.body}</p>
            </div>
          ))}
          <div className="comment-form">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="追加指令或评论…" />
            <button onClick={async () => { if (!draft.trim()) return; await api.addComment(issue.id, draft); setDraft(""); reload(); }}>发送</button>
          </div>
        </section>
      </div>
    </div>
  );
}
