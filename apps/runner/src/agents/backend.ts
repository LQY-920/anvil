import type { AgentMessage } from "@anvil/core";

export interface ExecOptions {
  workDir: string;
  env: Record<string, string>;
  prompt: string;
  resume: boolean;        // Kimi：是否恢复当前工作目录的最近会话（-c）
  idleTimeoutMs: number;  // 无消息判死时长
  provider?: string;
  /** Codex 只接受显式 ID。空值表示新会话，不得改用 --last。 */
  sessionRef?: string | null;
  sandbox?: "read-only" | "workspace-write";
  model?: string | null;
  outputLastMessagePath?: string | null;
  outputSchemaPath?: string | null;
}

export type AgentResultStatus = "completed" | "failed" | "aborted" | "timeout" | "cancelled";

export interface AgentResult {
  status: AgentResultStatus;
  exitCode?: number;
  error?: string;
  sessionRef?: string;
}

export interface AgentSession {
  messages: AsyncIterable<AgentMessage>;
  result: Promise<AgentResult>;
  kill: () => void;
}

export interface AgentBackend {
  provider: string;
  execute(opts: ExecOptions): AgentSession;
}
