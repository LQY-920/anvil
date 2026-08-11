import { describe, it, expect } from "vitest";
import { messageToEntry, summarizeProgress, truncatePath, type TraceMessage } from "../src/lib/trace-presenter.js";

function msg(partial: Partial<TraceMessage>): TraceMessage {
  return { seq: 1, type: "text", tool: null, content: null, input_json: null, output: null, created_at: null, ...partial };
}

describe("messageToEntry", () => {
  it("text → 展开、正文色", () => {
    const e = messageToEntry(msg({ type: "text", content: "你好，世界" }));
    expect(e).toEqual({ kind: "text", title: "你好，世界", defaultCollapsed: false, tone: "normal" });
  });

  it("thinking → 默认折叠，标题取首行", () => {
    const e = messageToEntry(msg({ type: "thinking", content: "先想一下\n再动手" }));
    expect(e).toEqual({ kind: "thinking", title: "先想一下", body: "先想一下\n再动手", defaultCollapsed: true, tone: "muted" });
  });

  it("tool_use → 单行摘要、默认折叠、body 取 output", () => {
    const e = messageToEntry(msg({ type: "tool_use", tool: "Bash", input_json: JSON.stringify({ command: "pnpm test" }), output: "ok" }));
    expect(e).toEqual({ kind: "tool_use", title: "Bash pnpm test", body: "ok", defaultCollapsed: true, tone: "normal" });
  });

  it("tool_result → 默认折叠，空输出标题兜底", () => {
    const e = messageToEntry(msg({ type: "tool_result", output: "第一行\n第二行" }));
    expect(e).toEqual({ kind: "tool_result", title: "第一行", body: "第一行\n第二行", defaultCollapsed: true, tone: "muted" });
    expect(messageToEntry(msg({ type: "tool_result" })).title).toBe("(无输出)");
  });

  it("status → 单行 muted、展开", () => {
    const e = messageToEntry(msg({ type: "status", content: "排队中" }));
    expect(e).toEqual({ kind: "status", title: "排队中", defaultCollapsed: false, tone: "muted" });
  });

  it("error → 展开、destructive", () => {
    const e = messageToEntry(msg({ type: "error", content: "炸了" }));
    expect(e).toEqual({ kind: "error", title: "炸了", defaultCollapsed: false, tone: "destructive" });
  });

  it("log → 单行 muted、展开", () => {
    const e = messageToEntry(msg({ type: "log", content: "daemon started" }));
    expect(e).toEqual({ kind: "log", title: "daemon started", defaultCollapsed: false, tone: "muted" });
  });

  it("未知 type → unknown 保底，内容原样可见", () => {
    const e = messageToEntry(msg({ type: "telemetry", content: "原始内容" }));
    expect(e).toEqual({ kind: "unknown", title: "原始内容", defaultCollapsed: false, tone: "normal" });
    // content 全空时退到 input_json 原文，绝不丢弃
    expect(messageToEntry(msg({ type: "telemetry", input_json: "{\"a\":1}" })).title).toBe("{\"a\":1}");
  });
});

describe("tool_use 关键参数提取", () => {
  const toolEntry = (tool: string, input: unknown) =>
    messageToEntry(msg({ type: "tool_use", tool, input_json: typeof input === "string" ? input : JSON.stringify(input) }));

  it("Bash → command，多行折成单行", () => {
    expect(toolEntry("Bash", { command: "pnpm install\npnpm test" }).title).toBe("Bash pnpm install pnpm test");
  });

  it("Read/Write/Edit → file_path 或 path", () => {
    expect(toolEntry("Read", { file_path: "src/a.ts" }).title).toBe("Read src/a.ts");
    expect(toolEntry("Write", { path: "src/b.ts" }).title).toBe("Write src/b.ts");
  });

  it("Grep/Glob → pattern；WebSearch → query", () => {
    expect(toolEntry("Grep", { pattern: "useState" }).title).toBe("Grep useState");
    expect(toolEntry("Glob", { pattern: "**/*.ts" }).title).toBe("Glob **/*.ts");
    expect(toolEntry("WebSearch", { query: "fastify websocket" }).title).toBe("WebSearch fastify websocket");
  });

  it("其他工具 → input JSON 摘要截断 80 字符", () => {
    const e = toolEntry("CustomTool", { payload: "x".repeat(100) });
    expect(e.title.startsWith("CustomTool ")).toBe(true);
    expect(e.title.length).toBe("CustomTool ".length + 81); // 80 字符 + 省略号
  });

  it("无 input_json → 只有工具名", () => {
    expect(messageToEntry(msg({ type: "tool_use", tool: "Bash" })).title).toBe("Bash");
  });

  it("input_json 双重编码（历史数据）→ 仍能提取参数", () => {
    const doubleEncoded = JSON.stringify(JSON.stringify({ command: "git status" }));
    expect(toolEntry("Bash", doubleEncoded).title).toBe("Bash git status");
  });

  it("已知工具缺关键参数键 → 退化为 JSON 摘要而非裸工具名", () => {
    expect(toolEntry("Bash", { cmd: "ls" }).title).toBe('Bash {"cmd":"ls"}');
  });
});

describe("truncatePath", () => {
  it("深层路径截断为 .../父目录/叶文件名", () => {
    expect(truncatePath("D:/very/deep/nested/dir/file.ts")).toBe(".../dir/file.ts");
    expect(truncatePath("D:\\very\\deep\\nested\\dir\\file.ts")).toBe(".../dir/file.ts");
  });

  it("短路径原样保留", () => {
    expect(truncatePath("src/a.ts")).toBe("src/a.ts");
  });

  it("tool_use 标题中的路径同步截断", () => {
    const e = messageToEntry(msg({ type: "tool_use", tool: "Edit", input_json: JSON.stringify({ file_path: "D:/very/deep/nested/dir/file.ts" }) }));
    expect(e.title).toBe("Edit .../dir/file.ts");
  });
});

describe("summarizeProgress", () => {
  it("统计工具调用与错误，最近取最后一条 tool_use 摘要", () => {
    const s = summarizeProgress([
      msg({ seq: 1, type: "text", content: "开工" }),
      msg({ seq: 2, type: "tool_use", tool: "Edit", input_json: JSON.stringify({ file_path: "src/a.ts" }) }),
      msg({ seq: 3, type: "error", content: "失败" }),
      msg({ seq: 4, type: "tool_use", tool: "Bash", input_json: JSON.stringify({ command: "pnpm test" }) }),
    ]);
    expect(s).toEqual({ toolCalls: 2, errors: 1, latest: "Bash pnpm test" });
  });

  it("无 tool_use 时最近取最近 text 前 40 字符", () => {
    const s = summarizeProgress([
      msg({ seq: 1, type: "text", content: "短消息" }),
      msg({ seq: 2, type: "text", content: "一".repeat(50) }),
    ]);
    expect(s.toolCalls).toBe(0);
    expect(s.latest).toBe(`${"一".repeat(40)}…`);
  });

  it("空消息 → 全零", () => {
    expect(summarizeProgress([])).toEqual({ toolCalls: 0, errors: 0, latest: "" });
  });
});
