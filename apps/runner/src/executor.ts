import type { Issue, Task, TaskComment, TaskPackage } from "@anvil/core";
import { isRepoUrl } from "@anvil/core";
import fs from "node:fs";
import path from "node:path";
import type { ApiClient } from "./client.js";
import type { AgentBackend, AgentResult } from "./agents/backend.js";
import { prepareWorkdir, gitDiffStat, readWorktreeHead, git } from "./worktree.js";
import { MessageUploader } from "./uploader.js";

export interface ExecutorDeps {
  client: ApiClient;
  backend: AgentBackend;
  runnerRoot: string;
  /** A03-FIX · daemonId:Runner 配置显式传入,不能从 Agent 环境或全局读取。必填。 */
  daemonId: string;
  idleTimeoutMs?: number;  // 默认 30min（spec §6：idle watchdog）
  cancelPollMs?: number;   // 默认 5s
}

/** 在途 session 注册表：daemon 停止/进程退出时统一 kill，避免孤儿 Agent 进程与重派任务写同一 work_dir。 */
const activeSessions = new Set<{ kill: () => void }>();

export function killAllActiveSessions() {
  for (const s of activeSessions) s.kill();
}

/** 追问 prompt：进程结束但 issue 未推进（未交付）时，用同一会话让 Agent 对照完成标准补课。 */
export const FOLLOWUP_PROMPT =
  "任务进程已结束，但你还没有提交验收（issue 仍在原状态）。请检查完成标准中还有哪条未达成，继续完成并提交 in_review 回调。";

const GUIDANCE_LIMIT = 8 * 1024;

/** 仓库常驻指引：读 <workDir>/ANVIL.md（本地/URL 仓库统一走 workDir，worktree/缓存工作区自带）。不存在/为空/读取失败返回 null，超 8192 字符截断并标注（按字符口径，CJK 实际字节更多，影响有界）。 */
export function readRepoGuidance(workDir: string): string | null {
  try {
    const content = fs.readFileSync(path.join(workDir, "ANVIL.md"), "utf8");
    if (!content.trim()) return null;
    return content.length > GUIDANCE_LIMIT ? `${content.slice(0, GUIDANCE_LIMIT)}\n（已截断）` : content;
  } catch {
    return null;
  }
}

export function buildPrompt(issue: Issue, task: Task, comments: TaskComment[] = []): string {
  const lines = [
    "你是 Anvil 平台上的编码 Agent，正在无人值守地执行任务。",
    "",
    "# 目标",
    issue.title,
    issue.description ? `\n${issue.description.slice(0, 8000)}` : null,
    "",
    "# 完成标准（全部满足才算交付）",
    issue.acceptance ? issue.acceptance : "1. 完成任务目标中的工作\n2. 改动已 git commit（保持当前分支）",
    "3. 调用平台回调把 issue 移到 in_review（见下）",
    "",
    "# 平台回调",
    "完成全部工作后执行：",
    `curl -X POST "$ANVIL_SERVER_URL/api/daemon/tasks/$ANVIL_TASK_ID/issue-status" -H "Authorization: Bearer $ANVIL_TOKEN" -H "content-type: application/json" -d "{\\"status\\":\\"in_review\\"}"`,
    "遇到无法继续的阻塞，上报 status=blocked 并附原因。",
    "",
    "# 边界与停止规则",
    "- 只在当前工作目录内操作",
    "- 不要推进超出目标范围的改动",
    "- 长时间无法推进时停止并上报 blocked，不要硬撑",
    ...(comments.length > 0
      ? [
          "",
          "# 讨论与补充意见（按时间）",
          // 每条一行：body 压成单行并截断，防止超长评论撑爆 prompt
          ...comments.map((c) => `- [${c.author_type}] ${c.body.replace(/\s+/g, " ").slice(0, 500)}`),
        ]
      : []),
  ];
  // 只剔除"无描述"占位，保留段落空行
  return lines.filter((l) => l !== null).join("\n");
}

