import type { AgentMessage } from "@anvil/core";

export interface ExecOptions {
  workDir: string;
  env: Record<string, string>;
  prompt: string;
  resume: boolean;        // 是否恢复上次会话（同 workDir 的 -c）
  idleTimeoutMs: number;  // 无消息判死时长
}

export type AgentResultStatus = "completed" | "failed" | "aborted" | "timeout" | "cancelled";

export interface AgentResult {
  status: AgentResultStatus;
  exitCode?: number;
  error?: string;
}

export interface AgentSession {
  messages: AsyncIterable<AgentMessage>;
  result: Promise<AgentResult>;
}

export interface AgentBackend {
  provider: string;
  execute(opts: ExecOptions): AgentSession;
}
