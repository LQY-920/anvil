import { useEffect, useRef, useState } from "react";
import type { Agent, Issue, IssueSource } from "@anvil/core";
import * as api from "../api.js";
import RepositoryPicker from "./RepositoryPicker.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Textarea } from "./ui/textarea.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";

export default function IssueSettingsDialog({ issue, agents, onClose, onSaved, onSelectTask }: { issue: Issue; agents: Agent[]; onClose: () => void; onSaved: () => void; onSelectTask: (id: string) => void }) {
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.description ?? "");
  const [acceptance, setAcceptance] = useState(issue.acceptance ?? "");
  const [repository, setRepository] = useState(issue.repository_id ?? "");
  const [repoPath, setRepoPath] = useState(issue.repo_path ?? "");
  const [agent, setAgent] = useState(issue.assignee_type === "agent" ? issue.assignee_id ?? "" : "");
  const [source, setSource] = useState<IssueSource | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => { let stale = false; api.getIssueSource(issue.id).then(s => { if (!stale) setSource(s); }).catch(e => { if (!stale) setError(api.apiErrorText(e)); }); return () => { stale = true; }; }, [issue.id]);
  const save = async (run: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const before = run ? new Set((await api.getIssueTasks(issue.id)).map(t => t.id)) : null;
      await api.updateIssue(issue.id, { title: title.trim(), description, acceptance, repository_id: repository || null, ...(repository ? {} : { repo_path: repoPath || null }), assignee_type: agent ? "agent" : null, assignee_id: agent || null, ...(run && ["backlog", "done", "cancelled"].includes(issue.status) ? { status: "todo" as const } : {}) });
      if (run) {
        // 激活或新指派可能已创建任务，接续这次新任务，避免再发一遍 rerun。
        const created = (await api.getIssueTasks(issue.id)).find(t => !before!.has(t.id) && ["queued", "dispatched", "running"].includes(t.status));
        onSelectTask(created?.id ?? (await api.rerunIssue(issue.id)).id);
      }
      onSaved(); onClose();
    } catch (e) { setError(api.apiErrorText(e)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const accept = async () => {
    if (!source || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { const accepted = await api.acceptIssueSource(issue.id, source.latest.id); setSource(accepted); setTitle(accepted.accepted.title); setDescription(accepted.accepted.body); onSaved(); }
    catch (e) { setError(api.apiErrorText(e)); } finally { busyRef.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[90vh] overflow-auto sm:max-w-[560px]"><DialogHeader><DialogTitle>配置 Issue</DialogTitle></DialogHeader>
    <div className="grid gap-3"><label className="grid gap-1 text-sm">标题<Input value={title} onChange={e => setTitle(e.target.value)} /></label><label className="grid gap-1 text-sm">描述<Textarea value={description} onChange={e => setDescription(e.target.value)} /></label><label className="grid gap-1 text-sm">验收标准<Textarea value={acceptance} onChange={e => setAcceptance(e.target.value)} /></label>
      <RepositoryPicker value={repository} onChange={setRepository} />
      {!repository && <label className="grid gap-1 text-sm">自由仓库路径<Input value={repoPath} onChange={e => setRepoPath(e.target.value)} /></label>}
      <label className="grid gap-1 text-sm">执行 Agent<select aria-label="执行 Agent" className="h-9 rounded-md border bg-background px-3" value={agent} onChange={e => setAgent(e.target.value)}><option value="">暂不指派</option>{agents.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label>
      <p className="text-xs text-muted-foreground">仓库和来源修改仅用于后续任务，历史 Task 快照保持不变。选择 Agent 后保存可能触发排队；“保存并重新执行”会接续本次新建的任务。已有旧排队任务需先完成或取消。</p>
      {source && <details open={source.changed} className="space-y-2 rounded border p-2 text-sm"><summary>GitHub 来源 #{source.issue_number} · {source.changed ? "上游有更新" : "版本已接受"}</summary><p>已接受：{source.accepted.title}</p><p className="whitespace-pre-wrap">{source.accepted.body}</p>{source.changed && <><p>最新：{source.latest.title}</p><p className="whitespace-pre-wrap">{source.latest.body}</p><Button variant="outline" size="sm" disabled={busy} onClick={accept}>接受最新来源用于新任务</Button></>}</details>}
      {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
    </div><DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button variant="outline" disabled={busy || !title.trim()} onClick={() => save(false)}>保存配置</Button><Button disabled={busy || !title.trim() || !agent} onClick={() => save(true)}>保存并重新执行</Button></DialogFooter>
  </DialogContent></Dialog>;
}
