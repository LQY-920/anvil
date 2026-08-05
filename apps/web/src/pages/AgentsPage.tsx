import { useEffect, useState } from "react";
import type { Agent, Runtime } from "@anvil/core";
import * as api from "../api.js";
import type { DaemonTokenInfo } from "../api.js";
import { AGENT_STATUS_LABELS, RUNTIME_STATUS_LABELS } from "../labels.js";

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
    <div className="admin">
      <section className="admin-section">
        <h2 className="admin-section-title">Agents</h2>
        <p className="admin-section-desc">可并行执行任务的 Agent 列表。</p>
        <div className="admin-form">
          <input placeholder="新 Agent 名字" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={creating} onClick={async () => { const trimmed = name.trim(); if (!trimmed || creating) return; setCreating(true); try { await api.createAgent({ name: trimmed, provider: "kimi" }); setName(""); reload(); } finally { setCreating(false); } }}>
            创建（kimi）
          </button>
        </div>
        <table className="admin-table">
          <thead><tr><th>名字</th><th>provider</th><th>状态</th><th>并发上限</th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}><td>{a.name}</td><td>{a.provider}</td><td><span className="status-pill" data-status={a.status}>{AGENT_STATUS_LABELS[a.status] ?? a.status}</span></td><td>{a.max_concurrent_tasks}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="admin-section">
        <h2 className="admin-section-title">Runtimes</h2>
        <p className="admin-section-desc">已接入的 daemon 运行实例及其心跳状态。</p>
        <table className="admin-table">
          <thead><tr><th>daemon</th><th>provider</th><th>版本</th><th>状态</th><th>最后心跳</th></tr></thead>
          <tbody>
            {runtimes.map((r) => (
              <tr key={r.id}><td>{r.daemon_id}</td><td>{r.provider}</td><td>{r.version}</td><td><span className="status-pill" data-status={r.status}>{RUNTIME_STATUS_LABELS[r.status] ?? r.status}</span></td><td>{r.last_seen_at}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="admin-section">
        <h2 className="admin-section-title">Daemon Token</h2>
        <p className="admin-section-desc">runner 启动需要 token。明文只显示这一次，请复制后配置到 runner 的 ANVIL_DAEMON_TOKEN。</p>
        <button className="primary" disabled={generating} onClick={async () => { if (generating) return; setGenerating(true); try { const t = await api.createDaemonToken("default"); setNewToken(t.token); setCopied(false); reload(); } finally { setGenerating(false); } }}>生成新 token</button>
        {newToken && (
          <pre className="token-reveal" onClick={copyToken} title="点击复制">
            <code>{newToken}</code>
            <span className="token-reveal-hint">{copied ? "已复制" : "点击复制"}</span>
          </pre>
        )}
        <table className="admin-table token-table">
          <thead><tr><th>label</th><th>创建时间</th><th>状态</th><th></th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>{new Date(t.created_at).toLocaleString()}</td>
                <td>
                  {t.revoked_at
                    ? <span className="status-pill">已吊销</span>
                    : <span className="status-pill" data-status="online">有效</span>}
                </td>
                <td>
                  {!t.revoked_at && (
                    <button className="danger btn-sm" disabled={revokingId === t.id} onClick={() => revokeToken(t)}>吊销</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
