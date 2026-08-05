import { useCallback, useEffect, useRef, useState } from "react";
import { ISSUE_STATUSES, PRIORITIES, type Agent, type IssueStatus, type IssueWithTask, type LatestTaskSummary, type Priority } from "@anvil/core";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";
import TaskPanel from "../components/TaskPanel.js";
import { ISSUE_STATUS_LABELS } from "../labels.js";

export default function BoardPage() {
  const [workspaceId, setWorkspaceId] = useState("");
  const workspaceIdRef = useRef("");
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [issues, setIssues] = useState<IssueWithTask[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

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

  const agentOf = (issue: IssueWithTask) =>
    issue.assignee_type === "agent" ? agents.find((a) => a.id === issue.assignee_id) ?? null : null;

  const openIssue = async (issue: IssueWithTask) => {
    const tasks = await api.getIssueTasks(issue.id);
    const active = tasks.find((t) => ["queued", "dispatched", "running"].includes(t.status)) ?? tasks[tasks.length - 1];
    if (active) setSelectedTaskId(active.id);
  };

  return (
    <div className={selectedTaskId ? "board-root split" : "board-root"}>
      <div className="board-wrap">
        <div className="board-toolbar">
          <button className="primary" onClick={() => setShowCreate(true)}>+ 新建 issue</button>
        </div>
        <div className="board">
          {ISSUE_STATUSES.map((col: IssueStatus) => {
            const colIssues = issues.filter((i) => i.status === col);
            return (
              <section key={col} className="column" data-status={col}>
                <header className="column-title">
                  <span className="column-name">{ISSUE_STATUS_LABELS[col]}</span>
                  <span className="column-count">{colIssues.length}</span>
                </header>
                <div className="column-cards">
                  {colIssues.length === 0 && <div className="column-empty">无任务</div>}
                  {colIssues.map((issue) => {
                    const agent = agentOf(issue);
                    const selected = selectedTaskId !== null && issue.latest_task?.id === selectedTaskId;
                    return (
                      <article key={issue.id} className={cardClass(issue.latest_task, selected, issue.status)} onClick={() => openIssue(issue)}>
                        <div className="card-title">{issue.title}</div>
                        <div className="card-meta">
                          <span className={`prio prio-${issue.priority}`}>{issue.priority}</span>
                          {agent && (
                            <span className="agent-tag">
                              <span className={`presence${agent.status === "working" ? " presence-running" : ""}`} aria-hidden="true" />
                              {agent.name}
                            </span>
                          )}
                        </div>
                        <TaskChip task={issue.latest_task} issueStatus={issue.status} />
                        {issue.assignee_type === "agent" && (
                          <button
                            className="card-rerun"
                            title="重跑"
                            aria-label="重跑"
                            onClick={async (e) => { e.stopPropagation(); await api.rerunIssue(issue.id); reload(); }}
                          >↻</button>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {selectedTaskId && (
        <TaskPanel
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          onChanged={reload}
          onSelectTask={setSelectedTaskId}
        />
      )}
      {showCreate && <CreateIssueModal workspaceId={workspaceId} agents={agents} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); reload(); }} />}
    </div>
  );
}

function cardClass(t: LatestTaskSummary | null, selected: boolean, issueStatus: IssueStatus): string {
  let cls = "card";
  // 染色即"看我"：只有未完成流程的交付物才用 attention 淡染
  if (issueStatus !== "done" && issueStatus !== "cancelled" && t?.status === "completed" && parseResult(t.result_json)?.branch) cls += " card-attention";
  if (selected) cls += " is-selected";
  return cls;
}

function parseResult(resultJson: string | null): { branch?: string; diff_stat?: string } | null {
  if (!resultJson) return null;
  try { return JSON.parse(resultJson); } catch { return null; }
}

function TaskChip({ task, issueStatus }: { task: LatestTaskSummary | null; issueStatus: IssueStatus }) {
  if (!task) return null;
  // issue 已 done：不再提示“待验收”，统一显示已完成；已取消的 issue 不显示任务 chip
  if (issueStatus === "done") return <span className="task-chip chip-done">✓ 已完成</span>;
  if (issueStatus === "cancelled") return null;
  switch (task.status) {
    case "queued":
      return <span className="task-chip">⟳ 排队中</span>;
    case "dispatched":
    case "running":
      return <span className="task-chip chip-running">▶ 执行中</span>;
    case "failed":
      return <span className="task-chip chip-failed">✗ 失败 {task.attempt}/{task.max_attempts}</span>;
    case "completed": {
      const r = parseResult(task.result_json);
      if (r?.branch) {
        return (
          <>
            <span className="task-chip chip-review">📦 待验收</span>
            {r.diff_stat && <div className="diff-stat">{r.diff_stat}</div>}
          </>
        );
      }
      return <span className="task-chip chip-done">✓ 完成</span>;
    }
    case "cancelled":
      return <span className="task-chip">⊘ 已取消</span>;
    default:
      return null;
  }
}

function CreateIssueModal(props: { workspaceId: string; agents: Agent[]; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = useState("");
  const [repoPath, setRepoPath] = useState("");

  const submit = async () => {
    if (!title.trim()) return;
    await api.createIssue({
      title, description: description || undefined, acceptance: acceptance || undefined, priority,
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
        <textarea placeholder="验收标准（可选），例：pnpm test 全绿；页面无 console 报错" value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={2} />
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
