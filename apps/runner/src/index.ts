import { loadConfig } from "./config.js";
import { probeProviders } from "./probe.js";
import { ApiClient } from "./client.js";
import { Daemon } from "./poller.js";
import { createKimiBackend } from "./agents/kimi.js";
import { executeTask } from "./executor.js";

async function main() {
  const cfg = loadConfig();
  const providers = await probeProviders();
  if (providers.length === 0) {
    console.error("未探测到任何 Agent CLI（kimi）。请先安装 Kimi Code CLI。");
    process.exit(1);
  }
  const client = new ApiClient(cfg.serverUrl, cfg.daemonToken);
  const backend = createKimiBackend();
  const daemon = new Daemon(client, {
    daemonId: cfg.daemonId,
    providers,
    pollMs: 10_000,
    heartbeatMs: 15_000,
    executor: (pkg) => executeTask({ client, backend, runnerRoot: cfg.runnerRoot }, pkg),
  });
  await daemon.start();
  console.log(`anvil runner started: daemon=${cfg.daemonId}, providers=${providers.map((p) => p.provider).join(",")}`);
  process.on("SIGINT", async () => { await daemon.stop(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
