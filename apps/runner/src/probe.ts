import { execFile } from "node:child_process";

export interface ProbeResult {
  provider: string;
  version: string | null;
  capabilities?: Record<string, boolean> | null;
}

/** 探测本机 Kimi 与 Codex。版本命令成功只表示程序可执行，不是登录或推理成功。 */
export async function probeProviders(env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const kimi = await tryVersion(env.ANVIL_KIMI_BIN || "kimi", ["--version"]);
  if (kimi) out.push({ provider: "kimi", version: kimi });
  const codex = await tryVersion(env.ANVIL_CODEX_BIN || "codex", ["--version"]);
  if (codex) {
    out.push({
      provider: "codex",
      version: codex,
      capabilities: { stream: true, resume: true, cancel: true, structured_report: true },
    });
  }
  return out;
}

export function tryVersion(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      resolve((stdout || stderr).trim().split("\n")[0] ?? null);
    });
  });
}
