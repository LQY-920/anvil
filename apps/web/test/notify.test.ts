import { describe, it, expect, vi, afterEach } from "vitest";
import type { IssueWithTask, LatestTaskSummary } from "@anvil/core";
import {
  DEDUP_WINDOW_MS,
  clearTitleBadge,
  notify,
  setTitleBadge,
  shouldNotify,
} from "../src/lib/notify.js";

function makeIssue(status: IssueWithTask["status"] = "in_progress", task: Partial<LatestTaskSummary> | null = {}): IssueWithTask {
  return {
    id: "i1", workspace_id: "ws1", title: "修 bug", description: null, acceptance: null,
    status, priority: "medium", assignee_type: "agent", assignee_id: "a1",
    creator_type: "member", creator_id: "u1", repo_path: null, position: 1,
    created_at: "x", updated_at: "x",
    latest_task: task === null ? null : {
      id: "t1", status: "running", attempt: 1, max_attempts: 3,
      failure_reason: null, error: null, result_json: null, ...task,
    },
  };
}

describe("shouldNotify", () => {
  it("task 变为 completed 且 result_json 含 branch → review", () => {
    const ev = shouldNotify(
      makeIssue("in_progress", { status: "running" }),
      makeIssue("in_progress", { status: "completed", result_json: '{"branch":"agent/t1"}' }),
      new Map(), 1000,
    );
    expect(ev).toMatchObject({ kind: "review", taskId: "t1" });
  });

  it("issue.status 变为 in_review → review", () => {
    const ev = shouldNotify(
      makeIssue("in_progress", { status: "completed", result_json: null }),
      makeIssue("in_review", { status: "completed", result_json: null }),
      new Map(), 1000,
    );
    expect(ev?.kind).toBe("review");
  });

  it("completed 但无 branch → 不通知", () => {
    const ev = shouldNotify(
      makeIssue("in_progress", { status: "running" }),
      makeIssue("in_progress", { status: "completed", result_json: null }),
      new Map(), 1000,
    );
    expect(ev).toBeNull();
  });

  it("task 变为 failed 且 attempt >= max_attempts → failed（idle_timeout 同覆盖）", () => {
    const ev = shouldNotify(
      makeIssue("in_progress", { status: "running", attempt: 3 }),
      makeIssue("in_progress", { status: "failed", attempt: 3, max_attempts: 3, failure_reason: "idle_timeout" }),
      new Map(), 1000,
    );
    expect(ev).toMatchObject({ kind: "failed", taskId: "t1" });
  });

  it("failed 但 attempt < max_attempts（还会重试）→ 不通知", () => {
    const ev = shouldNotify(
      makeIssue("in_progress", { status: "running" }),
      makeIssue("in_progress", { status: "failed", attempt: 1, max_attempts: 3 }),
      new Map(), 1000,
    );
    expect(ev).toBeNull();
  });

  it("无基线（prev undefined）或状态未变 → 不通知", () => {
    const done = makeIssue("in_review", { status: "completed", result_json: '{"branch":"b"}' });
    expect(shouldNotify(undefined, done, new Map(), 1000)).toBeNull();
    const failed = makeIssue("in_progress", { status: "failed", attempt: 3, max_attempts: 3 });
    expect(shouldNotify(failed, failed, new Map(), 1000)).toBeNull();
  });

  it("同一 task 同类事件 10 分钟内只报一次，窗口过后可再报", () => {
    const dedup = new Map<string, number>();
    const t0 = 1_000_000;
    const running = makeIssue("in_progress", { status: "running" });
    const completed = makeIssue("in_progress", { status: "completed", result_json: '{"branch":"b"}' });
    expect(shouldNotify(running, completed, dedup, t0)).not.toBeNull();
    expect(shouldNotify(running, completed, dedup, t0 + DEDUP_WINDOW_MS - 1)).toBeNull();
    expect(shouldNotify(running, completed, dedup, t0 + DEDUP_WINDOW_MS)).not.toBeNull();
  });

  it("不同类事件互不去重", () => {
    const dedup = new Map<string, number>();
    const t0 = 1_000_000;
    shouldNotify(
      makeIssue("in_progress", { status: "running" }),
      makeIssue("in_progress", { status: "completed", result_json: '{"branch":"b"}' }),
      dedup, t0,
    );
    const ev = shouldNotify(
      makeIssue("in_progress", { status: "running", attempt: 3 }),
      makeIssue("in_progress", { status: "failed", attempt: 3, max_attempts: 3 }),
      dedup, t0 + 1,
    );
    expect(ev?.kind).toBe("failed");
  });
});

class MockNotification {
  static instances: MockNotification[] = [];
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => MockNotification.permission);
  onclick: (() => void) | null = null;
  constructor(public title: string, public options?: { body?: string }) {
    MockNotification.instances.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.title = "";
  MockNotification.instances = [];
  MockNotification.requestPermission.mockClear();
});

describe("notify", () => {
  it("granted：直接发通知并带 onclick", async () => {
    MockNotification.permission = "granted";
    vi.stubGlobal("Notification", MockNotification);
    const r = await notify("待验收：修 bug", "任务完成", "t1");
    expect(r).toBe("sent");
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe("待验收：修 bug");
    expect(typeof MockNotification.instances[0].onclick).toBe("function");
    expect(document.title).toBe("");
  });

  it("default：先 requestPermission，授权后再发", async () => {
    MockNotification.permission = "default";
    MockNotification.requestPermission.mockResolvedValueOnce("granted");
    vi.stubGlobal("Notification", MockNotification);
    const r = await notify("t", "b", "t1");
    expect(MockNotification.requestPermission).toHaveBeenCalled();
    expect(r).toBe("sent");
    expect(MockNotification.instances).toHaveLength(1);
  });

  it("denied：降级为 document.title 加 ● 前缀", async () => {
    MockNotification.permission = "denied";
    vi.stubGlobal("Notification", MockNotification);
    document.title = "Anvil";
    const r = await notify("t", "b", "t1");
    expect(r).toBe("degraded");
    expect(MockNotification.instances).toHaveLength(0);
    expect(document.title).toBe("● Anvil");
  });

  it("Notification 不可用：同样降级", async () => {
    vi.stubGlobal("Notification", undefined);
    document.title = "Anvil";
    const r = await notify("t", "b", "t1");
    expect(r).toBe("degraded");
    expect(document.title).toBe("● Anvil");
  });
});

describe("document.title 降级标记", () => {
  it("setTitleBadge 幂等，clearTitleBadge 还原", () => {
    document.title = "Anvil";
    setTitleBadge();
    setTitleBadge();
    expect(document.title).toBe("● Anvil");
    clearTitleBadge();
    expect(document.title).toBe("Anvil");
    clearTitleBadge();
    expect(document.title).toBe("Anvil");
  });
});
