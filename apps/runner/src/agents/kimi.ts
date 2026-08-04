import { parseAgentLine } from "@anvil/core";
import { runCliProcess } from "./process.js";
import type { AgentBackend, AgentSession, ExecOptions } from "./backend.js";

export function buildKimiArgs(opts: { prompt: string; resume: boolean }): string[] {
  const args = ["-p", opts.prompt, "--output-format", "stream-json"];
  if (opts.resume) args.push("-c"); // 恢复当前工作目录的最近一次会话
  return args;
}

export interface KimiBackendOptions {
  command?: string;    // 默认 'kimi'，测试注入 process.execPath
  argsPrefix?: string[]; // 测试注入 fake cli 路径
}

/** Kimi Code CLI adapter。协议依据：kimi 命令官方文档（-p + --output-format stream-json）。 */
export function createKimiBackend(opts: KimiBackendOptions = {}): AgentBackend {
  const command = opts.command ?? "kimi";
  const prefix = opts.argsPrefix ?? [];
  return {
    provider: "kimi",
    execute(execOpts: ExecOptions): AgentSession {
      const p = runCliProcess({
        command,
        args: [...prefix, ...buildKimiArgs({ prompt: execOpts.prompt, resume: execOpts.resume })],
        cwd: execOpts.workDir,
        env: execOpts.env,
        parseLine: parseAgentLine,
        idleTimeoutMs: execOpts.idleTimeoutMs,
      });
      return { messages: p.messages, result: p.result, kill: p.kill };
    },
  };
}
