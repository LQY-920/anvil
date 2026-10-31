import type { AgentBackend, AgentSession, ExecOptions } from "./backend.js";

/** 按任务上的 provider 选择 backend。找不到时失败该任务，不回退到另一个执行器。 */
export function createRoutingBackend(backends: AgentBackend[]): AgentBackend {
  const byProvider = new Map(backends.map((backend) => [backend.provider, backend]));
  return {
    provider: "router",
    execute(opts: ExecOptions): AgentSession {
      const provider = opts.provider ?? "kimi";
      const backend = byProvider.get(provider);
      if (!backend) {
        return {
          messages: (async function* () {})(),
          result: Promise.resolve({ status: "failed", error: `spawn_failed: 没有 ${provider} backend` }),
          kill() {},
        };
      }
      return backend.execute(opts);
    },
  };
}
