import type { DeliveryQueryResponse, Issue, Task, TaskComment, TaskPackage } from "@anvil/core";
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

/** v1 追问 prompt:进程结束但未通过 issue-status 回调推进时,让 Agent 补做。
 *  v1 路径继续保留这一语义,行为不回归。 */
export const FOLLOWUP_PROMPT =
  "任务进程已结束，但你还没有提交验收（issue 仍在原状态）。请检查完成标准中还有哪条未达成，继续完成并提交 in_review 回调。";

/** A05 · v2 追问 prompt:每轮结束后 Runner 会重新读取 HEAD 并查询 Delivery Report。
 *  旧 Report SHA 不一致、Report 缺失、schema 错或 head 不匹配时,让 Agent 重新 commit
 *  并用新 HEAD 提交 Report。注意不得伪造 SHA,也不得调用 issue-status=in_review/done。 */
export const V2_FOLLOWUP_PROMPT =
  "你的代码修改可能还没绑定到当前 HEAD。\n" +
  "1. 如果有未提交的改动,执行 git commit(保持当前任务分支)。\n" +
  "2. 执行 git rev-parse HEAD 读取完整 40 位 HEAD SHA。\n" +
  "3. 使用 ANVIL_TOKEN 重新提交 Delivery Report:\n" +
  `   curl -X PUT "$ANVIL_SERVER_URL/api/daemon/tasks/$ANVIL_TASK_ID/delivery-report" \\\n` +
  `        -H "Authorization: Bearer $ANVIL_TOKEN" \\\n` +
  `        -H "content-type: application/json" \\\n` +
  `        -d "$(cat <<'JSON'\n` +
  `{\n` +
  `  "schema_version": 1,\n` +
  `  "report_head_commit": "<上一步读到的 40 位 HEAD>",\n` +
  `  "problem_understanding": "本次任务的问题理解",\n` +
  `  "solution_summary": "本次任务的方案摘要",\n` +
  `  "changed_areas": [{ "path": "<文件路径>", "summary": "<改动说明>" }],\n` +
  `  "risks": [],\n` +
  `  "unresolved": []\n` +
  `}\n` +
  `JSON\n` +
  `)"\n` +
  "4. 不要伪造 HEAD SHA,不要省略 schema_version=1,不得调用 issue-status=in_review/done。\n" +
  "5. 确实无法继续时,可调用 issue-status=blocked 走逃生路径。";

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

function isV2Task(task: Task): boolean {
  return (task as { delivery_contract_version?: number }).delivery_contract_version === 2;
}

