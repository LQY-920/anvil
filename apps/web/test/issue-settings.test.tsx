import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import IssueSettingsDialog from "../src/components/IssueSettingsDialog.js";
import * as api from "../src/api.js";
import { repository } from "./integration-fixtures.js";
import type { Agent, Issue } from "@anvil/core";
vi.mock("../src/api.js", async original => ({ ...(await original<typeof import("../src/api.js")>()), listRepositories: vi.fn(), getIssueSource: vi.fn(), getIssueTasks: vi.fn(), updateIssue: vi.fn(), rerunIssue: vi.fn() }));
const issue = { id: "i1", title: "历史 Issue", description: "旧描述", acceptance: "测试通过", repo_path: "D:/old", repository_id: null, assignee_type: "agent", assignee_id: "a1" } as Issue;
const agents = [{ id: "a1", name: "本机 Agent" }] as Agent[];
beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.listRepositories).mockResolvedValue([repository]); vi.mocked(api.getIssueSource).mockResolvedValue(null); vi.mocked(api.getIssueTasks).mockResolvedValue([]); vi.mocked(api.updateIssue).mockResolvedValue(issue); vi.mocked(api.rerunIssue).mockResolvedValue({ id: "t2" } as any); });
afterEach(cleanup);

describe("Issue 仓库编辑", () => {
  it("导入的收集箱 Issue 明确执行时激活，并复用该次指派创建的任务", async () => {
    vi.mocked(api.getIssueTasks).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "t-new", status: "queued" } as any]);
    const select = vi.fn(); render(<IssueSettingsDialog issue={{ ...issue, status: "backlog" }} agents={agents} onClose={vi.fn()} onSaved={vi.fn()} onSelectTask={select} />);
    fireEvent.click(screen.getByText("保存并重新执行"));
    await waitFor(() => expect(select).toHaveBeenCalledWith("t-new"));
    expect(api.updateIssue).toHaveBeenCalledWith("i1", expect.objectContaining({ status: "todo" }));
    expect(api.rerunIssue).not.toHaveBeenCalled();
  });
  it("绑定仓库时由服务端决定路径，明确重新执行后选择新 Task", async () => {
    const select = vi.fn(); render(<IssueSettingsDialog issue={issue} agents={agents} onClose={vi.fn()} onSaved={vi.fn()} onSelectTask={select} />);
    await screen.findByRole("option", { name: /owner\/repo/ });
    fireEvent.change(screen.getByLabelText("绑定仓库"), { target: { value: "r1" } });
    expect(screen.queryByLabelText("自由仓库路径")).toBeNull();
    fireEvent.click(screen.getByText("保存并重新执行"));
    await waitFor(() => expect(select).toHaveBeenCalledWith("t2"));
    const body = vi.mocked(api.updateIssue).mock.calls[0][1];
    expect(body.repository_id).toBe("r1"); expect(body).not.toHaveProperty("repo_path");
    expect(api.rerunIssue).toHaveBeenCalledWith("i1");
  });

  it("仅保存配置不主动重跑，错误保留表单", async () => {
    vi.mocked(api.updateIssue).mockRejectedValueOnce(new api.ApiError("409", 409, "source_changed", "请先接受来源变化"));
    const close = vi.fn(); render(<IssueSettingsDialog issue={issue} agents={agents} onClose={close} onSaved={vi.fn()} onSelectTask={vi.fn()} />);
    fireEvent.click(screen.getByText("保存配置")); await screen.findByText("请先接受来源变化");
    expect(api.rerunIssue).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("历史 Issue");
  });
});
