import { execFile } from "node:child_process";
import { capabilitiesFromCodexHelp } from "@anvil/core";

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
  const codexBin = env.ANVIL_CODEX_BIN || "codex";
  const codex = await tryVersion(codexBin, ["--version"]);
  if (codex) {
    const execHelp = await tryText(codexBin, ["exec", "--help"]);
    const resumeHelp = await tryText(codexBin, ["exec", "resume", "--help"]);
    const detected = execHelp && resumeHelp
      ? capabilitiesFromCodexHelp(execHelp, resumeHelp)
      : { stream: false, resume: false, structured_report: false, cancel: false };
    out.push({
      provider: "codex",
      version: codex,
      capabilities: {
        stream: detected.stream,
        resume: detected.resume,
        structured_report: detected.structured_report,
        cancel: detected.cancel,
      },
    });
  }
  return out;
}

export function tryText(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const text = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (err && !text.trim()) return resolve(null);
      resolve(text);
    });
  });
}

export function tryVersion(cmd: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      resolve((stdout || stderr).trim().split("\n")[0] ?? null);
    });
  });
}
