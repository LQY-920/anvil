import type { AgentMessage } from "./messages.js";

/** 帮助成功不是登录成功。这些状态互斥。 */
export const AUTH_STATES = ["missing", "unsupported_version", "auth_not_checked", "executable", "run_failed"] as const;
export type AuthState = (typeof AUTH_STATES)[number];

export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write"] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const EXECUTION_SNAPSHOT_SCHEMA = "anvil.execution_snapshot.v1" as const;

export interface CodexCapabilities {
  stream: boolean;
  resume: boolean;
  cancel: boolean;
  structured_report: boolean;
}

/** 0.147.0 的帮助已确认这些开关存在。批准行为仍未由模型探针冻结。 */
export const CODEX_HELP_CAPABILITIES: CodexCapabilities = {
  stream: true,
  resume: true,
  cancel: true,
  structured_report: true,
};

export interface ExecutionSnapshot {
  schema: typeof EXECUTION_SNAPSHOT_SCHEMA;
  provider: "codex";
  profile_id: string | null;
  config_version: number;
  executable: string;
  sandbox: CodexSandboxMode;
  model: string | null;
  cli_version: string | null;
  capabilities: CodexCapabilities;
}

export interface CodexParseState {
  sessionRef: string | null;
  sawTurnCompleted: boolean;
  sawTurnFailed: boolean;
  sawError: boolean;
  sawApproval: boolean;
  invalid: boolean;
}

export const CODEX_MAX_EVENT_CHARS = 262144;

export function emptyCodexParseState(): CodexParseState {
  return { sessionRef: null, sawTurnCompleted: false, sawTurnFailed: false, sawError: false, sawApproval: false, invalid: false };
}

function clip(value: unknown, max = 8000): string {
  return String(value ?? "").slice(0, max);
}

/** 解析一行 Codex JSONL。未知事件只作诊断，不能据此判成功。形状在真实探针前仍未冻结。 */
export function parseCodexLine(line: string, state: CodexParseState): AgentMessage | null {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed) return null;
  if (trimmed.length > CODEX_MAX_EVENT_CHARS) {
    state.invalid = true;
    return { type: "log", content: "codex 事件超过长度上限" };
  }
  let obj: unknown;
  try { obj = JSON.parse(trimmed); }
  catch {
    state.invalid = true;
    return { type: "error", content: "codex 输出不是合法 JSON" };
  }
  if (obj == null || typeof obj !== "object") {
    state.invalid = true;
    return { type: "error", content: "codex 输出不是 JSON 对象" };
  }
  const record = obj as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "thread.started") {
    if (typeof record.thread_id === "string" && record.thread_id.trim()) state.sessionRef = record.thread_id.trim();
    return { type: "status", content: "thread.started" };
  }
  if (type === "turn.started") return { type: "status", content: "turn.started" };
  if (type === "turn.completed") {
    state.sawTurnCompleted = true;
    return { type: "status", content: "turn.completed" };
  }
  if (type === "turn.failed") {
    state.sawTurnFailed = true;
    return { type: "error", content: "turn.failed" };
  }
  if (type === "error") {
    state.sawError = true;
    const message = clip(record.message);
    if (/approval|批准/i.test(message)) {
      state.sawApproval = true;
      return { type: "error", content: message || "需要批准" };
    }
    return { type: "error", content: message || "codex error" };
  }
  if (type === "item.started" || type === "item.updated" || type === "item.completed") {
    const item = record.item && typeof record.item === "object" ? record.item as Record<string, unknown> : {};
    const itemType = String(item.type ?? item.item_type ?? "unknown");
    if (itemType === "agent_message" || itemType === "assistant_message") {
      return { type: "text", content: clip(item.text) };
    }
    if (itemType === "command_execution") {
      return { type: "tool_use", tool: "command", input: { command: clip(item.command, 2000), status: item.status ?? null } };
    }
    return { type: "log", content: `codex:${type}:${itemType}` };
  }
  return { type: "log", content: `codex:unknown:${clip(type || "missing", 80)}` };
}

export function classifyCodexResult(state: CodexParseState, exitCode: number | null): { status: "completed" | "failed"; exitCode?: number; error?: string } {
  if (state.sawApproval) return { status: "failed", exitCode: exitCode ?? undefined, error: "approval_blocked" };
  if (state.invalid || state.sawTurnFailed || state.sawError) {
    return { status: "failed", exitCode: exitCode ?? undefined, error: "protocol_error" };
  }
  if (exitCode === 0 && state.sawTurnCompleted) return { status: "completed", exitCode: 0 };
  if (exitCode === 0) return { status: "failed", exitCode: 0, error: "protocol_error" };
  return { status: "failed", exitCode: exitCode ?? -1, error: "non_zero_exit" };
}

const RESERVED_PROFILE_KEYS = new Set([
  "args", "prompt", "--json", "--last", "--all", "--ephemeral", "--output-schema", "-o", "--output-last-message",
  "-C", "--cd", "--ask-for-approval", "--dangerously-bypass-approvals-and-sandbox", "--approve-for-me",
]);

export function rejectReservedProfileFields(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (RESERVED_PROFILE_KEYS.has(key)) return `平台保留参数不能由配置覆盖：${key}`;
  }
  return null;
}

export function parseExecutionSnapshot(raw: string | null | undefined): ExecutionSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as ExecutionSnapshot;
    if (value?.schema !== EXECUTION_SNAPSHOT_SCHEMA || value.provider !== "codex") return null;
    return value;
  } catch {
    return null;
  }
}

export function capabilitiesMatch(required: CodexCapabilities | undefined, actual: CodexCapabilities | null): boolean {
  if (!required) return true;
  if (!actual) return false;
  return (!required.stream || actual.stream)
    && (!required.resume || actual.resume)
    && (!required.cancel || actual.cancel)
    && (!required.structured_report || actual.structured_report);
}
