import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BoardPage from "../src/pages/BoardPage.js";

vi.mock("../src/api.js", () => ({
  bootstrap: vi.fn(async () => ({
    workspace: { id: "ws1", name: "Default", slug: "default" },
    user: { id: "u1", name: "Owner" },
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

describe("BoardPage", () => {
  it("renders issue in its status column with agent name", async () => {
    render(<MemoryRouter><BoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    expect(screen.getByText("小K")).toBeTruthy();
    expect(screen.getByText("待办")).toBeTruthy();
    expect(screen.getByText("▶ 执行中")).toBeTruthy();
  });
});
