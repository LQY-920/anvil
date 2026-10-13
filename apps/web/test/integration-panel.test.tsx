import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import IntegrationPanel from "../src/components/IntegrationPanel.js";
import * as api from "../src/api.js";
import { decision, head, integration, operation, repository, task } from "./integration-fixtures.js";
import type { TaskIntegration } from "@anvil/core";

vi.mock("../src/api.js", async original => ({ ...(await original<typeof import("../src/api.js")>()), getTaskIntegration: vi.fn(), submitTaskDecision: vi.fn(), createTaskPullRequest: vi.fn(), integrateTask: vi.fn(), recoverTaskOperation: vi.fn(), syncRepository: vi.fn(), acceptIssueSource: vi.fn() }));
let current: TaskIntegration;
const beforeDecision = vi.fn(async () => undefined);
const saved = vi.fn();
const decisionError = vi.fn();
const selectTask = vi.fn();
function panel() { return <IntegrationPanel task={task} onBeforeDecision={beforeDecision} onDecisionSaved={saved} onDecisionError={decisionError} onSelectTask={selectTask} />; }
beforeEach(() => {
  vi.resetAllMocks(); current = integration();
  beforeDecision.mockResolvedValue(undefined);
  vi.mocked(api.getTaskIntegration).mockImplementation(async () => current);
  vi.mocked(api.syncRepository).mockResolvedValue(repository);
  vi.mocked(api.submitTaskDecision).mockImplementation(async (_id, body) => {
    const stored = { ...decision, result: body.result, reason: body.reason ?? "", evidence_version: body.expected_version };
    current = { ...current, decision: stored }; return { decision: stored, ...(body.result === "rejected" ? { next_task_id: "t2" } : {}) };
  });
});
afterEach(cleanup);

