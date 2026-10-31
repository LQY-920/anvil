import fs from "node:fs";
import path from "node:path";

function findExecutable(executable: string): string {
  if (path.isAbsolute(executable) && fs.existsSync(executable)) return executable;
  const exts = process.platform === "win32"
    ? (path.extname(executable) ? [""] : [".exe", ".cmd", ".ps1"])
    : [""];
  const names = exts.map((ext) => `${executable}${ext}`);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return executable;
}

export type CodexLaunch =
  | { ok: true; command: string; argsPrefix: string[] }
  | { ok: false; error: string };

/** 选择实际启动方式。找不到 node 入口的 .cmd 不交给 spawn，避免 Node 22 的 EINVAL。 */
export function resolveCodexLaunch(executable: string): CodexLaunch {
  const found = findExecutable(executable.trim());
  if (found.toLowerCase().endsWith(".cmd")) {
    const js = path.join(path.dirname(found), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(js)) {
      const nodeBeside = path.join(path.dirname(found), "node.exe");
      return { ok: true, command: fs.existsSync(nodeBeside) ? nodeBeside : "node", argsPrefix: [js] };
    }
    return { ok: false, error: "spawn_failed: Windows 不能直接启动 .cmd，且没有找到 codex.js" };
  }
  if (found.toLowerCase().endsWith(".ps1")) {
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { ok: true, command: powershell, argsPrefix: ["-NoProfile", "-File", found] };
  }
  return { ok: true, command: found, argsPrefix: [] };
}
