import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ISSUE_STATUSES, PRIORITIES, type Agent, type Issue, type IssueStatus, type Priority } from "@anvil/core";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";

export default function BoardPage() {
  const [workspaceId, setWorkspaceId] = useState("");
  const workspaceIdRef = useRef("");
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const navigate = useNavigate();

  const reload = useCallback(async () => {
    const wsId = workspaceIdRef.current;
    if (!wsId) return;
    const [i, a] = await Promise.all([api.listIssues(wsId), api.listAgents()]);
    setIssues(i);
    setAgents(a);
  }, []);

  useEffect(() => {
    (async () => {
      const boot = await api.bootstrap();
      workspaceIdRef.current = boot.workspace.id;
      setWorkspaceId(boot.workspace.id);
      await reload();
    })().catch(console.error);
  }, [reload]);
  useServerEvents(useCallback((e) => {
    if (e.type !== "issue.updated" && e.type !== "task.updated") return;
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { reload().catch(() => {}); }, 300);
  }, [reload]));

  const agentName = (issue: Issue) =>
    issue.assignee_type === "agent" ? agents.find((a) => a.id === issue.assignee_id)?.name ?? "agent" : null;

  const openIssue = async (issue: Issue) => {
    const tasks = await api.getIssueTasks(issue.id);
    const active = tasks.find((t) => ["queued", "dispatched", "running"].includes(t.status)) ?? tasks[tasks.length - 1];
    if (active) navigate(`/tasks/${active.id}`);
  };

  return (
    <div>
      <div className="toolbar">
        <h1>看板</h1>
        <button onClick={() => setShowCreate(true)}>+ 新建 issue</button>
      </div>
      <div className="board">
        {ISSUE_STATUSES.map((col: IssueStatus) => (
          <div key={col} className="column">
            <div className="column-title">{col.toUpperCase()}</div>
            {issues.filter((i) => i.status === col).map((issue) => (
              <div key={issue.id} className="card" onClick={() => openIssue(issue)}>
                <div className="card-title">{issue.title}</div>
                <div className="card-meta">
                  <span className={`prio prio-${issue.priority}`}>{issue.priority}</span>
                  {agentName(issue) && <span className="agent-tag">{agentName(issue)}</span>}
                </div>
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  <select
                    value={issue.status}
                    onChange={async (e) => { await api.updateIssue(issue.id, { status: e.target.value as IssueStatus }); reload(); }}
                  >
                    {ISSUE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  {issue.assignee_type === "agent" && (
                    <button onClick={async () => { await api.rerunIssue(issue.id); reload(); }}>重跑</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {showCreate && <CreateIssueModal workspaceId={workspaceId} agents={agents} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />}
    </div>
  );
}

function CreateIssueModal(props: { workspaceId: string; agents: Agent[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [repoPath, setRepoPath] = useState("");

  const submit = async () => {
    if (!title.trim()) return;
    await api.createIssue({
      title, description: description || undefined, priority,
      assignee_type: assigneeId ? "agent" : undefined,
      assignee_id: assigneeId || undefined,
      repo_path: repoPath || undefined,
    });
    props.onCreated();
  };

  return (
    <div className="modal-mask" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新建 issue</h2>
        <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <textarea placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
        <label>优先级
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label>指派给
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">（暂不指派）</option>
            {props.agents.map((a) => <option key={a.id} value={a.id}>🤖 {a.name}</option>)}
          </select>
        </label>
        <input placeholder="目标仓库路径（可选，如 D:/projects/foo）" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
        <div className="modal-actions">
          <button onClick={props.onClose}>取消</button>
          <button className="primary" onClick={submit}>创建</button>
        </div>
      </div>
    </div>
  );
}
