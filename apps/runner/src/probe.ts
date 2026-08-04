import { execFile } from "node:child_process";

export interface ProbeResult { provider: string; version: string | null; }

/** 探测本机可用的 Agent CLI。初版只探 kimi。 */
export async function probeProviders(): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const version = await tryVersion("kimi", ["--version"]);
  if (version) out.push({ provider: "kimi", version });
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
