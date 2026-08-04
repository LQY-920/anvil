import type { Issue, Task, TaskComment, TaskPackage } from "@anvil/core";
import type { ApiClient } from "./client.js";
import type { AgentBackend } from "./agents/backend.js";
import { prepareWorkdir, gitDiffStat } from "./worktree.js";
import { MessageUploader } from "./uploader.js";

export interface ExecutorDeps {
  client: ApiClient;
  backend: AgentBackend;
  runnerRoot: string;
  idleTimeoutMs?: number;  // 默认 30min（spec §6：idle watchdog）
  cancelPollMs?: number;   // 默认 5s
}

/** 在途 session 注册表：daemon 停止/进程退出时统一 kill，避免孤儿 Agent 进程与重派任务写同一 work_dir。 */
const activeSessions = new Set<{ kill: () => void }>();

export function killAllActiveSessions() {
  for (const s of activeSessions) s.kill();
}

export function buildPrompt(issue: Issue, task: Task, comments: TaskComment[] = []): string {
  const lines = [
    "你是 Anvil 平台上的编码 Agent，正在无人值守地执行任务。",
    "",
    "# 任务",
    `标题：${issue.title}`,
    issue.description ? `描述：\n${issue.description.slice(0, 8000)}` : null,
    ...(comments.length > 0
      ? [
          "",
          "# 讨论与补充意见（按时间）",
          // 每条一行：body 压成单行并截断，防止超长评论撑爆 prompt
          ...comments.map((c) => `- [${c.author_type}] ${c.body.replace(/\s+/g, " ").slice(0, 500)}`),
        ]
      : []),
    "",
    "# 要求",
    "- 在当前工作目录内完成编码，改动用 git commit 提交（保持当前分支）。",
    "- 全部完成后，必须把 issue 移到 in_review：",
    `  curl -X POST "$ANVIL_SERVER_URL/api/daemon/tasks/$ANVIL_TASK_ID/issue-status" -H "Authorization: Bearer $ANVIL_TOKEN" -H "content-type: application/json" -d "{\\"status\\":\\"in_review\\"}"`,
    "- 遇到无法继续的阻塞，用同样方式上报 status=blocked 并附原因。",
  ];
  // 只剔除"无描述"占位，保留段落空行
  return lines.filter((l) => l !== null).join("\n");
}

/** 单任务完整旅程：准备目录 → start → spawn → 流式上报 → complete/fail。任何异常收敛为 fail 上报，绝不外抛。 */
export async function executeTask(deps: ExecutorDeps, pkg: TaskPackage): Promise<void> {
  const { client, backend } = deps;
  const { task, issue, prior_work_dir, task_token } = pkg;
  let workDir: string | null = null;
  try {
    const prepared = await prepareWorkdir(issue, task.id, deps.runnerRoot, prior_work_dir);
    workDir = prepared.workDir;
    await client.startTask(task.id, task_token, workDir);

    // daemon token 不进子进程：子进程只需要单次任务 token（spec §6 最小授权）
    const { ANVIL_DAEMON_TOKEN: _drop, ...baseEnv } = process.env;
    const env = {
      ...baseEnv,
      ANVIL_TOKEN: task_token,
      ANVIL_SERVER_URL: (client as any).baseUrl,
      ANVIL_WORKSPACE_ID: task.workspace_id,
      ANVIL_AGENT_ID: task.agent_id,
      ANVIL_TASK_ID: task.id,
    } as Record<string, string>;

    // 纵深防御：daemon token 若出现在消息流里同样抹掉
    const secrets = [task_token, process.env.ANVIL_DAEMON_TOKEN ?? ""].filter(Boolean);
    const uploader = new MessageUploader(client, task.id, task_token, secrets, 500);
    const session = backend.execute({
      workDir,
      env,
      prompt: buildPrompt(issue, task, pkg.comments ?? []),
      resume: prepared.resumed,
      idleTimeoutMs: deps.idleTimeoutMs ?? 30 * 60 * 1000,
    });
    activeSessions.add(session);

    // 取消轮询：server 端终态 → 杀进程组
    const cancelTimer = setInterval(async () => {
      try {
        const st = await client.taskStatus(task.id, task_token);
        if (st === null || st === "cancelled" || st === "completed" || st === "failed") session.kill();
      } catch { /* 网络抖动下轮再说 */ }
    }, deps.cancelPollMs ?? 5000);

    try {
      for await (const m of session.messages) uploader.push(m);
      const result = await session.result;
      try {
        await uploader.close();
      } catch (e: any) {
        // 消息缺失可事后补拉，不能因此把已成功/已失败的任务结果报错
        console.error("[anvil-executor] uploader.close failed, continuing with result report:", e?.message ?? e);
      }
      if (result.status === "completed") {
        const diffStat = prepared.branch ? await gitDiffStat(workDir) : "";
        await client.complete(task.id, task_token, {
          branch: prepared.branch ?? undefined,
          diff_stat: diffStat || undefined,
          work_dir: workDir,
        });
      } else if (result.status === "cancelled") {
        // server 已置 cancelled，不再上报
      } else if (result.status === "timeout") {
        await client.fail(task.id, task_token, "idle_timeout", result.error ?? "idle watchdog", workDir);
      } else {
        const reason = result.error?.includes("spawn_failed") ? "spawn_failed" : "non_zero_exit";
        await client.fail(task.id, task_token, reason, result.error ?? `exit ${result.exitCode}`, workDir);
      }
    } finally {
      clearInterval(cancelTimer);
      activeSessions.delete(session);
    }
  } catch (e: any) {
    const reason = String(e?.message ?? "").includes("spawn_failed") ? "spawn_failed" : "non_zero_exit";
    await client.fail(task.id, task_token, reason, String(e?.message ?? e), workDir ?? undefined).catch(() => {});
  }
}
