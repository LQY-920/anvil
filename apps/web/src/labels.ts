import type { AgentStatus, IssueStatus, TaskStatus } from "@anvil/core";

/** 界面状态文案：唯一来源，新增状态时在此补充。 */
export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "收集箱",
  todo: "待办",
  in_progress: "进行中",
  in_review: "待验收",
  done: "已完成",
  blocked: "阻塞",
  cancelled: "已取消",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  dispatched: "已派发",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "空闲",
  working: "工作中",
  blocked: "阻塞",
  error: "异常",
  offline: "离线",
};

export const RUNTIME_STATUS_LABELS: Record<"online" | "offline", string> = {
  online: "在线",
  offline: "离线",
};

export const REPOSITORY_CONNECTION_LABELS = { connected: "连接可用", unavailable: "连接不可用", renamed: "仓库名称已变化，待确认", permission_denied: "权限不足" };
export const DECISION_RESULT_LABELS = { approved: "已批准", overridden: "已记录质量覆盖", rejected: "已打回" };
export const DELIVERY_OPERATION_LABELS = { prepared: "处理中，等待确认", unknown: "结果未知", failed: "操作失败", succeeded: "操作已成功" };
export const VERIFICATION_STATUS_LABELS: Record<string, string> = { passed: "通过", failed: "失败", partial: "部分通过", not_configured: "未配置", dirty: "工作区有改动", stale: "验证版本已过期" };
