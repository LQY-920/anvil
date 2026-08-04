import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Comment, Issue, Task } from "@anvil/core";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";

interface Msg { seq: number; type: string; tool: string | null; content: string | null; input_json: string | null; output: string | null; }

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const lastSeq = useRef(-1);
  const bottomRef = useRef<HTMLDivElement>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (!id || inFlight.current) return;
    inFlight.current = true;
    try {
      const [detail, msgs] = await Promise.all([api.getTask(id), api.getTaskMessages(id, lastSeq.current)]);
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
  }, [id]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { reload().catch(() => {}); }, 300);
  }, [reload]);

  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  useEffect(() => { reload().catch(console.error); }, [reload]);
  useServerEvents(useCallback((e) => {
    const data = e.data as any;
    if (e.type === "task.message" && data?.task_id === id) scheduleReload();
    if (e.type === "task.updated" && data?.id === id) scheduleReload();
  }, [id, scheduleReload]));
  useEffect(() => { bottomRef.current?.scrollIntoView?.({ behavior: "smooth" }); }, [messages.length]);

  if (!task || !issue) return <div className="toolbar">加载中…</div>;
  const active = ["queued", "dispatched", "running"].includes(task.status);

  return (
    <div className="detail">
      <div className="toolbar">
        <Link to="/">← 看板</Link>
        <h1>{issue.title}</h1>
        <span className={`badge status-${task.status}`}>{task.status}</span>
        {active && <button onClick={async () => { await api.cancelTask(task.id); reload(); }}>取消任务</button>}
        {!active && (
          <button onClick={async () => { const t = await api.rerunIssue(issue.id); navigate(`/tasks/${t.id}`); }}>重跑</button>
        )}
      </div>
      {task.error && <div className="error-banner">[{task.failure_reason}] {task.error}</div>}
      <div className="detail-body">
        <div className="stream">
          {messages.map((m) => (
            <div key={m.seq} className={`msg msg-${m.type}`}>
              <span className="msg-type">{m.type}{m.tool ? `:${m.tool}` : ""}</span>
              <pre>{m.content ?? m.output ?? m.input_json ?? ""}</pre>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="sidebar">
          <h3>Issue</h3>
          <p className="desc">{issue.description || "（无描述）"}</p>
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
    </div>
  );
}
