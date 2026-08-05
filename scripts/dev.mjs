// 某些 Windows 机器用户 PATH 缺 System32，concurrently spawn cmd.exe 会 ENOENT；
// 进程内补齐（不改系统环境），其他平台无操作。
if (process.platform === "win32") {
  process.env.PATH = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.PATH}`;
}

import concurrently from "concurrently";

concurrently([
  { command: "pnpm dev:server", name: "server", prefixColor: "blue" },
  { command: "pnpm dev:web", name: "web", prefixColor: "green" },
  { command: "pnpm dev:runner", name: "runner", prefixColor: "yellow" },
]);