describe("T01 交付审查", () => {
  it("来源差异可显式接受，只调用来源接口，不重写当前 Task 或自动裁决", async () => {
    const accepted = { id: "s1", repository_id: "r1", external_id: "42", issue_number: 42, url: "https://github.com/owner/repo/issues/42", title: "旧需求", body: "旧范围", state: "open" as const, source_updated_at: "2026-10-12T00:00:00Z", hash: "old", created_at: "2026-10-12T00:00:00Z" };
    const latest = { ...accepted, id: "s2", title: "新需求", body: "新增验收标准", hash: "new" };
    current.source = { repository_id: "r1", external_id: "42", issue_number: 42, url: accepted.url, accepted, latest, changed: true };
    vi.mocked(api.acceptIssueSource).mockImplementation(async () => { current = { ...current, source: { ...current.source!, accepted: latest, changed: false } }; return current.source!; });
    render(panel()); await screen.findByText("最新：新需求");
    fireEvent.click(screen.getByText("接受最新来源用于新任务"));
    await waitFor(() => expect(api.acceptIssueSource).toHaveBeenCalledWith("i1", "s2"));
    expect(api.submitTaskDecision).not.toHaveBeenCalled(); expect(beforeDecision).not.toHaveBeenCalled();
  });

  it("关闭未合入与 HEAD 变化均显示阻塞解释，checks 和 Runner 分开", async () => {
    current.decision = decision;
    current.pull_request = { id: "p1", repository_id: "r1", task_id: "t1", external_id: "100", number: 1, url: "https://github.com/owner/repo/pull/1", head_ref: "task/t1", head_sha: "c".repeat(40), base_ref: "main", state: "closed", merge_commit: null, last_synced_at: "2026-10-13T00:00:00Z", checks: [{ name: "CI", status: "completed", conclusion: "failure", url: null }] };
    render(panel()); await screen.findByText(/关闭 PR 不等于交付完成/);
    expect(screen.getByText(/PR HEAD 与批准版本不一致/)).toBeTruthy();
    expect(screen.getByText(/Runner 验证：通过/)).toBeTruthy(); expect(screen.getByText("CI：completed / failure")).toBeTruthy();
  });
  it("批准前重取 Gate，将最新 HEAD/version 与测量失败标记提交一次", async () => {
    beforeDecision.mockResolvedValueOnce({ review_measurement_failed_for: "t1" } as never);
    render(panel()); await screen.findByText("批准当前交付");
    current = { ...current, gate: { ...current.gate, evidence_version: "fresh" } };
    fireEvent.click(screen.getByText("批准当前交付"));
    await screen.findByText("人类裁决：已批准");
    expect(api.submitTaskDecision).toHaveBeenCalledWith("t1", expect.objectContaining({ result: "approved", expected_head: head, expected_version: "fresh", review_measurement_failed_for: "t1" }), expect.any(String));
    expect(beforeDecision).toHaveBeenCalledTimes(1); expect(saved).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("批准当前交付")).toBeNull();
  });

  it("质量覆盖必须理由和二次确认；不能普通批准", async () => {
    current.gate = { ...current.gate, blockers: [{ kind: "quality", code: "verification_blocked", message: "测试失败" }], can_approve: false, can_override: true };
    render(panel()); await screen.findByText("确认质量覆盖");
    expect((screen.getByText("批准当前交付") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("确认质量覆盖") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("裁决理由"), { target: { value: "人工确认已知非阻断问题" } });
    expect((screen.getByText("确认质量覆盖") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByText("确认质量覆盖"));
    await waitFor(() => expect(api.submitTaskDecision).toHaveBeenCalledWith("t1", expect.objectContaining({ result: "overridden", confirmed: true, reason: "人工确认已知非阻断问题" }), expect.any(String)));
  });

  it("完整性阻塞不可覆盖，最新检查变化也不能用旧按钮批准", async () => {
    render(panel()); await screen.findByText("批准当前交付");
    current.gate = { ...current.gate, blockers: [{ kind: "integrity", code: "head_changed", message: "HEAD 已变化" }], can_approve: false, can_override: true };
    fireEvent.click(screen.getByText("批准当前交付"));
    await screen.findByText("最新合入检查未通过，请先处理阻塞项。");
    expect((screen.getByText("确认质量覆盖") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(beforeDecision).not.toHaveBeenCalled(); expect(api.submitTaskDecision).not.toHaveBeenCalled();
  });

  it("打回必须理由并选择新 Task", async () => {
    render(panel()); await screen.findByText("打回并创建新任务");
    expect((screen.getByText("打回并创建新任务") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("裁决理由"), { target: { value: "请补真实测试" } });
    fireEvent.click(screen.getByText("打回并创建新任务"));
    await waitFor(() => expect(selectTask).toHaveBeenCalledWith("t2"));
    expect(api.submitTaskDecision).toHaveBeenCalledWith("t1", expect.objectContaining({ result: "rejected", reason: "请补真实测试" }), expect.any(String));
  });

  it("裁决响应丢失时重试沿用原键与载荷，不再次计时", async () => {
    vi.mocked(api.submitTaskDecision).mockRejectedValueOnce(new TypeError("网络中断"));
    render(panel()); fireEvent.click(await screen.findByText("批准当前交付"));
    fireEvent.click(await screen.findByText("重试保存裁决"));
    await screen.findByText("人类裁决：已批准");
    expect(vi.mocked(api.submitTaskDecision).mock.calls[1]).toEqual(vi.mocked(api.submitTaskDecision).mock.calls[0]);
    expect(beforeDecision).toHaveBeenCalledTimes(1);
  });

  it("创建或打开 PR 不产生新裁决或有效测量，界面没有 GitHub 合入按钮", async () => {
    current.decision = decision;
    vi.mocked(api.createTaskPullRequest).mockImplementation(async () => {
      const op = { ...operation, state: "succeeded" as const, error: null };
      current = { ...current, operations: [op], pull_request: { id: "p1", repository_id: "r1", task_id: "t1", external_id: "100", number: 1, url: "https://github.com/owner/repo/pull/1", head_ref: "task/t1", head_sha: head, base_ref: "main", state: "open", merge_commit: null, last_synced_at: "2026-10-13T00:00:00Z", checks: [] } }; return op;
    });
    render(panel()); fireEvent.click(await screen.findByText("创建或关联 PR"));
    expect(await screen.findByRole("link", { name: "在 GitHub 审查或合入" })).toBeTruthy();
    expect(api.createTaskPullRequest).toHaveBeenCalledWith("t1", { expected_head: head, expected_version: "v1" }, expect.any(String));
    expect(beforeDecision).not.toHaveBeenCalled(); expect(api.submitTaskDecision).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /合入/ })).toBeNull();
  });

  it("失败或未知操作只能查询恢复，恢复失败重试保留同一键", async () => {
    current = { ...current, decision, operations: [operation], gate: { ...current.gate, expected_head: "c".repeat(40), evidence_version: "target-advanced" } };
    vi.mocked(api.recoverTaskOperation).mockRejectedValue(new TypeError("响应丢失"));
    render(panel()); fireEvent.click(await screen.findByText("查询并恢复操作"));
    await screen.findByText("响应丢失");
    await waitFor(() => expect((screen.getByText("查询并恢复操作") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("查询并恢复操作"));
    await waitFor(() => expect(api.recoverTaskOperation).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.recoverTaskOperation).mock.calls[1]).toEqual(vi.mocked(api.recoverTaskOperation).mock.calls[0]);
    expect(vi.mocked(api.recoverTaskOperation).mock.calls[0][2]).toEqual({ expected_head: operation.expected_head, expected_version: decision.evidence_version });
    expect(vi.mocked(api.recoverTaskOperation).mock.calls[0][3]).not.toBe(operation.request_key);
    expect(screen.queryByText("创建或关联 PR")).toBeNull(); expect(api.createTaskPullRequest).not.toHaveBeenCalled(); expect(beforeDecision).not.toHaveBeenCalled();
  });

  it("新建操作网络结果未知且尚无记录时禁止再次创建", async () => {
    current.decision = decision; vi.mocked(api.createTaskPullRequest).mockRejectedValue(new TypeError("连接断开"));
    render(panel()); fireEvent.click(await screen.findByText("创建或关联 PR"));
    await screen.findByText("连接断开");
    expect(screen.queryByText("创建或关联 PR")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("操作结果尚未确认");
  });

  it("本地交付只执行本地操作，不调用 PR 通路", async () => {
    current = { ...current, decision, gate: { ...current.gate, mode: "local_git", repository: { ...repository, mode: "local_git" } } };
    vi.mocked(api.integrateTask).mockResolvedValue({ ...operation, action: "local_merge", state: "succeeded", error: null });
    render(panel()); fireEvent.click(await screen.findByText("执行本地交付"));
    await waitFor(() => expect(api.integrateTask).toHaveBeenCalledTimes(1));
    expect(api.createTaskPullRequest).not.toHaveBeenCalled(); expect(beforeDecision).not.toHaveBeenCalled();
  });

  it("不同 Task 挂载时不继承未确认的旧裁决键", async () => {
    vi.mocked(api.submitTaskDecision).mockRejectedValueOnce(new TypeError("网络错误"));
    const view = render(<IntegrationPanel key="t1" task={task} onBeforeDecision={beforeDecision} onDecisionSaved={saved} onDecisionError={decisionError} />);
    fireEvent.click(await screen.findByText("批准当前交付")); await screen.findByText("重试保存裁决");
    current = { ...integration(), gate: { ...integration().gate, task_id: "t2" } };
    view.rerender(<IntegrationPanel key="t2" task={{ ...task, id: "t2" }} onBeforeDecision={beforeDecision} onDecisionSaved={saved} onDecisionError={decisionError} />);
    fireEvent.click(await screen.findByText("批准当前交付"));
    await waitFor(() => expect(api.submitTaskDecision).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.submitTaskDecision).mock.calls[1][0]).toBe("t2");
    expect(vi.mocked(api.submitTaskDecision).mock.calls[1][2]).not.toBe(vi.mocked(api.submitTaskDecision).mock.calls[0][2]);
  });
});
