import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export interface RunnerConfig {
  serverUrl: string;    // ANVIL_SERVER_URL
  daemonToken: string;  // ANVIL_DAEMON_TOKEN
  daemonId: string;     // 持久化在 <runnerRoot>/daemon.json
  runnerRoot: string;   // ANVIL_RUNNER_ROOT，默认 ~/.anvil
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const runnerRoot = env.ANVIL_RUNNER_ROOT ?? path.join(os.homedir(), ".anvil");
  fs.mkdirSync(runnerRoot, { recursive: true });
  const stateFile = path.join(runnerRoot, "daemon.json");
  let daemonId = "";
  if (fs.existsSync(stateFile)) {
    daemonId = JSON.parse(fs.readFileSync(stateFile, "utf8")).daemon_id;
  } else {
    daemonId = `daemon-${crypto.randomBytes(6).toString("hex")}`;
    fs.writeFileSync(stateFile, JSON.stringify({ daemon_id: daemonId }, null, 2));
  }
  const serverUrl = env.ANVIL_SERVER_URL ?? "http://127.0.0.1:3100";
  const daemonToken = env.ANVIL_DAEMON_TOKEN ?? "";
  if (!daemonToken) throw new Error("ANVIL_DAEMON_TOKEN 未设置（在 web 的 Agents 页创建）");
  return { serverUrl, daemonToken, daemonId, runnerRoot };
}