/** 单任务完整旅程：准备目录 → start → spawn → 流式上报 → complete/fail。任何异常收敛为 fail 上报，绝不外抛。 */
export async function executeTask(deps: ExecutorDeps, pkg: TaskPackage): Promise<void> {
  const { client, backend, daemonId } = deps;
  const { task, issue, prior_work_dir, task_token } = pkg;
  let workDir: string | null = null;
  try {
    const prepared = await prepareWorkdir(issue, task.id, deps.runnerRoot, prior_work_dir, {
      taskBranch: task.task_branch ?? null,
      targetBranch: task.target_branch ?? null,
      baseCommit: task.base_commit ?? null,
    });
    workDir = prepared.workDir;
    // A03 · start / complete / fail 使用 daemon token + body.daemon_id,不再传 task_token
    // A04 · Git 仓库任务附带 v2 锚点(daemon_id + work_dir + task_branch + target_branch + base_commit + delivery_contract_version=2)
    await client.startTask(task.id, daemonId, workDir, {
      taskBranch: prepared.taskBranch,
      targetBranch: prepared.targetBranch,
      baseCommit: prepared.baseCommit,
    });

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
    const guidance = readRepoGuidance(workDir);
    const execOpts = {
      workDir,
      env,
      prompt: buildPrompt(issue, task, pkg.comments ?? []) + (guidance ? `\n\n## 仓库常驻指引（ANVIL.md）\n\n${guidance}` : ""),
      resume: prepared.resumed,
      idleTimeoutMs: deps.idleTimeoutMs ?? 30 * 60 * 1000,
    };
    // let：追问会换成新 session，取消轮询闭包始终杀"当前"会话
    let session = backend.execute(execOpts);

    // 取消轮询：server 端终态 → 杀进程组(task plane 继续用 task token)
    const cancelTimer = setInterval(async () => {
      try {
        const st = await client.taskStatus(task.id, task_token);
        if (st === null || st === "cancelled" || st === "completed" || st === "failed") session.kill();
      } catch { /* 网络抖动下轮再说 */ }
    }, deps.cancelPollMs ?? 5000);

    try {
      // 每轮会话的 add/delete 在同一 try/finally 里配对，追问轮换 session 后首轮注册不泄漏
      let result: AgentResult;
      activeSessions.add(session);
      try {
        for await (const m of session.messages) uploader.push(m);
        result = await session.result;
      } finally {
        activeSessions.delete(session);
      }
      try {
        await uploader.close();
      } catch (e: any) {
        // 消息缺失可事后补拉，不能因此把已成功/已失败的任务结果报错
        console.error("[anvil-executor] uploader.close failed, continuing with result report:", e?.message ?? e);
      }
      if (result.status === "completed") {
        // 进程结束 ≠ 交付：Agent 必须回调 issue-status 推进 issue。未交付则同会话追问，最多 2 轮。
        let delivered = await client.taskDelivered(task.id, task_token);
        let followups = 0;
        while (!delivered && followups < 2) {
          followups++;
          console.error(`[anvil-executor] task ${task.id} ended without delivery, follow-up ${followups}/2`);
          session = backend.execute({ ...execOpts, prompt: FOLLOWUP_PROMPT, resume: true });
          activeSessions.add(session);
          try {
            for await (const m of session.messages) uploader.push(m);
            const fr = await session.result;
            // 追问轮本身被取消/失败就不再追（如用户看板取消），落到 complete 由 server 裁决
            if (fr.status !== "completed") break;
          } finally {
            activeSessions.delete(session);
          }
          delivered = await client.taskDelivered(task.id, task_token);
        }
        if (followups > 0) {
          try {
            await uploader.close();
          } catch (e: any) {
            console.error("[anvil-executor] uploader.close after follow-up failed, continuing:", e?.message ?? e);
          }
        }
        if (!delivered) console.error(`[anvil-executor] task ${task.id} completed undelivered after ${followups} follow-up(s)`);
        // A04 · 固定 base..head 范围:Git 任务先读当前完整 HEAD 作为 headCommit(完整 40 位),
        // 再以 prepared.baseCommit..headCommit 计算 diff_stat;Agent 已 commit 后 git diff HEAD 通常为空,
        // 旧实现会用空 diff 误导,必须改用已固化的 base..head。无 repo_path 任务 diff_stat 为空。
        let diffStat = "";
        if (prepared.baseCommit != null) {
          const headCommit = await readWorktreeHead(workDir); // 校验 40 位,非 40 位抛错
          diffStat = await gitDiffStat(workDir, prepared.baseCommit, headCommit);
        }
        // URL 仓库:把任务分支推回远程,server 验收合并时用。推送失败不阻断 complete(分支仍在本地缓存)。
        let pushed: boolean | undefined;
        if (prepared.taskBranch && issue.repo_path && isRepoUrl(issue.repo_path)) {
          try {
            await git(workDir, ["push", "-u", "origin", prepared.taskBranch]);
            pushed = true;
          } catch (e: any) {
            console.error(`[anvil-executor] push ${prepared.taskBranch} failed, continuing with complete:`, e?.message ?? e);
            pushed = false;
          }
        }
        // A03-FIX · complete 失败(transport 耗尽 / 4xx)不构造新 fail,记录脱敏日志并结束:
        // "终态回执不确定"——可能是 server 已写入但响应丢失,重复 fail 反而会污染状态。
        // A04 · complete payload 沿用当前兼容结构(branch / diff_stat / work_dir / pushed / undelivered),
        // 头/工作树/verification 等更完整字段由 A07 引入。
        try {
          await client.complete(task.id, daemonId, {
            branch: prepared.taskBranch ?? undefined,
            diff_stat: diffStat || undefined,
            work_dir: workDir,
            ...(pushed === undefined ? {} : { pushed }),
            ...(delivered ? {} : { undelivered: true }),
          });
        } catch (e: any) {
          // 不外抛;不构造新的 fail payload。日志脱敏(不打印 token / Authorization / 完整响应)
          const status = typeof e?.status === "number" ? e.status : "transport";
          const msg = String(e?.message ?? "").replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer ***");
          console.error(`[anvil-executor] task ${task.id} complete terminal receipt uncertain (${status}):`, msg);
          // 安全结束,不外抛
          return;
        }
      } else if (result.status === "cancelled") {
        // server 已置 cancelled，不再上报
      } else if (result.status === "timeout") {
        // A03 · fail 用 daemon token
        try {
          await client.fail(task.id, daemonId, "idle_timeout", result.error ?? "idle watchdog", workDir);
        } catch (e: any) {
          // fail 自身失败:记录脱敏日志,安全结束,不外抛
          const status = typeof e?.status === "number" ? e.status : "transport";
          const msg = String(e?.message ?? "").replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer ***");
          console.error(`[anvil-executor] task ${task.id} fail ${status} after timeout:`, msg);
        }
      } else {
        const reason = result.error?.includes("spawn_failed") ? "spawn_failed" : "non_zero_exit";
        try {
          await client.fail(task.id, daemonId, reason, result.error ?? `exit ${result.exitCode}`, workDir);
        } catch (e: any) {
          const status = typeof e?.status === "number" ? e.status : "transport";
          const msg = String(e?.message ?? "").replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer ***");
          console.error(`[anvil-executor] task ${task.id} fail ${status} after spawn:`, msg);
        }
      }
    } finally {
      clearInterval(cancelTimer);
    }
  } catch (e: any) {
    // A03-FIX · 任何 catch 都不外抛:executeTask 必须收敛,poller 不应被影响
    if (e && typeof e.status === "number" && e.status >= 400) {
      // start 4xx / 完整 v2 状态路由错误:best-effort 调 fail,失败后吞掉并记录
      const status = e.status;
      const msg = String(e?.message ?? "").replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer ***");
      console.error(`[anvil-executor] task ${pkg.task.id} start ${status}:`, msg);
      try {
        await client.fail(pkg.task.id, daemonId, "non_zero_exit", `start rejected: ${status}`, workDir ?? undefined);
      } catch (e2: any) {
        const msg2 = String(e2?.message ?? "").replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer ***");
        console.error(`[anvil-executor] task ${pkg.task.id} best-effort fail also failed:`, msg2);
      }
    } else {
      // spawn / 5xx 耗尽 / transport:try fail,失败后吞掉
      const reason = String(e?.message ?? "").includes("spawn_failed") ? "spawn_failed" : "non_zero_exit";
      try {
        await client.fail(pkg.task.id, daemonId, reason, String(e?.message ?? e), workDir ?? undefined);
      } catch (e2: any) {
        const msg2 = String(e2?.message ?? "").replace(/Bearer\s+[A-Za-z0-9_-]+/g, "Bearer ***");
        console.error(`[anvil-executor] task ${pkg.task.id} fail after spawn/5xx also failed:`, msg2);
      }
    }
  }
}
