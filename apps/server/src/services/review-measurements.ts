import type { ReviewMeasurement, ReviewMeasurementRequest } from "@anvil/core";
import type { Db } from "../db/client.js";
import { getTask } from "./tasks.js";

function invalid(message: string, http = 400): never {
  throw Object.assign(new Error(message), { http });
}
function read(db: Db, taskId: string): ReviewMeasurement | null {
  const row = db.$client.prepare("SELECT * FROM review_measurements WHERE task_id=?").get(taskId) as ReviewMeasurement | undefined;
  return row ? { ...row, opened_transcript: Boolean(row.opened_transcript), opened_full_diff: Boolean(row.opened_full_diff) } : null;
}
function resultMetadata(resultJson: string | null): Record<string, unknown> {
  try {
    const value = JSON.parse(resultJson ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** 累计量取最大值，不把重复请求相加；null 墓碑永久排除这个 Task 的基线样本。 */
export function saveReviewMeasurement(db: Db, taskId: string, value: unknown): ReviewMeasurement {
  const task = getTask(db, taskId);
  if (!task) invalid("任务不存在", 404);
  if (task.status !== "completed") invalid("只有已完成任务可以记录验收时间", 409);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("测量必须是对象");
  const body = value as Record<string, unknown>;
  const keys = ["ui_version", "review_started_at", "active_review_ms", "opened_transcript", "opened_full_diff"];
  if (Object.keys(body).length !== keys.length || Object.keys(body).some(k => !keys.includes(k))) invalid("测量字段缺失或包含未知字段");
  if (body.ui_version !== "legacy" || body.opened_transcript !== true || typeof body.opened_full_diff !== "boolean") invalid("非法 UI 版本或打开标志");
  const now = Date.now();
  if (body.review_started_at === null || body.active_review_ms === null) {
    if (body.review_started_at !== null || body.active_review_ms !== null) invalid("失效样本的时间必须成对为 null");
  } else {
    const started = typeof body.review_started_at === "string" ? Date.parse(body.review_started_at) : NaN;
    if (!Number.isFinite(started) || new Date(started).toISOString() !== body.review_started_at || started > now) invalid("开始时间无效或在未来");
    if (!task.completed_at || started < Date.parse(task.completed_at)) invalid("不能回填任务完成前的页面事件");
    if (!Number.isSafeInteger(body.active_review_ms) || (body.active_review_ms as number) < 0 || (body.active_review_ms as number) > now - started) invalid("主动验收时间必须为非负整数且不超过墙钟时间");
  }
  const incoming = body as unknown as ReviewMeasurementRequest;
  return db.$client.transaction(() => {
    const prior = read(db, taskId);
    const excluded = incoming.active_review_ms === null || prior?.active_review_ms === null || resultMetadata(task.result_json).review_measurement_excluded === true;
    const next: ReviewMeasurement = {
      ...incoming, task_id: taskId, recorded_at: new Date(now).toISOString(),
      review_started_at: excluded ? null : [prior?.review_started_at, incoming.review_started_at].filter((v): v is string => Boolean(v)).sort()[0],
      active_review_ms: excluded ? null : Math.max(prior?.active_review_ms ?? 0, incoming.active_review_ms!),
      opened_full_diff: Boolean(prior?.opened_full_diff || incoming.opened_full_diff),
    };
    // 相同或迟到请求保持首次有效快照时间；不制造新的采样事件。
    if (prior && keys.every(k => prior[k as keyof ReviewMeasurement] === next[k as keyof ReviewMeasurement])) return prior;
    db.$client.prepare(`INSERT INTO review_measurements (task_id,ui_version,review_started_at,active_review_ms,opened_transcript,opened_full_diff,recorded_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      review_started_at=excluded.review_started_at, active_review_ms=excluded.active_review_ms,
      opened_full_diff=excluded.opened_full_diff, recorded_at=excluded.recorded_at`)
      .run(taskId, next.ui_version, next.review_started_at, next.active_review_ms, 1, Number(next.opened_full_diff), next.recorded_at);
    return next;
  })();
}

/** 计时请求可能已写入却丢失响应；让原裁决请求携带失效标记，关闭这条歧义路径。 */
export function excludeReviewMeasurement(db: Db, value: unknown, scope: { taskId?: string; issueId?: string }) {
  if (value === undefined) return;
  if (typeof value !== "string" || !value) invalid("无效的计时失败标记");
  const task = getTask(db, value);
  if (!task || scope.taskId && task.id !== scope.taskId || scope.issueId && task.issue_id !== scope.issueId) invalid("计时失败标记不属于当前任务");
  if (task.status !== "completed") invalid("只有已完成任务可以排除验收测量", 409);
  // 独立保存失效事实，避免测量表本身不可写时反过来阻断合入/打回。
  // 保留原 Git/验证业务快照；此字段是服务端裁决侧元数据，客户端 complete 不接受它。
  const metadata = resultMetadata(task.result_json);
  if (metadata.review_measurement_excluded !== true) {
    db.$client.prepare("UPDATE tasks SET result_json=? WHERE id=?").run(JSON.stringify({ ...metadata, review_measurement_excluded: true }), task.id);
  }
  try {
    saveReviewMeasurement(db, task.id, { ui_version: "legacy", review_started_at: null, active_review_ms: null, opened_transcript: true, opened_full_diff: false });
  } catch { /* 排除事实已持久化。测量表恢复后，任何迟到写入仍只能得到 null 样本。 */ }
}
