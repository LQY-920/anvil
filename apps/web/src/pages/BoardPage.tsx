import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ISSUE_STATUSES,
  PRIORITIES,
  type Agent,
  type IssueStatus,
  type IssueWithTask,
  type LatestTaskSummary,
  type Priority,
} from "@anvil/core";
import {
  AlertCircle,
  ArrowDown,
  Ban,
  Bot,
  CheckCircle2,
  Circle,
  Clock,
  Eye,
  Flame,
  FolderGit2,
  Inbox,
  Loader2,
  Package,
  Play,
  Plus,
  RotateCcw,
  SignalMedium,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import * as api from "../api.js";
import { useServerEvents } from "../ws.js";
import TaskPanel from "../components/TaskPanel.js";
import { ISSUE_STATUS_LABELS } from "../labels.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** 列状态图标（Lucide），语义色与状态徽章一致 */
const COLUMN_ICONS: Record<IssueStatus, { icon: LucideIcon; className: string }> = {
  backlog: { icon: Inbox, className: "text-zinc-400" },
  todo: { icon: Circle, className: "text-zinc-400" },
  in_progress: { icon: Loader2, className: "text-blue-500" },
  in_review: { icon: Eye, className: "text-purple-500" },
  done: { icon: CheckCircle2, className: "text-emerald-500" },
  blocked: { icon: Ban, className: "text-rose-500" },
  cancelled: { icon: XCircle, className: "text-zinc-400" },
};

/** 优先级徽章：图标 + 语义色（none 不展示徽章，减少噪音） */
const PRIORITY_META: Partial<Record<Priority, { icon: LucideIcon; className: string }>> = {
  urgent: { icon: Flame, className: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  high: { icon: AlertCircle, className: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400" },
  medium: { icon: SignalMedium, className: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  low: { icon: ArrowDown, className: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400" },
};

export default function BoardPage() {
  const [workspaceId, setWorkspaceId] = useState("");
  const workspaceIdRef = useRef("");
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [issues, setIssues] = useState<IssueWithTask[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [recentRepos, setRecentRepos] = useState<string[]>([]);
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
      setRecentRepos(boot.recent_repos ?? []);
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
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-end px-6 pt-4">
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus />
            新建 Issue
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto p-6 pt-3">
          {ISSUE_STATUSES.map((col: IssueStatus) => {
            const colIssues = issues.filter((i) => i.status === col);
            const colMeta = COLUMN_ICONS[col];
            const ColIcon = colMeta.icon;
            return (
              <section key={col} className="flex min-h-0 w-[320px] shrink-0 flex-col rounded-lg bg-muted/50 p-2">
                <header className="flex items-center gap-2 px-1.5 pb-2 pt-1">
                  <ColIcon className={cn("size-4 shrink-0", colMeta.className)} aria-hidden="true" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {ISSUE_STATUS_LABELS[col]}
                  </span>
                  <Badge variant="secondary" className="px-1.5">{colIssues.length}</Badge>
                  <button
                    type="button"
                    aria-label={`在「${ISSUE_STATUS_LABELS[col]}」列创建任务`}
                    className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setShowCreate(true)}
                  >
                    <Plus className="size-4" />
                  </button>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-0.5">
                  {colIssues.length === 0 && (
                    <div className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border/50 text-xs text-muted-foreground/50">
                      无任务
                    </div>
                  )}
                  {colIssues.map((issue) => {
                    const agent = agentOf(issue);
                    const selected = selectedTaskId !== null && issue.latest_task?.id === selectedTaskId;
                    return (
                      <TaskCard
                        key={issue.id}
                        issue={issue}
                        agent={agent}
                        selected={selected}
                        onOpen={() => openIssue(issue)}
                        onRerun={async () => { await api.rerunIssue(issue.id); reload(); }}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
      {selectedTaskId && (
        <div className="h-full w-[42%] min-w-[420px] max-w-[640px] shrink-0 border-l">
          <TaskPanel
            taskId={selectedTaskId}
            onClose={() => setSelectedTaskId(null)}
            onChanged={reload}
            onSelectTask={setSelectedTaskId}
          />
        </div>
      )}
      <CreateIssueModal
        open={showCreate}
        workspaceId={workspaceId}
        agents={agents}
        recentRepos={recentRepos}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); reload(); }}
      />
    </div>
  );
}

function TaskCard(props: {
  issue: IssueWithTask;
  agent: Agent | null;
  selected: boolean;
  onOpen: () => void;
  onRerun: () => Promise<void>;
}) {
  const { issue, agent } = props;
  const t = issue.latest_task;
  // 染色即"看我"：只有未完成流程的交付物才用 attention 淡染
  const attention =
    issue.status !== "done" && issue.status !== "cancelled" &&
    t?.status === "completed" && !!parseResult(t.result_json)?.branch;
  const prio = PRIORITY_META[issue.priority];

  return (
    <Card
      className={cn(
        "group relative cursor-pointer space-y-2 p-3.5 transition-all hover:border-primary/50",
        props.selected && "border-primary",
        attention && "border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60",
      )}
      onClick={props.onOpen}
    >
      <div className="line-clamp-2 text-sm font-medium leading-5">{issue.title}</div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {prio && (
          <Badge variant="outline" className={prio.className}>
            <prio.icon />
            {issue.priority}
          </Badge>
        )}
        {agent && (
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="relative flex size-1.5 shrink-0">
              {agent.status === "working" && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              )}
              <span
                className={cn(
                  "relative inline-flex size-1.5 rounded-full",
                  agent.status === "working" ? "bg-emerald-500" : "bg-zinc-400",
                )}
              />
            </span>
            <Bot className="size-3 shrink-0" />
            <span className="truncate">{agent.name}</span>
          </span>
        )}
      </div>
      <TaskChip task={t} issueStatus={issue.status} />
      {issue.assignee_type === "agent" && (
        <button
          type="button"
          title="重跑"
          aria-label="重跑"
          className="absolute right-2.5 top-2.5 rounded-md border bg-card p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={async (e) => { e.stopPropagation(); await props.onRerun(); }}
        >
          <RotateCcw className="size-3.5" />
        </button>
      )}
    </Card>
  );
}

function parseResult(resultJson: string | null): { branch?: string; diff_stat?: string } | null {
  if (!resultJson) return null;
  try { return JSON.parse(resultJson); } catch { return null; }
}

function TaskChip({ task, issueStatus }: { task: LatestTaskSummary | null; issueStatus: IssueStatus }) {
  if (!task) return null;
  const chip = (className: string, icon: ReactNode, text: string) => (
    <Badge variant="outline" className={className}>
      {icon}
      {text}
    </Badge>
  );
  const zinc = "border-zinc-500/20 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400";
  const blue = "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400";
  const rose = "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400";
  const amber = "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  const emerald = "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

  // issue 已 done：不再提示“待验收”，统一显示已完成；已取消的 issue 不显示任务 chip
  if (issueStatus === "done") return chip(emerald, <CheckCircle2 />, "已完成");
  if (issueStatus === "cancelled") return null;
  switch (task.status) {
    case "queued":
      return chip(zinc, <Clock />, "排队中");
    case "dispatched":
    case "running":
      return chip(blue, <Play />, "执行中");
    case "failed":
      return chip(rose, <XCircle />, `失败 ${task.attempt}/${task.max_attempts}`);
    case "completed": {
      const r = parseResult(task.result_json);
      if (r?.branch) {
        return (
          <div className="space-y-1">
            {chip(amber, <Package />, "待验收")}
            {r.diff_stat && (
              <div className="whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground">{r.diff_stat}</div>
            )}
          </div>
        );
      }
      return chip(emerald, <CheckCircle2 />, "完成");
    }
    case "cancelled":
      return chip(zinc, <Ban />, "已取消");
    default:
      return null;
  }
}

function CreateIssueModal(props: { open: boolean; workspaceId: string; agents: Agent[]; recentRepos: string[]; onClose: () => void; onCreated: () => void }) {
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
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>新建 Issue</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input placeholder="输入任务标题..." value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <Textarea placeholder="描述（可选）" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
          <Textarea
            placeholder="验收标准（可选），例：pnpm test 全绿；页面无 console 报错"
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            rows={2}
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="issue-priority">优先级</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
                <SelectTrigger id="issue-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="issue-assignee">指派给</Label>
              <Select value={assigneeId || "__none__"} onValueChange={(v) => setAssigneeId(v === "__none__" ? "" : v)}>
                <SelectTrigger id="issue-assignee">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">（暂不指派）</SelectItem>
                  {props.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="flex items-center gap-1.5">
                        <Bot className="size-3.5" />
                        {a.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="relative">
            <FolderGit2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              className="pl-9"
              placeholder="目标仓库路径（可选，如 D:/projects/foo）"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
            />
          </div>
          {props.recentRepos.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {props.recentRepos.map((r) => (
                <button
                  key={r}
                  type="button"
                  title={r}
                  className="max-w-full truncate rounded-full border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  onClick={() => setRepoPath(r)}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>取消</Button>
          <Button onClick={submit} disabled={!title.trim()}>
            <Plus />
            创建任务
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
