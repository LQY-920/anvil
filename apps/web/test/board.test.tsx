import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BoardPage from "../src/pages/BoardPage.js";
import * as api from "../src/api.js";

vi.mock("../src/api.js", () => ({
  bootstrap: vi.fn(async () => ({
    workspace: { id: "ws1", name: "Default", slug: "default" },
    user: { id: "u1", name: "Owner" },
    recent_repos: ["D:/projects/foo", "https://github.com/u/r.git"],
  })),
  listIssues: vi.fn(async () => [
    { id: "i1", workspace_id: "ws1", title: "修 bug", status: "todo", priority: "high", assignee_type: "agent", assignee_id: "a1", creator_type: "member", creator_id: "u1", repo_path: null, position: 1, created_at: "x", updated_at: "x", description: null,
      latest_task: { id: "t1", status: "running", attempt: 1, max_attempts: 3, failure_reason: null, error: null, result_json: null } },
  ]),
  listAgents: vi.fn(async () => [
    { id: "a1", workspace_id: "ws1", name: "小K", provider: "kimi", status: "idle", max_concurrent_tasks: 1, runtime_id: null, created_at: "x" },
  ]),
  createIssue: vi.fn(async () => ({})),
  updateIssue: vi.fn(),
  rerunIssue: vi.fn(),
  getGuidance: vi.fn(async () => ({ found: false })),
  listRepositories: vi.fn(async () => []),
  getIssueSource: vi.fn(async () => null),
  apiErrorText: (error: Error) => error.message,
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

afterEach(cleanup);

describe("BoardPage", () => {
  it("新建 Issue 选择绑定仓库时只发送 repository_id，不沿用自由路径", async () => {
    vi.mocked(api.listRepositories).mockResolvedValueOnce([{ id: "r1", full_name: "owner/repo", mode: "github_pr", target_branch: "main" } as any]);
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await screen.findByText("修 bug"); fireEvent.click(screen.getByText("新建 Issue"));
    fireEvent.change(screen.getByPlaceholderText(/目标仓库/), { target: { value: "D:/old-path" } });
    await screen.findByRole("option", { name: /owner\/repo/ });
    fireEvent.change(screen.getByLabelText("绑定仓库"), { target: { value: "r1" } });
    fireEvent.change(screen.getByPlaceholderText("输入任务标题..."), { target: { value: "已绑定任务" } });
    fireEvent.click(screen.getByText("创建任务"));
    await waitFor(() => expect(api.createIssue).toHaveBeenCalledWith(expect.objectContaining({ title: "已绑定任务", repository_id: "r1" })));
    const body = vi.mocked(api.createIssue).mock.calls.at(-1)![0]; expect(body).not.toHaveProperty("repo_path");
  });
  it("renders issue in its status column with agent name", async () => {
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    expect(screen.getByText("小K")).toBeTruthy();
    expect(screen.getByText("待办")).toBeTruthy();
    expect(screen.getByText("执行中")).toBeTruthy();
  });

  it("create modal has acceptance field", async () => {
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    fireEvent.click(screen.getByText("新建 Issue"));
    expect(screen.getByPlaceholderText(/验收标准/)).toBeTruthy();
  });

  it("create modal shows recent repo chips; clicking one fills the repo_path input", async () => {
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    fireEvent.click(screen.getByText("新建 Issue"));
    const chip = await screen.findByRole("button", { name: "https://github.com/u/r.git" });
    expect(screen.getByRole("button", { name: "D:/projects/foo" })).toBeTruthy();
    fireEvent.click(chip);
    expect((screen.getByPlaceholderText(/目标仓库/) as HTMLInputElement).value).toBe("https://github.com/u/r.git");
  });

  it("double-clicking 创建任务 only sends one createIssue request", async () => {
    vi.mocked(api.createIssue).mockClear();
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    fireEvent.click(screen.getByText("新建 Issue"));
    fireEvent.change(screen.getByPlaceholderText("输入任务标题..."), { target: { value: "新任务" } });
    const btn = screen.getByText("创建任务");
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(api.createIssue).toHaveBeenCalledTimes(1));
  });

  it("shows guidance preview below repo input when ANVIL.md found", async () => {
    vi.mocked(api.getGuidance).mockClear();
    vi.mocked(api.getGuidance).mockResolvedValue({ found: true, content: "改完跑 pnpm test", truncated: false });
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    fireEvent.click(screen.getByText("新建 Issue"));
    fireEvent.change(screen.getByPlaceholderText(/目标仓库/), { target: { value: "D:/x" } });
    await waitFor(() => expect(screen.getByText("将随任务注入")).toBeTruthy());
    expect(api.getGuidance).toHaveBeenCalledWith("D:/x");
    expect(screen.getByText(/改完跑 pnpm test/)).toBeTruthy();
    // 清空仓库输入后预览消失
    fireEvent.change(screen.getByPlaceholderText(/目标仓库/), { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText("将随任务注入")).toBeNull());
  });

  it("shows no guidance preview when ANVIL.md not found", async () => {
    vi.mocked(api.getGuidance).mockClear();
    vi.mocked(api.getGuidance).mockResolvedValue({ found: false });
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    fireEvent.click(screen.getByText("新建 Issue"));
    fireEvent.change(screen.getByPlaceholderText(/目标仓库/), { target: { value: "D:/x" } });
    await waitFor(() => expect(api.getGuidance).toHaveBeenCalledWith("D:/x"));
    expect(screen.queryByText("将随任务注入")).toBeNull();
  });
});
