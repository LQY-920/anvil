import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment, Issue, Task, TaskDiffResponse } from "@anvil/core";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";

interface Msg { seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null; }

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

  const reload = useCallback(async () => {
    if (!taskId || inFlight.current) return;
    inFlight.current = true;
    try {
      const [detail, msgs] = await Promise.all([api.getTask(taskId), api.getTaskMessages(taskId, lastSeq.current)]);
      setTask(detail.task);
      setIssue(detail.issue);
      const fresh = msgs.filter((m) => m.seq > lastSeq.current);
      if (fresh.length > 0) {
        setMessages((prev) => [...prev, ...fresh]);
        lastSeq.current = fresh[fresh.length - 1].seq;
      }
      const d = await api.getIssueDetail(detail.issue.id);
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

  // 切换任务时清空状态，避免串任务
  useEffect(() => {
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

  if (!task || !issue) return <div className="toolbar">加载中…</div>;
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
      <div className="panel-header">
        <h1>{issue.title}</h1>
        <span className={`badge status-${task.status}`}>{task.status}</span>
        {active && <button onClick={async () => { await api.cancelTask(task.id); reload(); }}>取消任务</button>}
        {props.onClose && <button onClick={props.onClose}>✕</button>}
      </div>
      {task.error && <div className="error-banner">[{task.failure_reason}] {task.error}</div>}
      {showDelivery && (
        <div className="delivery">
          {merged ? (
            <div className="merge-ok">✓ 已合入 {merged}</div>
          ) : diff && (
            <>
              <div><strong>{diff.branch}</strong> → {diff.base}</div>
              <div className="diff-stat">{diff.diff_stat}</div>
              {!showDiff && <button onClick={() => setShowDiff(true)}>查看 diff</button>}
              {showDiff && (
                <>
                  {diff.truncated && <div className="merge-error">内容过长已截断</div>}
                  <pre className="diff-view">
                    {diff.diff_text.split("\n").map((line, i) => (
                      <div key={i} className={line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : line.startsWith("@") ? "diff-hunk" : undefined}>{line}</div>
                    ))}
                  </pre>
                </>
              )}
              <div className="card-actions">
                <button className="primary" onClick={doMerge}>合入 {diff.base}</button>
              </div>
              {mergeError && <div className="merge-error">{mergeError}</div>}
              <div className="comment-form">
                <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={2} placeholder="打回意见…" />
                <button onClick={rejectAndRerun}>提交意见并重跑</button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="sidebar">
        <h3>执行流</h3>
        <div className="stream">
          {messages.map((m) => (
            <div key={m.seq} className={`msg msg-${m.type}`}>
              <span className="msg-type">{m.type}{m.tool ? `:${m.tool}` : ""}</span>
              <pre>{m.content ?? m.output ?? m.input_json ?? ""}</pre>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <h3>评论</h3>
        {comments.map((c) => (
          <div key={c.id} className={`comment comment-${c.type}`}>
            <span className="comment-author">{c.author_type === "agent" ? "🤖" : c.author_type === "system" ? "⚙" : "👤"} {c.type}</span>
            <p>{c.body}</p>
          </div>
        ))}
        <div className="comment-form">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="追加指令或评论…" />
          <button onClick={async () => { if (!draft.trim()) return; await api.addComment(issue.id, draft); setDraft(""); reload(); }}>发送</button>
        </div>
      </div>
    </div>
  );
}
