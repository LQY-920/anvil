import type { IssueWithTask } from "@anvil/core";

/** 同一 task 同类事件的去重窗口：10 分钟（内存 Map，刷新即清） */
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** 降级标记：document.title 前缀 */
const TITLE_PREFIX = "● ";

export type NotifyKind = "review" | "failed";

export interface NotifyEvent {
  kind: NotifyKind;
  taskId: string;
  title: string;
  body: string;
}

function branchOf(resultJson: string | null): string | null {
  if (!resultJson) return null;
  try {
    const r: unknown = JSON.parse(resultJson);
    if (r && typeof r === "object") {
      const b = (r as { branch?: unknown }).branch;
      if (typeof b === "string" && b) return b;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 对比同一 issue 的前后快照，判定是否产生通知事件（每次至多一个，review 优先）。
 * - review：latest_task 变为 completed 且 result_json 含 branch，或 issue.status 变为 in_review
 * - failed：latest_task 变为 failed 且 attempt >= max_attempts（idle_timeout 同属此类，不单独处理）
 * prev 为 undefined 时无基线可判"变为"，不报。dedup 以 `taskId:kind` 为键记录上次触发时间，
 * 窗口内重复事件返回 null；触发时会直接改写 dedup。
 */
export function shouldNotify(
  prev: IssueWithTask | undefined,
  next: IssueWithTask,
  dedup: Map<string, number>,
  now: number,
): NotifyEvent | null {
  if (!prev) return null;
  const pt = prev.latest_task;
  const nt = next.latest_task;

  let kind: NotifyKind | null = null;
  if (nt && nt.status === "completed" && branchOf(nt.result_json) && (pt?.id !== nt.id || pt?.status !== "completed")) {
    kind = "review";
  } else if (next.status === "in_review" && prev.status !== "in_review") {
    kind = "review";
  } else if (nt && nt.status === "failed" && nt.attempt >= nt.max_attempts && (pt?.id !== nt.id || pt?.status !== "failed")) {
    kind = "failed";
  }
  // in_review 迁移必有 latest_task（由 complete 触发）；没有 task 可跳转时不报
  if (!kind || !nt) return null;

  const key = `${nt.id}:${kind}`;
  const last = dedup.get(key);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return null;
  dedup.set(key, now);

  return kind === "review"
    ? { kind, taskId: nt.id, title: `待验收：${next.title}`, body: "任务完成，产出待验收" }
    : { kind, taskId: nt.id, title: `任务失败：${next.title}`, body: `失败 ${nt.attempt}/${nt.max_attempts}` };
}

export type NotifyResult = "sent" | "degraded";

/**
 * 发浏览器通知：granted 直接发；default 先请求授权；denied/不可用降级为
 * document.title 加 ● 前缀并返回 "degraded"（由调用方在卡片上补注意角标）。
 */
export async function notify(title: string, body: string, taskId: string): Promise<NotifyResult> {
  if (typeof Notification === "undefined") return degrade();
  let permission: NotificationPermission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = "denied";
    }
  }
  if (permission !== "granted") return degrade();
  const n = new Notification(title, { body });
  n.onclick = () => {
    window.focus();
    location.assign(`/?task=${taskId}`);
  };
  return "sent";
}

function degrade(): NotifyResult {
  setTitleBadge();
  return "degraded";
}

/** document.title 加 ● 前缀（幂等）；clearTitleBadge 还原 */
export function setTitleBadge(): void {
  if (!document.title.startsWith(TITLE_PREFIX)) document.title = TITLE_PREFIX + document.title;
}

export function clearTitleBadge(): void {
  if (document.title.startsWith(TITLE_PREFIX)) document.title = document.title.slice(TITLE_PREFIX.length);
}
