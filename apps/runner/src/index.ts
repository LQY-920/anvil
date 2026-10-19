import { loadConfig } from "./config.js";
import { probeProviders } from "./probe.js";
import { ApiClient } from "./client.js";
import { Daemon } from "./poller.js";
import { createKimiBackend } from "./agents/kimi.js";
import { createCodexBackend } from "./agents/codex.js";
import { createRoutingBackend } from "./agents/router.js";
import { executeTask } from "./executor.js";
import type { AgentBackend } from "./agents/backend.js";

async function main() {
  const cfg = loadConfig();
  const providers = await probeProviders();
  if (providers.length === 0) {
    console.error("未探测到 Kimi 或 Codex。找不到 Codex 时不会改派到 Kimi；请安装 Codex CLI 或确认它在 PATH 中。");
    process.exit(1);
  }
  const client = new ApiClient(cfg.serverUrl, cfg.daemonToken);
  const backends: AgentBackend[] = [];
  if (providers.some((p) => p.provider === "kimi")) backends.push(createKimiBackend());
  if (providers.some((p) => p.provider === "codex")) backends.push(createCodexBackend({ command: process.env.ANVIL_CODEX_BIN || "codex" }));
  const backend = createRoutingBackend(backends);
  const daemon = new Daemon(client, {
    daemonId: cfg.daemonId,
    providers,
    pollMs: 10_000,
    heartbeatMs: 15_000,
    // A03 · 显式把 cfg.daemonId 传给 executor,不能从 process.env 读取
    executor: (pkg) => executeTask({ client, backend, runnerRoot: cfg.runnerRoot, daemonId: cfg.daemonId }, pkg),
  });
  await daemon.start();
  console.log(`anvil runner started: daemon=${cfg.daemonId}, providers=${providers.map((p) => p.provider).join(",")}`);
  process.on("SIGINT", async () => { await daemon.stop(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
