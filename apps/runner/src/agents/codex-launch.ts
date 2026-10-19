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

/** 选择实际启动方式。Windows 上优先原生 exe，其次 .cmd；`.ps1` 改走 powershell -File。参数保持数组。 */
export function resolveCodexLaunch(executable: string): { command: string; argsPrefix: string[] } {
  const found = findExecutable(executable.trim());
  if (found.toLowerCase().endsWith(".cmd")) {
    const js = path.join(path.dirname(found), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(js)) {
      const nodeBeside = path.join(path.dirname(found), "node.exe");
      return { command: fs.existsSync(nodeBeside) ? nodeBeside : "node", argsPrefix: [js] };
    }
  }
  if (found.toLowerCase().endsWith(".ps1")) {
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { command: powershell, argsPrefix: ["-NoProfile", "-File", found] };
  }
  return { command: found, argsPrefix: [] };
}
