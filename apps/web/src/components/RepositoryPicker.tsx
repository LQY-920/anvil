import { useEffect, useState } from "react";
import type { Repository } from "@anvil/core";
import * as api from "../api.js";

export default function RepositoryPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let stale = false;
    api.listRepositories().then(rows => { if (!stale) setRepositories(rows); }).catch(e => { if (!stale) setError(api.apiErrorText(e)); });
    return () => { stale = true; };
  }, []);
  return <div className="space-y-1 text-sm">
    <label className="grid gap-1.5">绑定仓库
      <select aria-label="绑定仓库" className="h-9 rounded-md border bg-background px-3" value={value} onChange={e => onChange(e.target.value)}>
        <option value="">使用自由路径（历史兼容）</option>
        {value && !repositories.some(r => r.id === value) && <option value={value}>当前绑定（正在读取）</option>}
        {repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.full_name} · {repo.mode === "github_pr" ? "GitHub PR" : "本地 Git"} → {repo.target_branch}</option>)}
      </select>
    </label>
    {error && <p role="alert" className="text-destructive">仓库列表读取失败：{error}</p>}
    <a className="text-primary underline" href="/repositories">管理仓库绑定</a>
  </div>;
}