/** 比较两个 SHA 字符串(忽略大小写、去除前后空白)。允许 hex 大小写归一但不允许短 SHA。 */
function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!/^[0-9a-f]{40}$/i.test(a.trim()) || !/^[0-9a-f]{40}$/i.test(b.trim())) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function buildPrompt(issue: Issue, task: Task, comments: TaskComment[] = []): string {
  const v2 = isV2Task(task);
  // v1 旧契约:完成标准段后必须追加"3. 调用平台回调把 issue 移到 in_review(见下)",
  // 即使 issue.acceptance 已存在,这一行作为 v1 callback 指令始终出现。
  // v2 不追加这一行(由下方"v2 平台回调"段替代)。
  const v1CallbackLine = v2
    ? null
    : "3. 调用平台回调把 issue 移到 in_review（见下）";
  const lines: (string | null)[] = [
    "你是 Anvil 平台上的编码 Agent，正在无人值守地执行任务。",
    "",
    "# 目标",
    issue.title,
    issue.description ? `\n${issue.description.slice(0, 8000)}` : null,
    "",
    "# 完成标准（全部满足才算交付）",
    issue.acceptance
      ? issue.acceptance
      : v2
        ? "1. 完成任务目标中的工作\n2. 改动已 git commit（保持当前分支）\n3. 按下方\"v2 平台回调\"提交结构化 Delivery Report"
        : "1. 完成任务目标中的工作\n2. 改动已 git commit（保持当前分支）",
    v1CallbackLine,
    "",
  ];
  if (v2) {
    lines.push(
      "# v2 平台回调：结构化 Delivery Report",
      "完成全部工作并 commit 后,执行下列流程:",
      `1. 执行 git rev-parse HEAD,读取完整 40 位 SHA(示例:0123456789abcdef0123456789abcdef01234567)。`,
      `2. 使用当前任务的 task token(ANVIL_TOKEN)调用:`,
      `   curl -X PUT "$ANVIL_SERVER_URL/api/daemon/tasks/$ANVIL_TASK_ID/delivery-report" \\`,
      `        -H "Authorization: Bearer $ANVIL_TOKEN" \\`,
      `        -H "content-type: application/json" \\`,
      `        -d "$(cat <<'JSON'`,
      `{`,
      `  "schema_version": 1,`,
      `  "report_head_commit": "<上一步读到的 40 位 HEAD>",`,
      `  "problem_understanding": "本次任务的问题理解",`,
      `  "solution_summary": "本次任务的方案摘要",`,
      `  "changed_areas": [{ "path": "<文件路径>", "summary": "<改动说明>" }],`,
      `  "risks": [{ "level": "low|medium|high", "summary": "<风险描述>", "mitigation": "<缓解>" }],`,
      `  "unresolved": [{ "description": "<未解决项>" }]`,
      `}`,
      `JSON`,
      `)"`,
      `3. report_head_commit 必须等于刚读到的 HEAD;不得伪造短 SHA 也不得提交旧 commit。`,
      `4. 如果追问过程中产生了新 commit,必须重新读取 HEAD 并重新提交 Report(只改 report_head_commit 即可,Runner 会按规范化内容判定)。`,
      `5. v2 严格禁止:`,
      `   - 不得把 issue 直接推进 \u2192 in_review;v2 必须通过 Delivery Report 表达交付`,
      `   - 不得把 issue 直接推进 \u2192 done;Issue.done 只由人类批准合入产生`,
      `   - 不得伪造 HEAD SHA、不得提交未 commit 的状态、不得要求 Runner 帮你合入`,
      `6. 确实无法继续时,可调用下方 blocked 走逃生路径。`,
      `   curl -X POST "$ANVIL_SERVER_URL/api/daemon/tasks/$ANVIL_TASK_ID/issue-status" \\`,
      `        -H "Authorization: Bearer $ANVIL_TOKEN" \\`,
      `        -H "content-type: application/json" \\`,
      `        -d '{"status":"blocked","note":"<原因>"}'`,
      "",
    );
  } else {
    lines.push(
      "# 平台回调",
      "完成全部工作后执行:",
      `curl -X POST "$ANVIL_SERVER_URL/api/daemon/tasks/$ANVIL_TASK_ID/issue-status" -H "Authorization: Bearer $ANVIL_TOKEN" -H "content-type: application/json" -d "{\\"status\\":\\"in_review\\"}"`,
      "遇到无法继续的阻塞，上报 status=blocked 并附原因。",
      "",
    );
  }
  lines.push(
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
  );
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
        // A05 · 进程结束 ≠ 交付。
        //  v1 路径:沿用旧 FOLLOWUP_PROMPT 追问最多 2 轮,直到 issue-status 回调。
        //  v2 路径:每轮结束重新读 HEAD + 查 Delivery Report;
        //         缺失 / schema 错 / report_head_commit 与当前 HEAD 不一致时
        //         用 V2_FOLLOWUP_PROMPT 追问,最多 2 轮;两轮仍 mismatch 则保持 undelivered。
        //  任何情况下,mismatch 都不得转 fail(complete transport error 同样不得 fail)。
        const v2 = isV2Task(task);
        let delivered = false;
        let followups = 0;
        // 真实分支状态:v2 路径下,delivered 表示"report_head_commit == current HEAD 且已提交"
        // v1 路径下,delivered 表示 tasks.delivered_at != null
        const taskBranch = prepared.taskBranch;
        while (followups < 2) {
          // 每轮开始:重新读取真实工作区状态(Git HEAD 可能在追问中推进)
          let currentHead: string | null = null;
          if (v2 && workDir && taskBranch) {
            try {
              currentHead = await readWorktreeHead(workDir, taskBranch);
            } catch (e: any) {
              // 工作树被切换 / detached HEAD:readWorktreeHead 已抛错,落到 fail
              throw e;
            }
          }
          const query = await client.getTaskDelivery(task.id, task_token);
          if (v2) {
            // v2 判定:query.delivered && query.report_submitted &&
            //   query.report_schema_version === 1 && SHA 与 currentHead 完全一致
            if (query && query.delivered && query.report_submitted && query.report_schema_version === 1) {
              if (currentHead && sameSha(query.report_head_commit, currentHead)) {
                delivered = true;
                break;
              }
            }
          } else {
            // v1 判定:沿用旧语义,只要 delivered=true
            if (query && query.delivered) {
              delivered = true;
              break;
            }
          }
          // 不满足 → 追问
          followups++;
          const followPrompt = v2 ? V2_FOLLOWUP_PROMPT : FOLLOWUP_PROMPT;
          console.error(`[anvil-executor] task ${task.id} ended without delivery, follow-up ${followups}/2 (v2=${v2})`);
          session = backend.execute({ ...execOpts, prompt: followPrompt, resume: true });
          activeSessions.add(session);
          try {
            for await (const m of session.messages) uploader.push(m);
            const fr = await session.result;
            // 追问轮本身被取消/失败就不再追（如用户看板取消），落到 complete 由 server 裁决
            if (fr.status !== "completed") {
              delivered = false;
              break;
            }
          } finally {
            activeSessions.delete(session);
          }
          // 继续循环:下一轮会重新读 HEAD + 查 Report
        }
        if (followups > 0) {
          try {
            await uploader.close();
          } catch (e: any) {
            console.error("[anvil-executor] uploader.close after follow-up failed, continuing:", e?.message ?? e);
          }
        }
        if (!delivered) console.error(`[anvil-executor] task ${task.id} completed undelivered after ${followups} follow-up(s)`);
        // A04-FIX1 · 固定 base..head 范围 + 分支身份验证:
        // 1) readWorktreeHead 会先确认当前分支 === prepared.taskBranch,detached HEAD 或切到其他分支
        //    都会明确抛错,落到下方 catch 收敛为 fail(不会发送 complete);
        // 2) 分支身份确认后再读完整 40 位 SHA,非 40 位同样抛错;
        // 3) 失败时整个 executeTask 由 catch 块负责 fail 上报,不外抛;
        // 4) Agent 已 commit 后 git diff HEAD 通常为空,所以 diff 必须用 base..head。
        // 无 repo_path 任务 diff_stat 为空。
        let diffStat = "";
        if (prepared.baseCommit != null) {
          const headCommit = await readWorktreeHead(workDir, prepared.taskBranch);
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
