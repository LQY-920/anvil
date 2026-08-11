/** 执行日志消息 → 渲染条目 的纯函数层：kind 决定布局，tone 决定配色，defaultCollapsed 决定初始折叠 */

export interface TraceMessage {
  seq: number;
  type: string;
  tool: string | null;
  content: string | null;
  input_json: string | null;
  output: string | null;
  created_at?: string | null;
}

export type EntryKind = "text" | "thinking" | "tool_use" | "tool_result" | "status" | "error" | "log" | "unknown";
export type EntryTone = "normal" | "muted" | "destructive";

export interface RenderEntry {
  kind: EntryKind;
  title: string;
  body?: string;
  defaultCollapsed: boolean;
  tone: EntryTone;
}

/** 正文取值顺序：content → output → 原始 input_json */
function rawText(msg: TraceMessage): string {
  return msg.content ?? msg.output ?? msg.input_json ?? "";
}

/** 单行化：多行内容折成一行便于标题展示 */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 长路径截断为 .../父目录/叶文件名（超 40 字符或层级过深时） */
export function truncatePath(p: string): string {
  const segs = p.split(/[\\/]/).filter(Boolean);
  if (p.length <= 40 && segs.length <= 3) return p;
  if (segs.length >= 2) return `.../${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
  return truncate(p, 40);
}

function parseInput(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    let v: unknown = JSON.parse(raw);
    // 历史数据存在双重编码（落库前 input 已是字符串）：第一次 parse 得到字符串则再试一次
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch { return null; }
    }
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pickString(input: Record<string, unknown> | null, keys: string[]): string | null {
  if (!input) return null;
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** 各工具的关键参数字段；未列出的工具退化为 input JSON 摘要 */
const TOOL_PARAM_KEYS: Record<string, string[]> = {
  Bash: ["command"],
  Shell: ["command"],
  Read: ["file_path", "path"],
  Write: ["file_path", "path"],
  Edit: ["file_path", "path"],
  Grep: ["pattern"],
  Glob: ["pattern"],
  WebSearch: ["query"],
};

const PATH_TOOLS = new Set(["Read", "Write", "Edit"]);

/** tool_use 单行摘要：`工具名 关键参数`（路径截断；缺关键参数键或其他工具退化为 JSON 摘要，限 80 字符） */
export function toolSummary(msg: TraceMessage): string {
  const tool = msg.tool ?? "tool";
  const input = parseInput(msg.input_json);
  const keys = TOOL_PARAM_KEYS[tool];
  if (keys) {
    const v = pickString(input, keys);
    if (v) return `${tool} ${oneLine(PATH_TOOLS.has(tool) ? truncatePath(v) : v)}`;
    // 已知工具但缺关键参数键：不退化为裸工具名，落到下面的 JSON 摘要
  }
  if (msg.input_json) {
    const compact = input ? JSON.stringify(input) : msg.input_json;
    return `${tool} ${truncate(oneLine(compact), 80)}`;
  }
  return tool;
}

export function messageToEntry(msg: TraceMessage): RenderEntry {
  const text = rawText(msg);
  switch (msg.type) {
    case "text":
      return { kind: "text", title: text, defaultCollapsed: false, tone: "normal" };
    case "error":
      return { kind: "error", title: text, defaultCollapsed: false, tone: "destructive" };
    case "tool_use":
      return { kind: "tool_use", title: toolSummary(msg), body: msg.output ?? msg.content ?? undefined, defaultCollapsed: true, tone: "normal" };
    case "thinking":
      return { kind: "thinking", title: text.split("\n")[0], body: text || undefined, defaultCollapsed: true, tone: "muted" };
    case "tool_result":
      return { kind: "tool_result", title: text.split("\n")[0] || "(无输出)", body: text || undefined, defaultCollapsed: true, tone: "muted" };
    case "status":
      return { kind: "status", title: oneLine(text), defaultCollapsed: false, tone: "muted" };
    case "log":
      return { kind: "log", title: oneLine(text), defaultCollapsed: false, tone: "muted" };
    default:
      // 未知类型保底：内容原样可见，绝不丢弃
      return { kind: "unknown", title: text, defaultCollapsed: false, tone: "normal" };
  }
}

export interface ProgressSummary {
  toolCalls: number;
  errors: number;
  latest: string;
}

/** 进度摘要：工具调用数、错误数、最近动态（最近一条 tool_use 摘要，否则最近 text 前 40 字符） */
export function summarizeProgress(messages: TraceMessage[]): ProgressSummary {
  let toolCalls = 0;
  let errors = 0;
  let latestTool: TraceMessage | null = null;
  let latestText: TraceMessage | null = null;
  for (const m of messages) {
    if (m.type === "tool_use") {
      toolCalls += 1;
      latestTool = m;
    } else if (m.type === "error") {
      errors += 1;
    } else if (m.type === "text") {
      latestText = m;
    }
  }
  const latest = latestTool
    ? toolSummary(latestTool)
    : latestText
      ? truncate(oneLine(rawText(latestText)), 40)
      : "";
  return { toolCalls, errors, latest };
}
