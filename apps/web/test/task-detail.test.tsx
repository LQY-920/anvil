import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TaskDetailPage from "../src/pages/TaskDetailPage.js";

vi.mock("../src/api.js", () => ({
  getTask: vi.fn(async () => ({
    task: { id: "t1", issue_id: "i1", status: "running", agent_id: "a1" },
    issue: { id: "i1", title: "修 bug", status: "in_progress", description: "详细描述" },
  })),
  getTaskMessages: vi.fn(async () => [
    { seq: 0, type: "text", tool: null, content: "开始干活", input_json: null, output: null },
    { seq: 1, type: "tool_use", tool: "Bash", content: null, input_json: '{"command":"ls"}', output: null },
  ]),
  getIssueDetail: vi.fn(async () => ({ issue: { id: "i1", title: "修 bug" }, comments: [{ id: "c1", author_type: "member", author_id: "u", type: "comment", body: "加油", created_at: "x" }] })),
  cancelTask: vi.fn(),
  addComment: vi.fn(),
  rerunIssue: vi.fn(),
  getTaskDiff: vi.fn(async () => { throw new Error("GET /api/tasks/t1/diff → 404"); }),
  mergeTask: vi.fn(),
}));

vi.mock("../src/ws.js", () => ({ useServerEvents: vi.fn() }));

describe("TaskDetailPage", () => {
  it("renders issue info, transcript and comments", async () => {
    render(
      <MemoryRouter initialEntries={["/tasks/t1"]}>
        <Routes><Route path="/tasks/:id" element={<TaskDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("修 bug")).toBeTruthy());
    expect(screen.getByText("开始干活")).toBeTruthy();
    expect(screen.getByText(/Bash/)).toBeTruthy();
    expect(screen.getByText("加油")).toBeTruthy();
  });
});
