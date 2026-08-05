import { useEffect, useState } from "react";
import type { Agent, Runtime } from "@anvil/core";
import { Bot, Copy, Plus, Server } from "lucide-react";
import * as api from "../api.js";
import type { DaemonTokenInfo } from "../api.js";
import { AGENT_STATUS_LABELS, RUNTIME_STATUS_LABELS } from "../labels.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** 状态色调：徽章底色/文字色 + 圆点色 */
const TONES = {
  zinc: { badge: "border-zinc-500/20 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400", dot: "bg-zinc-400", ping: "bg-zinc-400" },
  emerald: { badge: "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500", ping: "bg-emerald-400" },
  blue: { badge: "border-blue-500/20 bg-blue-500/10 text-blue-600 dark:text-blue-400", dot: "bg-blue-500", ping: "bg-blue-400" },
  amber: { badge: "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500", ping: "bg-amber-400" },
  rose: { badge: "border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400", dot: "bg-rose-500", ping: "bg-rose-400" },
} as const;

type Tone = keyof typeof TONES;

/** 状态徽章：运行中状态（working/online）带呼吸灯圆点 */
function StatusPill({ tone, pulse, children }: { tone: Tone; pulse?: boolean; children: React.ReactNode }) {
  const t = TONES[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", t.badge)}>
      <span className="relative flex size-1.5">
        {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", t.ping)} />}
        <span className={cn("relative inline-flex size-1.5 rounded-full", t.dot)} />
      </span>
      {children}
    </span>
  );
}

const AGENT_STATUS_TONE: Record<string, { tone: Tone; pulse?: boolean }> = {
  idle: { tone: "zinc" },
  working: { tone: "emerald", pulse: true },
  blocked: { tone: "amber" },
  error: { tone: "rose" },
  offline: { tone: "zinc" },
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [tokens, setTokens] = useState<DaemonTokenInfo[]>([]);
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const reload = async () => {
    const [a, r, t] = await Promise.all([api.listAgents(), api.listRuntimes(), api.listDaemonTokens()]);
    setAgents(a);
    setRuntimes(r);
    setTokens(t);
  };
  useEffect(() => { reload().catch(console.error); }, []);

  const revokeToken = async (t: DaemonTokenInfo) => {
    if (revokingId) return;
    if (!window.confirm(`确定吊销 token「${t.label}」？使用该 token 的 runner 将无法再连接。`)) return;
    setRevokingId(t.id);
    try {
      await api.revokeDaemonToken(t.id);
      await reload();
    } finally {
      setRevokingId(null);
    }
  };

  const copyToken = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 非安全上下文剪贴板不可用时保持原样，仍可手动全选复制
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 overflow-y-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Bot className="size-4 text-muted-foreground" aria-hidden="true" />
            Agents
          </CardTitle>
          <CardDescription>可并行执行任务的 Agent 列表。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              className="w-60"
              placeholder="新 Agent 名字"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              disabled={creating || !name.trim()}
              onClick={async () => {
                const trimmed = name.trim();
                if (!trimmed || creating) return;
                setCreating(true);
                try { await api.createAgent({ name: trimmed, provider: "kimi" }); setName(""); reload(); } finally { setCreating(false); }
              }}
            >
              <Plus />
              创建（kimi）
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名字</TableHead>
                <TableHead>provider</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>并发上限</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => {
                const s = AGENT_STATUS_TONE[a.status] ?? { tone: "zinc" as const };
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.name}</TableCell>
                    <TableCell className="text-muted-foreground">{a.provider}</TableCell>
                    <TableCell>
                      <StatusPill tone={s.tone} pulse={s.pulse}>{AGENT_STATUS_LABELS[a.status] ?? a.status}</StatusPill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{a.max_concurrent_tasks}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Server className="size-4 text-muted-foreground" aria-hidden="true" />
            Runtimes
          </CardTitle>
          <CardDescription>已接入的 daemon 运行实例及其心跳状态。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>daemon</TableHead>
                <TableHead>provider</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>最后心跳</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runtimes.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.daemon_id}</TableCell>
                  <TableCell className="text-muted-foreground">{r.provider}</TableCell>
                  <TableCell className="text-muted-foreground">{r.version}</TableCell>
                  <TableCell>
                    <StatusPill tone={r.status === "online" ? "emerald" : "zinc"} pulse={r.status === "online"}>
                      {RUNTIME_STATUS_LABELS[r.status] ?? r.status}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.last_seen_at}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Daemon Token</CardTitle>
          <CardDescription>runner 启动需要 token。明文只显示这一次，请复制后配置到 runner 的 ANVIL_DAEMON_TOKEN。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Button
              disabled={generating}
              onClick={async () => {
                if (generating) return;
                setGenerating(true);
                try { const t = await api.createDaemonToken("default"); setNewToken(t.token); setCopied(false); reload(); } finally { setGenerating(false); }
              }}
            >
              <Plus />
              生成新 token
            </Button>
          </div>
          {newToken && (
            <button
              type="button"
              onClick={copyToken}
              title="点击复制"
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-left font-mono text-xs text-zinc-300"
            >
              <code className="break-all">{newToken}</code>
              <span className="flex shrink-0 select-none items-center gap-1 text-[11px] text-zinc-500">
                <Copy className="size-3" aria-hidden="true" />
                {copied ? "已复制" : "点击复制"}
              </span>
            </button>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>label</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>状态</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.label}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(t.created_at).toLocaleString()}</TableCell>
                  <TableCell>
                    {t.revoked_at
                      ? <StatusPill tone="zinc">已吊销</StatusPill>
                      : <StatusPill tone="emerald" pulse>有效</StatusPill>}
                  </TableCell>
                  <TableCell className="text-right">
                    {!t.revoked_at && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
                        disabled={revokingId === t.id}
                        onClick={() => revokeToken(t)}
                      >
                        吊销
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
