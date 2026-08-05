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
