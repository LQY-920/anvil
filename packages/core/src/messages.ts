export const MESSAGE_TYPES = ["text","thinking","tool_use","tool_result","status","error","log"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface AgentMessage {
  type: MessageType;
  tool?: string;
  content?: string;
  input?: unknown;
  output?: unknown;
}

/** 把一行 CLI stdout 解析为统一消息；解析不了的原样包成 log。空行返回 null。 */
export function parseAgentLine(line: string): AgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: any;
  try { obj = JSON.parse(trimmed); } catch { return { type: "log", content: line }; }
  if (obj == null || typeof obj !== "object") return { type: "log", content: line };
  if (obj.role === "assistant") {
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      const tc = obj.tool_calls[0];
      return { type: "tool_use", tool: String(tc.name ?? tc.function?.name ?? "unknown"), input: tc.input ?? tc.function?.arguments };
    }
    const parts = Array.isArray(obj.content) ? obj.content : [{ type: "text", text: String(obj.content ?? "") }];
    const text = parts.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("\n");
    return { type: "text", content: text };
  }
  if (obj.role === "tool") {
    return { type: "tool_result", tool: String(obj.name ?? "unknown"), output: typeof obj.content === "string" ? obj.content : JSON.stringify(obj.content) };
  }
  return { type: "log", content: line };
}
