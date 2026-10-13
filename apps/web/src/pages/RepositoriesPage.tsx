import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { BindRepositoryRequest, Repository, RepositoryMode } from "@anvil/core";
import * as api from "../api.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { REPOSITORY_CONNECTION_LABELS as connectionLabels } from "../labels.js";

export function syncTime(value: string | null): string { return value ? new Date(value).toLocaleString("zh-CN") : "尚无记录"; }

function RepositoryCard({ repository, onUpdated }: { repository: Repository; onUpdated: (repo: Repository) => void }) {
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [syncFailed, setSyncFailed] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const cooldown = repository.next_sync_at ? Math.max(0, Math.ceil((Date.parse(repository.next_sync_at) - now) / 1000)) : 0;
  const stale = repository.last_synced_at && now - Date.parse(repository.last_synced_at) > 120_000;
  const act = async (kind: "sync" | "import") => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (kind === "sync") { onUpdated(await api.syncRepository(repository.id)); setSyncFailed(false); }
      else { setImported(null); setImported((await api.importRepositoryIssue(repository.id, Number(number))).issue_id); }
    } catch (e) { setError(api.apiErrorText(e)); if (kind === "sync") setSyncFailed(true); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <article className="space-y-3 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{repository.full_name}</h2><p className="text-sm text-muted-foreground">{repository.mode === "github_pr" ? "GitHub PR 交付" : "本地 Git 交付"} → {repository.target_branch}</p></div>
      <Button variant="outline" size="sm" disabled={busy || cooldown > 0} onClick={() => act("sync")}>{cooldown > 0 ? `刷新冷却 ${cooldown} 秒` : "刷新连接与远端状态"}</Button></div>
    <dl className="grid gap-1 break-all text-sm">
      <div>仓库：{repository.clone_url}</div><div>本地目录：{repository.checkout_path}</div>
      <div>连接：{syncFailed ? "最新连接检查失败，请核对错误" : connectionLabels[repository.connection_status]}{stale ? "（记录已过期，请刷新）" : ""}</div>
      <div>身份：{repository.connection_login ?? (repository.mode === "local_git" ? "本地仓库" : "未确认")}</div>
      <div>推送权限：{repository.can_push && !syncFailed && repository.connection_status === "connected" && !stale ? "已确认可推送" : "未确认当前可推送"}</div>
      <div>上次同步：{syncTime(repository.last_synced_at)} · 下次同步：{syncTime(repository.next_sync_at)}</div>
    </dl>
    {(error || repository.error) && <div role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error || repository.error}<p>请核对网络、CLI 登录及仓库权限，再刷新状态。</p></div>}
    {repository.mode === "github_pr" && <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-end gap-2"><label className="grid gap-1 text-sm">GitHub Issue 编号<Input aria-label={`${repository.full_name} 的 Issue 编号`} type="number" min="1" step="1" value={number} onChange={e => setNumber(e.target.value)} /></label>
        <Button size="sm" disabled={busy || !/^[1-9]\d*$/.test(number)} onClick={() => act("import")}>导入指定 Issue</Button></div>
      <p className="text-xs text-muted-foreground">只导入所选 Issue，不自动指派或运行 Agent。</p>
      {imported && <Link className="text-sm text-primary underline" to={`/?issue=${encodeURIComponent(imported)}`}>导入完成，打开 Issue 配置与指派</Link>}
    </div>}
  </article>;
}

export default function RepositoriesPage() {
  const [rows, setRows] = useState<Repository[] | null>(null);
  const [mode, setMode] = useState<RepositoryMode>("local_git");
  const [repo, setRepo] = useState("");
  const [checkout, setCheckout] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [rename, setRename] = useState<BindRepositoryRequest | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const load = () => api.listRepositories().then(setRows).catch(e => setError(api.apiErrorText(e)));
  useEffect(() => { void load(); }, []);
  const upsert = (r: Repository) => setRows(previous => [...(previous ?? []).filter(item => item.id !== r.id), r]);
  const bind = async (confirmRename = false) => {
    if (busyRef.current) return;
    const body: BindRepositoryRequest = confirmRename && rename ? { ...rename, confirm_rename: true } : { mode, repo: repo.trim(), ...(checkout.trim() ? { checkout_path: checkout.trim() } : {}), target_branch: branch.trim() };
    busyRef.current = true; setBusy(true); setError("");
    try { upsert(await api.bindRepository(body)); setRename(null); setConfirmed(false); }
    catch (e) { setError(api.apiErrorText(e)); if (e instanceof api.ApiError && e.code?.includes("rename")) { setRename(body); setConfirmed(false); } }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="space-y-5 overflow-auto p-6">
    <section aria-label="绑定新仓库" className="max-w-3xl space-y-3 rounded-lg border bg-card p-4">
      <h2 className="font-semibold">绑定仓库</h2>
      <label className="grid gap-1 text-sm">交付模式<select aria-label="交付模式" value={mode} onChange={e => { setMode(e.target.value as RepositoryMode); setRename(null); }} className="h-9 rounded-md border bg-background px-3"><option value="local_git">本地 Git</option><option value="github_pr">GitHub PR</option></select></label>
      <label className="grid gap-1 text-sm">{mode === "local_git" ? "本地仓库路径" : "GitHub 仓库地址（HTTPS 或 SSH）"}<Input value={repo} onChange={e => { setRepo(e.target.value); setRename(null); }} placeholder={mode === "local_git" ? "D:/projects/repo" : "https://github.com/owner/repo 或 git@github.com:owner/repo.git"} /></label>
      {mode === "github_pr" && <label className="grid gap-1 text-sm">本地 checkout 路径（可选）<Input value={checkout} onChange={e => { setCheckout(e.target.value); setRename(null); }} /></label>}
      <label className="grid gap-1 text-sm">目标分支<Input value={branch} onChange={e => { setBranch(e.target.value); setRename(null); }} /></label>
      <Button disabled={busy || !repo.trim() || !branch.trim()} onClick={() => bind()}>检查并绑定</Button>
      {rename && <div className="space-y-2 rounded-md border bg-muted p-3 text-sm"><p>同一 GitHub 仓库的名称或地址已变化。请核对上方错误中的身份信息；确认会更新现有绑定，不创建另一份仓库。</p><label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我确认这是原仓库的新名称或地址</label><Button variant="outline" disabled={!confirmed || busy} onClick={() => bind(true)}>确认名称变化并重新绑定</Button></div>}
      {error && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}
    </section>
    {rows === null ? <div className="space-y-2 text-sm">{error ? "仓库列表尚未读取成功" : "正在读取仓库…"}<Button variant="outline" onClick={load}>重新读取列表</Button></div> : rows.length === 0 ? <p className="text-sm text-muted-foreground">尚未绑定仓库。</p> : rows.map(r => <RepositoryCard key={r.id} repository={r} onUpdated={upsert} />)}
  </div>;
}
