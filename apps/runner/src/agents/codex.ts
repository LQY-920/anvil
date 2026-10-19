import {
  CODEX_MAX_EVENT_CHARS,
  classifyCodexResult,
  emptyCodexParseState,
  parseCodexLine,
  type CodexSandboxMode,
} from "@anvil/core";
import { runCliProcess } from "./process.js";
import type { AgentBackend, AgentResult, AgentSession, ExecOptions } from "./backend.js";

export const CODEX_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "report_head_commit", "problem_understanding", "solution_summary", "changed_areas", "risks", "unresolved"],
  properties: {
    schema_version: { const: 1 },
    report_head_commit: { type: "string" },
    problem_understanding: { type: "string" },
    solution_summary: { type: "string" },
    changed_areas: { type: "array" },
    risks: { type: "array" },
    unresolved: { type: "array" },
  },
} as const;

export function buildCodexArgs(opts: {
  prompt: string;
  sessionRef?: string | null;
  sandbox?: CodexSandboxMode;
  model?: string | null;
  outputLastMessagePath?: string | null;
  outputSchemaPath?: string | null;
}): string[] {
  const args = ["exec", "--json", "--color", "never", "--sandbox", opts.sandbox ?? "workspace-write"];
  if (opts.model) args.push("-m", opts.model);
  if (opts.outputSchemaPath) args.push("--output-schema", opts.outputSchemaPath);
  if (opts.outputLastMessagePath) args.push("-o", opts.outputLastMessagePath);
  if (opts.sessionRef) args.push("resume", opts.sessionRef, opts.prompt);
  else args.push(opts.prompt);
  return args;
}

export interface CodexBackendOptions {
  command?: string;
  argsPrefix?: string[];
}

/** Codex CLI adapter。恢复只使用显式 session id，不使用 --last 或 --all。 */
export function createCodexBackend(opts: CodexBackendOptions = {}): AgentBackend {
  const command = opts.command ?? "codex";
  const prefix = opts.argsPrefix ?? [];
  return {
    provider: "codex",
    execute(execOpts: ExecOptions): AgentSession {
      const state = emptyCodexParseState();
      const p = runCliProcess({
        command,
        args: [...prefix, ...buildCodexArgs({
          prompt: execOpts.prompt,
          sessionRef: execOpts.sessionRef,
          sandbox: execOpts.sandbox,
          model: execOpts.model,
          outputLastMessagePath: execOpts.outputLastMessagePath,
          outputSchemaPath: execOpts.outputSchemaPath,
        })],
        cwd: execOpts.workDir,
        env: execOpts.env,
        parseLine: (line) => parseCodexLine(line, state),
        observeLine: (line) => { if (line.length > CODEX_MAX_EVENT_CHARS) state.invalid = true; },
        finalizeResult: (base: AgentResult): AgentResult => {
          if (base.status === "cancelled" || base.status === "timeout" || base.error?.includes("spawn_failed")) return base;
          const classified = classifyCodexResult(state, base.exitCode ?? null);
          return { ...base, ...classified, sessionRef: state.sessionRef ?? undefined };
        },
        maxLineBytes: CODEX_MAX_EVENT_CHARS,
        idleTimeoutMs: execOpts.idleTimeoutMs,
      });
      return { messages: p.messages, result: p.result, kill: p.kill };
    },
  };
}
