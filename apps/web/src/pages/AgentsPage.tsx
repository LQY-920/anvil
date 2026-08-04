import { useEffect, useState } from "react";
import type { Agent, Runtime } from "@anvil/core";
import * as api from "../api.js";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState("");

  const reload = async () => {
    const [a, r] = await Promise.all([api.listAgents(), api.listRuntimes()]);
    setAgents(a);
    setRuntimes(r);
  };
  useEffect(() => { reload().catch(console.error); }, []);

  return (
    <div className="admin">
      <section>
        <h2>Agents</h2>
        <div className="inline-form">
          <input placeholder="新 Agent 名字" value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={async () => { if (!name.trim()) return; await api.createAgent({ name, provider: "kimi" }); setName(""); reload(); }}>
            创建（kimi）
          </button>
        </div>
        <table>
          <thead><tr><th>名字</th><th>provider</th><th>状态</th><th>并发上限</th></tr></thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}><td>{a.name}</td><td>{a.provider}</td><td>{a.status}</td><td>{a.max_concurrent_tasks}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Runtimes</h2>
        <table>
          <thead><tr><th>daemon</th><th>provider</th><th>版本</th><th>状态</th><th>最后心跳</th></tr></thead>
          <tbody>
            {runtimes.map((r) => (
              <tr key={r.id}><td>{r.daemon_id}</td><td>{r.provider}</td><td>{r.version}</td><td>{r.status}</td><td>{r.last_seen_at}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Daemon Token</h2>
        <p className="hint">runner 启动需要 token。明文只显示这一次，请复制后配置到 runner 的 ANVIL_DAEMON_TOKEN。</p>
        <button onClick={async () => { const t = await api.createDaemonToken("default"); setNewToken(t.token); }}>生成新 token</button>
        {newToken && <pre className="token-reveal">{newToken}</pre>}
      </section>
    </div>
  );
}
