import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TaskPanel from "../src/components/TaskPanel.js";
import * as api from "../src/api.js";

vi.mock("../src/api.js", () => ({
  getTask: vi.fn(async () => ({
    task: { id: "t1", issue_id: "i1", status: "completed", agent_id: "a1", error: null, failure_reason: null },
    issue: { id: "i1", title: "修 bug", status: "in_progress", description: "详细描述" },
  })),
  getTaskMessages: vi.fn(async () => []),
  getIssueDetail: vi.fn(async () => ({ issue: { id: "i1", title: "修 bug" }, comments: [] })),
  getTaskDiff: vi.fn(async () => ({
    branch: "agent/t1", base: "main",
    diff_stat: " src/a.ts | 2 +-",
    diff_text: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
    truncated: false,
  })),
  mergeTask: vi.fn(async () => ({ ok: true, merged_branch: "agent/t1", target: "main" })),
  cancelTask: vi.fn(),
  addComment: vi.fn(),
  rerunIssue: vi.fn(),
  saveReviewMeasurement: vi.fn(async (id, body) => ({ task_id: id, ...body, recorded_at: new Date().toISOString() })),
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

afterEach(cleanup);
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

/** 渲染面板 → 输入评论 → 点发送，返回提示区文本查询工具 */
async function sendDraftComment() {
  render(<TaskPanel taskId="t1" />);
  await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
  fireEvent.change(screen.getByPlaceholderText("追加指令或评论…"), { target: { value: "继续" } });
  fireEvent.click(screen.getByText("发送"));
}

describe("TaskPanel", () => {
  it("renders review zone with diff stat and merge button, merges on click", async () => {
    render(<TaskPanel taskId="t1" />);
    await waitFor(() => expect(screen.getByText("合入 main")).toBeTruthy());
    expect(screen.getByText("修 bug")).toBeTruthy();
    expect(screen.getByText("agent/t1")).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts \| 2/)).toBeTruthy();
    fireEvent.click(screen.getByText("合入 main"));
    await waitFor(() => expect(screen.getByText("✓ 已合入 agent/t1")).toBeTruthy());
    expect(api.mergeTask).toHaveBeenCalledWith("t1");
    expect(api.saveReviewMeasurement).toHaveBeenCalledWith("t1", expect.objectContaining({ ui_version: "legacy", opened_transcript: true, opened_full_diff: false }));
    expect(vi.mocked(api.saveReviewMeasurement).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.mergeTask).mock.invocationCallOrder[0]);
  });

  it("打开完整 Diff 才记录标志，自动拉取 diff 不算展开", async () => {
    render(<TaskPanel taskId="t1" />);
    await screen.findByText("合入 main"); fireEvent.click(screen.getByText("查看 diff")); fireEvent.click(screen.getByText("合入 main"));
    await waitFor(() => expect(api.saveReviewMeasurement).toHaveBeenCalledWith("t1", expect.objectContaining({ opened_full_diff: true })));
  });

  it("保存未返回时同帧重复点击及跨裁决点击只执行一次", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(api.saveReviewMeasurement).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    render(<TaskPanel taskId="t1" />); await screen.findByText("合入 main");
    fireEvent.change(screen.getByPlaceholderText("打回意见…"), { target: { value: "改一下" } });
    const button = screen.getByText("合入 main"); fireEvent.click(button); fireEvent.click(button); fireEvent.click(screen.getByText("提交意见并重跑"));
    expect(api.saveReviewMeasurement).toHaveBeenCalledTimes(1); expect(api.mergeTask).not.toHaveBeenCalled(); expect(api.addComment).not.toHaveBeenCalled();
    resolve({ active_review_ms: 0 }); await waitFor(() => expect(api.mergeTask).toHaveBeenCalledTimes(1));
  });

  it("计时保存失败仍合入，并附失效标记及持久警告", async () => {
    vi.mocked(api.saveReviewMeasurement).mockRejectedValueOnce(new Error("离线"));
    render(<TaskPanel taskId="t1" />); await screen.findByText("合入 main"); fireEvent.click(screen.getByText("合入 main"));
    await screen.findByText("✓ 已合入 agent/t1");
    expect(api.mergeTask).toHaveBeenCalledWith("t1", { review_measurement_failed_for: "t1" });
    expect(screen.getByRole("alert").textContent).toContain("不计入验收耗时样本");
  });

  it("计时失败仍打回，切换任务后警告继续可见", async () => {
    vi.mocked(api.saveReviewMeasurement).mockRejectedValueOnce(new Error("离线"));
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: true, task_id: "t2" } });
    const onSelectTask = vi.fn(); const view = render(<TaskPanel taskId="t1" onSelectTask={onSelectTask} />);
    await screen.findByText("合入 main"); fireEvent.change(screen.getByPlaceholderText("打回意见…"), { target: { value: "补测试" } });
    fireEvent.click(screen.getByText("提交意见并重跑")); await waitFor(() => expect(onSelectTask).toHaveBeenCalledWith("t2"));
    expect(api.addComment).toHaveBeenCalledWith("i1", "补测试", { review_measurement_failed_for: "t1" });
    view.rerender(<TaskPanel taskId="t2" />); await screen.findByText("修 bug");
    expect(screen.getByRole("alert").textContent).toContain("不计入验收耗时样本");
  });

  it("合入失败重试仍保存累计量，不吞掉原错误", async () => {
    vi.mocked(api.mergeTask).mockRejectedValueOnce(new Error("合并冲突"));
    render(<TaskPanel taskId="t1" />); await screen.findByText("合入 main"); fireEvent.click(screen.getByText("合入 main"));
    await screen.findByText("合并冲突"); const first = vi.mocked(api.saveReviewMeasurement).mock.calls[0][1];
    fireEvent.click(screen.getByText("合入 main")); await screen.findByText("✓ 已合入 agent/t1");
    const second = vi.mocked(api.saveReviewMeasurement).mock.calls[1][1];
    expect(second.review_started_at).toBe(first.review_started_at); expect(second.active_review_ms!).toBeGreaterThanOrEqual(first.active_review_ms!);
  });

  it("shows enqueue hint after comment triggers a new task", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: true, task_id: "t2" } });
    await sendDraftComment();
    await waitFor(() => expect(screen.getByText("已触发新任务（排队接力）")).toBeTruthy());
  });

  it("shows merge hint when comment merges into a pending task", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: false, reason: "merged_into_pending" } });
    await sendDraftComment();
    await waitFor(() => expect(screen.getByText("已合并进排队任务，认领时生效")).toBeTruthy());
  });

  it("shows hint when issue is not assigned to an agent", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: false, reason: "assignee_not_agent" } });
    await sendDraftComment();
    await waitFor(() => expect(screen.getByText("未指派 Agent，评论仅记录不触发执行")).toBeTruthy());
  });

  it("shows hint when issue status is inactive", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: false, reason: "status_inactive" } });
    await sendDraftComment();
    await waitFor(() => expect(screen.getByText("当前状态不触发执行（收集箱/已完成/已取消）")).toBeTruthy());
  });

  it("shows no hint when server returns no trigger (old server)", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1" });
    await sendDraftComment();
    await waitFor(() => expect(api.addComment).toHaveBeenCalledWith("i1", "继续"));
    expect(screen.queryByText("已触发新任务（排队接力）")).toBeNull();
    expect(screen.queryByText(/评论仅记录|认领时生效|不触发执行/)).toBeNull();
  });

  it("clears the hint after switching to another task", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: true, task_id: "t2" } });
    const { rerender } = render(<TaskPanel taskId="t1" />);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("追加指令或评论…"), { target: { value: "继续" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(screen.getByText("已触发新任务（排队接力）")).toBeTruthy());
    rerender(<TaskPanel taskId="t2" />);
    await waitFor(() => expect(screen.queryByText("已触发新任务（排队接力）")).toBeNull());
  });

  it("打回重跑优先接续评论触发的任务，不再二次 rerun", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: true, task_id: "t2" } });
    const onSelectTask = vi.fn();
    render(<TaskPanel taskId="t1" onSelectTask={onSelectTask} />);
    await waitFor(() => expect(screen.getByText("合入 main")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("打回意见…"), { target: { value: "补测试" } });
    fireEvent.click(screen.getByText("提交意见并重跑"));
    await waitFor(() => expect(onSelectTask).toHaveBeenCalledWith("t2"));
    expect(api.rerunIssue).not.toHaveBeenCalled();
  });

  it("打回时已有 pending 任务则视同接续，不再 rerun", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: false, reason: "merged_into_pending" } });
    const onSelectTask = vi.fn();
    render(<TaskPanel taskId="t1" onSelectTask={onSelectTask} />);
    await waitFor(() => expect(screen.getByText("合入 main")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("打回意见…"), { target: { value: "补测试" } });
    fireEvent.click(screen.getByText("提交意见并重跑"));
    await waitFor(() => expect(api.addComment).toHaveBeenCalledWith("i1", "补测试"));
    expect(api.rerunIssue).not.toHaveBeenCalled();
  });

  it("打回时评论未入队则兜底 rerun", async () => {
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1", trigger: { enqueued: false, reason: "assignee_not_agent" } });
    vi.mocked(api.rerunIssue).mockResolvedValue({ id: "t3" } as any);
    const onSelectTask = vi.fn();
    render(<TaskPanel taskId="t1" onSelectTask={onSelectTask} />);
    await waitFor(() => expect(screen.getByText("合入 main")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("打回意见…"), { target: { value: "补测试" } });
    fireEvent.click(screen.getByText("提交意见并重跑"));
    await waitFor(() => expect(onSelectTask).toHaveBeenCalledWith("t3"));
    expect(api.rerunIssue).toHaveBeenCalledWith("i1");
  });

  it("Enter 提交评论，Shift+Enter 不提交", async () => {
    vi.mocked(api.addComment).mockClear();
    vi.mocked(api.addComment).mockResolvedValue({ id: "c1" });
    render(<TaskPanel taskId="t1" />);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    const box = screen.getByPlaceholderText("追加指令或评论…");
    fireEvent.change(box, { target: { value: "继续" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(api.addComment).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.addComment).toHaveBeenCalledWith("i1", "继续"));
  });

  it("发送失败时保留草稿并显示红字", async () => {
    vi.mocked(api.addComment).mockClear();
    vi.mocked(api.addComment).mockRejectedValue(new Error("网络错误"));
    render(<TaskPanel taskId="t1" />);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    const box = screen.getByPlaceholderText("追加指令或评论…");
    fireEvent.change(box, { target: { value: "继续" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(screen.getByText(/发送失败：.*网络错误/)).toBeTruthy());
    expect((box as HTMLTextAreaElement).value).toBe("继续");
  });
});
