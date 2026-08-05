import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BoardPage from "../src/pages/BoardPage.js";

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
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  rerunIssue: vi.fn(),
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

afterEach(cleanup);

describe("BoardPage", () => {
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
});
